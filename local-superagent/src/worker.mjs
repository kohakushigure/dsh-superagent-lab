import fs from 'node:fs';
import path from 'node:path';
import { newId } from './db.mjs';
import { Toolbox, TOOL_SPEC } from './tools.mjs';
import { parseJsonLoose } from './llm.mjs';
import { mockWorkerStep } from './mock.mjs';
import { truncate } from './log.mjs';
import { projectRule } from './config.mjs';

const WORKER_SYSTEM = [
  'You are a worker of a Super-agent. You own exactly one task in one isolated directory.',
  'You cannot talk to the user: everything you produce is reported back to the router.',
  'Answer with STRICT JSON on every turn, one of:',
  '  {"thought":"...","tool":"fs.write","args":{...}}',
  '  {"thought":"...","final":{"summary":"...","deliverable":"relative/path.md"}}',
  'Available tools:',
  TOOL_SPEC.map((t) => '  - ' + t.name + ' ' + JSON.stringify(t.args) + ' :: ' + t.note).join('\n'),
  'Rules: never leave the work directory, prefer small verifiable steps, stop as soon as the',
  'deliverable exists and has been read back.',
  'Hard rules against stalling:',
  '  - Never call the same tool with the same arguments twice. Repeating a successful call gains nothing.',
  '  - One fs.read is enough to see a file; if it was truncated, read a different path or act on what you have.',
  '  - You have a small step budget. After writing the deliverable and reading it back, answer with final.',
  '  - If a tool returns an error twice, change approach instead of retrying.',
  'Accuracy rules:',
  '  - Do not invent commands, file paths, flags or script names. If you did not read it or run it, do not write it.',
  '  - Prefer exact text you have seen in a file; when you summarise, keep the commands verbatim.',
  '  - If the request asks about something the repository does not contain, say so instead of guessing.'
].join('\n');

/**
 * One worker per task. Context lives in the worker session (persisted, therefore resumable),
 * the filesystem lives in .work/<taskId>/, and the tool surface is a whitelist.
 */
export class Worker {
  constructor(opts) {
    const o = opts || {};
    this.repo = o.repo;
    this.cfg = o.cfg;
    this.llm = o.llm;
    this.ctx = o.ctx;
    this.logger = o.logger;
    this.clock = o.clock || (() => Date.now());
    this.routerSessionId = o.routerSessionId;
    this.active = new Map(); // taskId -> { controller, attempt, runId, startedAt }
    this.runSeq = 0;
    this.counters = { runs: 0, steps: 0, toolCalls: 0, denied: 0, failures: 0, superseded: 0 };
  }

  ensureSession(task) {
    if (task.session_id) {
      const existing = this.repo.getSession(task.session_id);
      if (existing) return existing;
    }
    const sessionId = newId('sess');
    const session = this.repo.createSession({
      id: sessionId,
      role: 'worker',
      taskId: task.id,
      threadId: task.thread_id,
      model: this.cfg.llm.workerModel,
      status: 'active'
    });
    this.repo.updateTask(task.id, { session_id: sessionId });
    this.ctx.link('session', sessionId, 'task', task.id, 'session.task');
    if (task.thread_id) {
      this.ctx.link('thread', task.thread_id, 'session', sessionId, 'thread.session');
      this.repo.setThreadSession(task.thread_id, sessionId);
    }
    return session;
  }

  /** Cancel the run currently owning this task (watchdog restart path). */
  abort(taskId, reason) {
    const entry = this.active.get(taskId);
    if (!entry) return false;
    entry.reason = reason || 'aborted';
    entry.controller.abort();
    this.repo.event({ kind: 'worker_abort', actor: 'worker', taskId, detail: { reason: entry.reason, attempt: entry.attempt } });
    return true;
  }

  isActive(taskId) { return this.active.has(taskId); }

  /** Only the run that owns the entry may release it (N1: a superseded run must not unregister its successor). */
  releaseActive(taskId, runId) {
    const entry = this.active.get(taskId);
    if (!entry) return false;
    if (entry.runId !== runId) {
      this.repo.event({ kind: 'active_keep', actor: 'worker', taskId, detail: { owner: entry.runId, caller: runId } });
      return false;
    }
    this.active.delete(taskId);
    return true;
  }

