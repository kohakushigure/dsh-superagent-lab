import path from 'node:path';
import crypto from 'node:crypto';
import { newId } from './db.mjs';
import { cleanTitle } from './mock.mjs';
import { projectForThread, projectRule } from './config.mjs';
import { parseThread, formatReport, postIssueComment } from './channel.mjs';

function safeJson(v) { try { return JSON.parse(v); } catch { return {}; } }
import { truncate } from './log.mjs';

export function sha(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

/**
 * Router: resident, cheap, and it only routes.
 *
 *   ingest()  -> fast path -> (subscription passthrough) -> batch queue
 *   tick()    -> one slow-path model call per batch -> dispatch | ignore | need_human
 *
 * The router never runs a tool and never writes a deliverable, it owns the global
 * context (a resident session) and the subscription table.
 */
export class Router {
  constructor(opts) {
    const o = opts || {};
    this.repo = o.repo;
    this.cfg = o.cfg;
    this.llm = o.llm;
    this.filter = o.filter;
    this.ctx = o.ctx;
    this.worker = o.worker;
    this.logger = o.logger;
    this.clock = o.clock || (() => Date.now());
    this.runs = new Set();
    this.inflight = new Set();
    this.queue = [];
    this.cap = this.cfg.worker.maxConcurrency > 0 ? this.cfg.worker.maxConcurrency : Infinity;
    this.routerSessionId = o.routerSessionId || null;
    this.counters = {
      received: 0,
      fastDropped: 0,
      fastPassed: 0,
      passthroughHits: 0,
      decisions: 0,
      dispatched: 0,
      ignored: 0,
      needHuman: 0,
      batches: 0
    };
  }

  async init() {
    this.filter.primeBuckets();
    let sid = this.repo.getControl('router_session_id');
    const existing = sid ? this.repo.getSession(sid) : null;
    if (!existing) {
      sid = newId('rsess');
      this.repo.createSession({ id: sid, role: 'router', model: this.cfg.llm.routerModel, status: 'resident' });
      this.repo.setControl('router_session_id', sid);
      this.repo.event({ kind: 'router_started', actor: 'router', detail: { sessionId: sid } });
    }
    this.routerSessionId = sid;
    if (this.worker) this.worker.routerSessionId = sid;
    return sid;
  }

  /** Entry point for every external event. */
  async ingest(ev) {
    const text = String(ev.text == null ? '' : ev.text);
    if (!text.trim()) throw new Error('empty trigger text');
    const source = ev.source || 'cli';
    const id = newId('trg');
    const threadId = ev.threadId || 'thread_' + id;
    const groupId = ev.groupId || null;
    const author = ev.author || 'user';
    const dedupeKey = ev.dedupeKey || sha(source + '|' + threadId + '|' + text);
    this.repo.upsertThread({
      id: threadId,
      source,
      groupId,
      title: truncate(text.replace(/\s+/g, ' '), 80),
      now: this.clock()
    });
    const trigger = this.repo.insertTrigger({ id, source, groupId, threadId, author, text, dedupeKey, status: 'pending', now: this.clock() });
    this.counters.received += 1;
    this.repo.event({ kind: 'trigger_received', actor: 'ingest', threadId, detail: { triggerId: id, source, author, chars: text.length } });

    const verdict = this.filter.fastPath(trigger);
    if (!verdict.pass) {
      this.repo.setTriggerStatus(id, 'dropped', { reason: verdict.reason });
      this.counters.fastDropped += 1;
      this.repo.event({ kind: 'trigger_dropped', actor: 'filter.fast', threadId, detail: { triggerId: id, reason: verdict.reason, checks: verdict.checks } });
      return { triggerId: id, decision: 'dropped', reason: verdict.reason, checks: verdict.checks };
    }
    this.counters.fastPassed += 1;

    const direct = this.tryPassthrough(trigger);
    if (direct) return direct;

    this.repo.setTriggerStatus(id, 'batched');
    this.repo.event({ kind: 'trigger_batched', actor: 'router', threadId, detail: { triggerId: id } });
    return { triggerId: id, decision: 'batched', threadId };
  }

  /**
   * Subscription passthrough: a thread already owned by a worker session bypasses the
   * batch queue AND the slow-path model call. Observable via counters.passthroughHits,
   * the `passthrough` event, and the absence of a decisions row.
   */
  tryPassthrough(trigger) {
    if (!this.cfg.passthrough.enabled) return null;
    if (!trigger.thread_id) return null;
    const subs = this.repo.findSubscription(trigger.thread_id);
    if (!subs.length) return null;
    const sub = subs[0];
    this.repo.bumpSubscription(sub.id);
    this.counters.passthroughHits += 1;
    const taskId = newId('task');
    const title = '[续] ' + cleanTitle([trigger.text]);
    const resolved = this.workdirFor(trigger.thread_id, taskId);
    this.repo.createTask({
      id: taskId,
      title,
      intent: trigger.text,
      status: 'queued',
      origin: 'passthrough',
      sessionId: sub.session_id,
      threadId: trigger.thread_id,
      project: resolved.project,
      workdir: resolved.workdir,
      triggerIds: [trigger.id],
      now: this.clock()
    });
    this.repo.setTriggerStatus(trigger.id, 'passthrough', { taskId, reason: 'subscription:' + sub.id });
    this.repo.event({
      kind: 'passthrough',
      actor: 'router',
      taskId,
      threadId: trigger.thread_id,
      detail: { subscriptionId: sub.id, sessionId: sub.session_id, triggerId: trigger.id, bypassed: ['batch', 'slow_path'] }
    });
    this.schedule(taskId);
    return { triggerId: trigger.id, decision: 'passthrough', taskId, subscriptionId: sub.id, sessionId: sub.session_id };
  }

  pendingEligible(force) {
    const rows = this.repo.pendingTriggers(200);
    if (!rows.length) return [];
    const now = this.clock();
    let eligible = rows.filter((r) => force || now - r.created_at >= this.cfg.filter.batchWindowMs);
    if (!eligible.length && rows.length >= this.cfg.filter.batchMax) eligible = rows;
    return eligible;
  }

  /**
   * One router iteration. Pending triggers are grouped by thread_id and each group gets
   * its own slow-path decision: same-thread events still batch (token saving), different
   * threads never merge (one eval per thread, matching the official design).
   */
  async tick(opts) {
    const force = Boolean(opts && opts.force);
    const eligible = this.pendingEligible(force);
    if (!eligible.length) return { batches: 0, decisions: 0 };
    const groups = new Map();
    for (const t of eligible) {
      const key = t.thread_id || 'nothread:' + t.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const out = [];
    for (const rows of groups.values()) {
      out.push(await this.decideBatch(rows.slice(0, this.cfg.filter.batchMax)));
    }
    const aggregate = {
      batches: out.length,
      decisions: out.length,
      groups: out.length,
      actions: out.map((r) => r.action),
      taskIds: out.filter((r) => r.taskId).map((r) => r.taskId)
    };
    if (out.length === 1) Object.assign(aggregate, out[0]);
    return aggregate;
  }

  /** One decision for one thread's batch. */
  async decideBatch(batch) {
    const batchId = newId('batch');
    for (const t of batch) this.repo.setTriggerStatus(t.id, 'deciding', { batchId });
    const decision = await this.filter.slowPath({
      triggers: batch,
      batchId,
      globalContext: this.globalContext(),
      llm: this.llm
    });
    const row = this.repo.decide({
      batchId,
      routerSessionId: this.routerSessionId,
      triggerIds: batch.map((t) => t.id),
      action: decision.action,
      policy: 'slow',
      reason: decision.reason,
      latencyMs: decision.latencyMs,
      payload: {
        confidence: decision.confidence,
        title: decision.title,
        provider: decision.provider,
        model: decision.model,
        batchSize: batch.length
      },
      now: this.clock()
    });
    this.counters.decisions += 1;
    this.counters.batches += 1;
    this.ctx.appendMessage({
      sessionId: this.routerSessionId,
      role: 'assistant',
      content: '[decision ' + batchId + '] action=' + decision.action + ' n=' + batch.length + ' conf=' + decision.confidence + ' reason=' + truncate(decision.reason, 200) + ' title=' + truncate(decision.title || '', 120),
      nextHop: { kind: 'session', id: this.routerSessionId }
    });

    if (decision.action === 'dispatch') {
      const taskId = this.dispatch(batch, decision, batchId);
      return { batches: 1, decisions: 1, action: 'dispatch', taskId, decisionId: row.id, batchSize: batch.length, threadId: batch[0].thread_id };
    }
    if (decision.action === 'need_human') {
      this.counters.needHuman += 1;
      for (const t of batch) this.repo.setTriggerStatus(t.id, 'need_human', { batchId, reason: decision.reason });
      this.repo.event({ kind: 'human_decision_required', actor: 'router', threadId: batch[0].thread_id, detail: { decisionId: row.id, batchId, reason: decision.reason, triggers: batch.map((t) => t.id) } });
      this.say({ threadId: batch[0].thread_id, text: '[需要人工确认] ' + truncate(decision.reason, 200) + ' :: ' + truncate(batch[0].text, 200) });
      return { batches: 1, decisions: 1, action: 'need_human', decisionId: row.id, batchSize: batch.length };
    }
    this.counters.ignored += 1;
    for (const t of batch) this.repo.setTriggerStatus(t.id, 'dropped', { batchId, reason: 'slow-path:' + decision.reason });
    return { batches: 1, decisions: 1, action: 'ignore', decisionId: row.id, batchSize: batch.length };
  }

  dispatch(batch, decision, batchId) {
    const taskId = newId('task');
    const sessionId = newId('sess');
    const threadId = batch[0].thread_id;
    const title = decision.title || cleanTitle(batch.map((t) => t.text));
    const intent = batch.map((t) => t.text).join('\n---\n');
    const resolved = this.workdirFor(threadId, taskId);
    const workdir = resolved.workdir;
    this.repo.createTask({
      id: taskId,
      title,
      project: resolved.project,
      intent,
      status: 'queued',
      origin: 'router',
      sessionId,
      threadId,
      workdir,
      triggerIds: batch.map((t) => t.id),
      now: this.clock()
    });
    this.repo.createSession({ id: sessionId, role: 'worker', taskId, threadId, model: this.cfg.llm.workerModel, status: 'active' });
    this.ctx.link('session', sessionId, 'task', taskId, 'session.task');
    if (threadId) {
      this.ctx.link('thread', threadId, 'session', sessionId, 'thread.session');
      this.repo.setThreadSession(threadId, sessionId);
      this.repo.subscribe({ threadId, taskId, sessionId, workerId: sessionId, now: this.clock() });
    }
    for (const t of batch) this.repo.setTriggerStatus(t.id, 'dispatched', { taskId, batchId, reason: 'dispatch' });
    this.counters.dispatched += 1;
    this.repo.event({ kind: 'task_created', actor: 'router', taskId, threadId, detail: { batchId, sessionId, triggers: batch.map((t) => t.id), title } });
    this.say({ threadId, taskId, text: '[已开工] ' + truncate(title, 120) });
    this.schedule(taskId);
    return taskId;
  }

  /** Only the router writes the outbox: the worker has no channel access at all. */
  say(rec) {
    this.repo.say({ speaker: 'router', threadId: rec.threadId, taskId: rec.taskId, text: rec.text });
    this.repo.event({ kind: 'outbound', actor: 'router', taskId: rec.taskId, threadId: rec.threadId, detail: { text: truncate(rec.text, 200) } });
  }

  /** Queue a task. At most `worker.maxConcurrency` workers run at once; the rest wait. */
  /** Channel 回写：项目规则里配了 channel=github 且 thread 形如 owner/repo#N 时，把结论贴回原对话。 */
  async deliver(taskId, result) {
    const task = this.repo.getTask(taskId);
    if (!task || !task.thread_id) return null;
    const rule = projectRule(this.cfg.projects, task.thread_id);
    if (!rule || rule.channel !== 'github') return null;
    const t = parseThread(task.thread_id);
    if (!t) return null;
    const body = formatReport(task, task.report ? safeJson(task.report) : (result && result.report) || {});
    const dryRun = Boolean(this.cfg.channel && this.cfg.channel.dryRun);
    const res = await postIssueComment({ repo: t.repo, number: t.number, body, dryRun });
    this.repo.event({ kind: res.ok ? 'channel_posted' : 'channel_failed', actor: 'router', taskId, threadId: task.thread_id, detail: { dryRun, output: res.output } });
    return res;
  }

  schedule(taskId) {
    if (this.inflight.size >= this.cap) {
      this.queue.push(taskId);
      this.repo.event({
        kind: 'task_queued',
        actor: 'router',
        taskId,
        detail: { queued: this.queue.length, inflight: this.inflight.size, cap: Number.isFinite(this.cap) ? this.cap : 'unlimited' }
      });
      return Promise.resolve({ taskId, status: 'queued' });
    }
    return this.start(taskId);
  }

  start(taskId) {
    this.inflight.add(taskId);
    const p = this.worker.run(taskId).catch((err) => {
      this.repo.updateTask(taskId, { status: 'failed', error: truncate(String(err && err.message), 400) });
      this.repo.event({ kind: 'task_failed', actor: 'worker', taskId, detail: { error: truncate(String(err && err.message), 400) } });
      return { taskId, status: 'failed' };
    });
    this.runs.add(p);
    p.then(() => {
      this.inflight.delete(taskId);
      this.runs.delete(p);
      this.pump();
    });
    return p;
  }

  /** Fill freed worker slots from the queue. */
  pump() {
    while (this.queue.length && this.inflight.size < this.cap) {
      const next = this.queue.shift();
      this.repo.event({ kind: 'task_dequeued', actor: 'router', taskId: next, detail: { inflight: this.inflight.size, queued: this.queue.length } });
      this.start(next);
    }
  }

  /** Project-aware work directory: PROJECTS hit -> the real project dir, else .work/<taskId>. */
  workdirFor(threadId, taskId) {
    const rule = projectRule(this.cfg.projects, threadId);
    if (!rule) return { workdir: path.join(this.cfg.workRoot, taskId), project: null };
    return { workdir: path.resolve(rule.dir), project: rule.prefix };
  }

  /** Bounded global context: recent decisions + live tasks + subscription table. */
  globalContext() {
    const inline = this.ctx.inline(this.routerSessionId, { limit: 10, budget: 2200 }).text;
    const tasks = this.repo.listTasks(6).map((t) => '- ' + t.id + ' [' + t.status + '] ' + truncate(t.title, 80)).join('\n');
    const subs = this.repo.listSubscriptions(6).map((s) => '- thread ' + s.thread_id + ' -> session ' + (s.session_id || '-') + ' (' + s.status + ', hits=' + s.hits + ')').join('\n');
    return truncate([
      'RECENT ROUTER DECISIONS:',
      inline || '(none)',
      'TASKS:',
      tasks || '(none)',
      'SUBSCRIPTIONS:',
      subs || '(none)'
    ].join('\n'), 4000);
  }

  async drain() {
    while (this.runs.size || this.queue.length) {
      this.pump();
      if (!this.runs.size) break;
      await Promise.allSettled([...this.runs]);
    }
  }

  stats() {
    return {
      ...this.counters,
      decisionsInDb: this.repo.countDecisions(),
      inflight: this.inflight.size,
      queued: this.queue.length,
      concurrencyCap: Number.isFinite(this.cap) ? this.cap : 'unlimited',
      routerSessionId: this.routerSessionId
    };
  }
}