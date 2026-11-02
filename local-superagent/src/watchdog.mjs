import { newId } from './db.mjs';
import { truncate } from './log.mjs';

/**
 * External watchdog: separate loop, own timers, does not trust the router.
 * Three checks per tick: no-progress stall, tool-call loop, repeated model errors.
 * A stuck task is marked `stalled` and either restarted (attempt + 1, fresh run on the
 * same persisted session) or escalated to a human decision in the panel.
 */
export class Watchdog {
  constructor(opts) {
    const o = opts || {};
    this.repo = o.repo;
    this.cfg = o.cfg;
    this.router = o.router;
    this.logger = o.logger;
    this.clock = o.clock || (() => Date.now());
    this.timer = null;
    this.findings = [];
  }

  async tick() {
    const now = this.clock();
    const cfg = this.cfg.watchdog;
    const out = [];
    const tasks = this.repo.listTasks(200, ['running', 'queued', 'stalled']);
    for (const task of tasks) {
      if (task.status === 'queued' && task.runs === 0) continue;
      const sinceProgress = now - (task.progress_at || task.updated_at || 0);
      let finding = null;

      if (task.status === 'running' && sinceProgress > cfg.stallMs) {
        finding = { kind: 'stall', detail: { idleMs: sinceProgress, threshold: cfg.stallMs } };
      }
      if (!finding) finding = this.detectLoop(task, cfg);
      if (!finding) finding = this.detectErrors(task, cfg);
      if (!finding) continue;

      const record = {
        taskId: task.id,
        kind: finding.kind,
        detail: finding.detail,
        attempt: task.attempt,
        action: null
      };
      this.repo.updateTask(task.id, { status: 'stalled', error: 'watchdog:' + finding.kind, progress_at: now });
      this.repo.event({ kind: 'watchdog_stall', actor: 'watchdog', taskId: task.id, threadId: task.thread_id, detail: { kind: finding.kind, ...finding.detail } });

      const canRestart = cfg.autoRestart && task.attempt < this.cfg.worker.maxAttempts;
      if (canRestart) {
        // cancel the still-running attempt first: otherwise two runs would write the same task
        const aborted = this.router && this.router.worker ? this.router.worker.abort(task.id, 'watchdog:' + finding.kind) : false;
        record.aborted = aborted;
        this.repo.updateTask(task.id, { status: 'queued', attempt: task.attempt + 1, progress_at: now, error: null });
        this.repo.event({ kind: 'watchdog_restart', actor: 'watchdog', taskId: task.id, detail: { attempt: task.attempt + 1, kind: finding.kind } });
        record.action = 'restarted';
        if (this.router) this.router.schedule(task.id);
      } else {
        this.repo.updateTask(task.id, { status: 'failed', error: 'watchdog gave up: ' + finding.kind });
        // 放弃的任务不再持有 thread 订阅，避免后续事件被 passthrough 打到一个已经放弃的会话
        this.repo.closeSubscriptionsForTask(task.id);
        const batchId = newId('wd');
        this.repo.decide({
          batchId,
          routerSessionId: this.router ? this.router.routerSessionId : null,
          triggerIds: [],
          action: 'need_human',
          policy: 'watchdog',
          reason: 'watchdog gave up on ' + task.id + ': ' + finding.kind,
          payload: { taskId: task.id, kind: finding.kind, attempts: task.attempt },
          now
        });
        this.repo.event({ kind: 'watchdog_gave_up', actor: 'watchdog', taskId: task.id, detail: { kind: finding.kind, attempts: task.attempt } });
        record.action = 'escalated';
      }
      if (this.logger) this.logger.warn('watchdog.' + record.action, { taskId: task.id, kind: finding.kind, detail: finding.detail });
      out.push(record);
    }
    this.findings = out;
    return { findings: out, checked: tasks.length, at: now };
  }

  /** Same tool + same args repeated N times with no new deliverable = loop. */
  detectLoop(task, cfg) {
    const events = this.repo.eventsForTask(task.id, 40).filter((e) => e.kind === 'tool_call');
    if (events.length < cfg.loopThreshold) return null;
    const counts = new Map();
    for (const e of events) {
      let d = {};
      try { d = JSON.parse(e.detail || '{}'); } catch { d = {}; }
      const key = (d.tool || '?') + ':' + (d.argsHash || '?');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, n] of counts) {
      if (n >= cfg.loopThreshold) return { kind: 'loop', detail: { signature: key, repeats: n, threshold: cfg.loopThreshold } };
    }
    return null;
  }

  detectErrors(task, cfg) {
    const since = task.progress_at || 0;
    const rows = this.repo.eventsForTask(task.id, 60).filter((e) => e.kind === 'llm_error' && e.ts >= since);
    if (rows.length >= cfg.errorThreshold) {
      let last = '';
      try { last = JSON.parse(rows[0].detail || '{}').error || ''; } catch { last = ''; }
      return { kind: 'llm-error', detail: { errors: rows.length, threshold: cfg.errorThreshold, last: truncate(last, 200) } };
    }
    return null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        if (this.logger) this.logger.error('watchdog.tick_failed', { error: String(err && err.message) });
      });
    }, this.cfg.watchdog.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}