  /** Project hosting gives every task its own file, so parallel tasks in one repo never overwrite. */
  deliverableRel(task) {
    if (task && task.project) {
      const rule = projectRule(this.cfg.projects, task.thread_id);
      const outDir = (rule && rule.outDir) || 'agent-out';
      return path.join(outDir, task.id + '.md');
    }
    return 'deliverable.md';
  }

  /**
   * 读项目自带的 .dsh/skills 下的 SKILL.md 与其 references/*.md，注入 worker。
   * 预算由 cfg.worker.skillBudget 控制（默认 6000 字符），超了按文件顺序截断，
   * 并在被截断处留下 "…[truncated]" 标记——不让模型以为拿到了全文。
   */
  skillsBlock(workdir) {
    const base = path.join(workdir, '.dsh', 'skills');
    if (!fs.existsSync(base)) return '';
    const budget = (this.cfg.worker && this.cfg.worker.skillBudget) || 6000;
    let used = 0;
    const parts = [];
    const take = (label, text) => {
      const left = budget - used;
      if (left <= 0) return;
      const body = text.length > left ? text.slice(0, left) + '\n…[truncated]' : text;
      used += body.length;
      parts.push('--- ' + label + ' ---\n' + body);
    };
    for (const name of fs.readdirSync(base).slice(0, 2)) {
      const dir = path.join(base, name);
      const skill = path.join(dir, 'SKILL.md');
      if (fs.existsSync(skill)) take('SKILL: ' + name, fs.readFileSync(skill, 'utf8'));
      const refs = path.join(dir, 'references');
      if (fs.existsSync(refs)) {
        const files = fs.readdirSync(refs).filter((f) => f.endsWith('.md')).sort();
        for (const f of files) take('REF: ' + name + '/' + f, fs.readFileSync(path.join(refs, f), 'utf8'));
      }
    }
    return parts.join('\n\n');
  }

  async run(taskId) {
    const task0 = this.repo.getTask(taskId);
    if (!task0) throw new Error('task not found: ' + taskId);
    if (task0.status === 'done') return { taskId, status: 'done', skipped: true };
    const runAttempt = task0.attempt;
    const runId = taskId + '#' + runAttempt + '#' + (this.runSeq += 1);
    const controller = new AbortController();
    const signal = controller.signal;
    this.active.set(taskId, { controller, attempt: runAttempt, runId, startedAt: this.clock() });

    const session = this.ensureSession(task0);
    const workdir = task0.workdir || path.join(this.cfg.workRoot, taskId);
    fs.mkdirSync(workdir, { recursive: true });
    const deliverableRel = this.deliverableRel(task0);
    fs.mkdirSync(path.dirname(path.join(workdir, deliverableRel)), { recursive: true });
    this.counters.runs += 1;
    this.repo.updateTask(taskId, {
      status: 'running',
      workdir,
      runs: task0.runs + 1,
      progress_at: this.clock(),
      error: null
    });
    this.repo.event({ kind: 'task_start', actor: 'worker', taskId, threadId: task0.thread_id, detail: { sessionId: session.id, attempt: task0.attempt, workdir } });

    const rule = projectRule(this.cfg.projects, task0.thread_id);
    const toolbox = new Toolbox({ workdir, cfg: this.cfg, clock: this.clock, rule });
    let step = 0;
    let final = null;
    let lastError = null;
    const seen = new Map();   // tool+args -> 次数，用来挡住“同一调用原地打转”
    const history = [];       // 本轮已经做过的调用摘要，进 prompt，避免上下文被截断后模型失忆

    try {
      while (step < this.cfg.worker.maxSteps) {
        if (this.stale(taskId, runAttempt, signal)) return this.finishStale(taskId, runAttempt, signal, 'before-step');
        const contextBlock = this.ctx.inline(session.id, { budget: 5000 });
        const prompt = [
          'TASK: ' + task0.title,
          'TASK_ID: ' + taskId,
          'WORKDIR: ' + workdir,
          'DELIVERABLE: ' + deliverableRel + ' (write it there, then read it back)',
          'REQUEST: ' + truncate(task0.intent || task0.title || '', 1200),
          this.skillsBlock(workdir) ? 'PROJECT SKILLS (follow them; they override your defaults):\n' + this.skillsBlock(workdir) : 'PROJECT SKILLS: (none)',
          rule ? 'PROJECT RULES: outDir=' + (rule.outDir || '(default agent-out)') + '; run allowlist=' + JSON.stringify(rule.run) + '; gh allowlist=' + JSON.stringify(rule.gh) : 'PROJECT RULES: (none)',
          'REPORT FIELDS (use them in final): summary, deliverable, changes[], refs[], ran[], notRun[], blockers[]',
          '',
          'CONTEXT (this worker session only, spilled entries show a resume id):',
          contextBlock.text || '(empty)',
          '',
          history.length ? 'ALREADY DONE THIS RUN (do not repeat):\n' + history.slice(-8).join('\n') : 'ALREADY DONE THIS RUN: (nothing yet)',
          '',
          'STEP ' + (step + 1) + '/' + this.cfg.worker.maxSteps + ' — answer with one JSON action.'
        ].join('\n');
        // 心跳：模型调用可能要几十秒，先把 progress_at 顶一下，避免被 stall 误杀
        this.repo.updateTask(taskId, { progress_at: this.clock() });
        const res = await this.llm.chat({
          model: this.cfg.llm.workerModel,
          json: true,
          signal,
          messages: [
            { role: 'system', content: WORKER_SYSTEM },
            { role: 'user', content: prompt }
          ],
          mock: () => mockWorkerStep({ step, task: task0, deliverableRel, shellProbe: this.cfg.worker.shellProbe, observations: [] }),
          meta: { component: 'worker', taskId, step }
        });
        this.counters.steps += 1;
        if (this.stale(taskId, runAttempt, signal)) return this.finishStale(taskId, runAttempt, signal, 'after-llm');
        const parsed = parseJsonLoose(res.text);
        if (!parsed) {
          this.repo.event({ kind: 'llm_bad_answer', actor: 'worker', taskId, detail: { raw: truncate(res.text, 300) } });
          final = { summary: truncate(res.text, 800) || 'worker returned no parsable action', deliverable: null };
          break;
        }
        if (parsed.final) {
          final = parsed.final;
          break;
        }
        if (!parsed.tool) {
          final = { summary: truncate(JSON.stringify(parsed), 800), deliverable: null };
          break;
        }
        const callKey = parsed.tool + ':' + JSON.stringify(parsed.args || {});
        const times = (seen.get(callKey) || 0) + 1;
        seen.set(callKey, times);
        let out;
        if (times > 1) {
          out = { ok: false, denied: false, output: 'duplicate call blocked: ' + parsed.tool + ' was already called with the same args. Do not repeat it — use the result you already have, or take a different action, or answer with final.' };
          this.repo.event({ kind: 'tool_duplicate', actor: 'worker', taskId, detail: { tool: parsed.tool, times } });
        } else {
          out = await toolbox.call(parsed.tool, parsed.args || {}, { signal });
          this.counters.toolCalls += 1;
          if (out.denied) this.counters.denied += 1;
        }
        history.push('  - ' + parsed.tool + ' ' + JSON.stringify(parsed.args || {}).slice(0, 120) + ' -> ' + (out.ok ? 'ok' : (out.denied ? 'denied' : 'error')));
        this.repo.event({
          kind: out.denied ? 'tool_denied' : 'tool_call',
          actor: 'worker',
          taskId,
          threadId: task0.thread_id,
          detail: {
            step,
            tool: parsed.tool,
            argsHash: hashArgs(parsed.tool, parsed.args),
            ok: out.ok,
            output: truncate(out.output, 220)
          }
        });
        this.ctx.appendMessage({
          sessionId: session.id,
          threadId: task0.thread_id,
          role: 'tool',
          content: '[tool ' + parsed.tool + '] denied=' + Boolean(out.denied) + ' ok=' + out.ok + '\n' + out.output,
          nextHop: { kind: 'session', id: session.id }
        });
        this.repo.updateTask(taskId, { progress_at: this.clock() });
        step += 1;
      }

      if (!final) {
        lastError = 'max-steps (' + this.cfg.worker.maxSteps + ') reached without a final answer';
        this.repo.updateTask(taskId, { status: 'failed', error: lastError, progress_at: this.clock() });
    // 失败的任务不再霸占 thread：关掉它的订阅，后续事件重新走 Router（否则 passthrough 会打到死会话上）
    this.repo.closeSubscriptionsForTask(taskId);
        this.repo.event({ kind: 'task_failed', actor: 'worker', taskId, detail: { reason: 'max-steps', steps: step } });
        this.counters.failures += 1;
        return { taskId, status: 'failed', error: lastError, steps: step, tools: toolbox.stats() };
      }

      if (this.stale(taskId, runAttempt, signal)) return this.finishStale(taskId, runAttempt, signal, 'before-commit');
      let wanted = final.deliverable;
      if (!wanted || (task0.project && wanted === 'deliverable.md')) wanted = deliverableRel;
      const deliverable = this.resolveDeliverable(workdir, wanted);
      this.ctx.appendMessage({
        sessionId: session.id,
        threadId: task0.thread_id,
        role: 'assistant',
        content: 'FINAL: ' + (final.summary || '') + (deliverable ? '\nDELIVERABLE: ' + deliverable : ''),
        nextHop: { kind: 'task', id: taskId }
      });
      this.ctx.link('session', session.id, 'task', taskId, 'session.task');
      this.repo.updateTask(taskId, {
        status: 'done',
        summary: truncate(final.summary || '', 2000),
        deliverable,
        progress_at: this.clock()
      });
      this.repo.updateSession(session.id, { summary: truncate(final.summary || '', 800), status: 'idle' });
      this.repo.event({
        kind: 'task_done',
        actor: 'worker',
        taskId,
        threadId: task0.thread_id,
        detail: { steps: step + 1, deliverable, tools: toolbox.stats(), sessionId: session.id }
      });
      this.reportToRouter(task0, session, final, deliverable);
      return { taskId, status: 'done', steps: step + 1, deliverable, summary: final.summary, tools: toolbox.stats() };
    } catch (err) {
      if (this.stale(taskId, runAttempt, signal)) return this.finishStale(taskId, runAttempt, signal, 'error-path');
      this.counters.failures += 1;
      const msg = String(err && err.message ? err.message : err);
      this.repo.updateTask(taskId, { status: 'failed', error: truncate(msg, 500), progress_at: this.clock() });
      this.repo.closeSubscriptionsForTask(taskId);
      this.repo.event({ kind: 'llm_error', actor: 'worker', taskId, detail: { error: truncate(msg, 400) } });
      this.repo.event({ kind: 'task_failed', actor: 'worker', taskId, detail: { error: truncate(msg, 400) } });
      if (this.logger) this.logger.error('worker.task_failed', { taskId, error: msg });
      return { taskId, status: 'failed', error: msg, steps: step, tools: toolbox.stats() };
    } finally {
      // N2: every exit path releases the entry, but only if this run still owns it (N1)
      this.releaseActive(taskId, runId);
    }
  }

  /** True when this run no longer owns the task (aborted, or a newer attempt took over). */
  stale(taskId, runAttempt, signal) {
    if (signal && signal.aborted) return true;
    const t = this.repo.getTask(taskId);
    return !t || t.attempt !== runAttempt;
  }

  /** Discard every effect of a stale run: no task status, no deliverable, no report. */
  finishStale(taskId, runAttempt, signal, where) {
    this.counters.superseded += 1;
    this.repo.event({
      kind: 'worker_superseded',
      actor: 'worker',
      taskId,
      detail: { attempt: runAttempt, where, aborted: Boolean(signal && signal.aborted) }
    });
    return { taskId, status: 'superseded', attempt: runAttempt, where };
  }

  /** Report is a message to the router session + an event; the worker never writes the outbox. */
  reportToRouter(task, session, final, deliverable) {
    this.repo.event({
      kind: 'worker_report',
      actor: 'worker',
      taskId: task.id,
      threadId: task.thread_id,
      detail: { sessionId: session.id, deliverable, summary: truncate(final.summary || '', 300) }
    });
    if (this.routerSessionId && this.routerSessionId !== session.id) {
      this.ctx.appendMessage({
        sessionId: this.routerSessionId,
        role: 'report',
        content: '[worker report] task=' + task.id + ' status=done deliverable=' + (deliverable || 'none') + ' :: ' + truncate(final.summary || '', 400),
        nextHop: { kind: 'task', id: task.id }
      });
    }
  }

  resolveDeliverable(workdir, rel) {
    if (!rel) return null;
    const abs = path.resolve(workdir, String(rel));
    if (!abs.startsWith(path.resolve(workdir))) return null;
    return fs.existsSync(abs) ? abs : null;
  }
}

export function hashArgs(tool, args) {
  const s = tool + '|' + JSON.stringify(args || {});
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h.toString(36);
}