import { cleanDir, loadCopy, makeEngine, checker, sleep } from './lib.mjs';

/**
 * CASE C (final round) — watchdog abort path, N1/N3 regression, escalation, loop.
 *
 * C1 abort + supersede + N3  : the abort signal must actually reach the model call, so an
 *                              aborted run settles far below LLM_TIMEOUT_MS. Only attempt 2
 *                              may commit; the old run must not write state or report twice.
 * C4 N1 positive + behaviour : after the supersede, active stays owned by attempt 2 and a
 *                              manual abort() returns true. A manual abort deliberately leaves
 *                              the task "running" until the next watchdog sweep (known behaviour).
 * C2 escalation              : non-cooperative provider (ignores the signal) still escalates.
 * C3 loop                    : three identical tool calls are a loop, not a stall.
 */
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('C', 'watchdog aborts the superseded run, then escalates when attempts run out');

const waitFor = async (fn, ms, step = 40) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step); }
  return null;
};
const FINAL = (s) => ({ text: JSON.stringify({ thought: 'finish', final: { summary: s, deliverable: null } }), provider: 'injected', model: 'injected', latencyMs: 1, usage: null });
/** cooperative provider: hangs forever unless the caller's AbortSignal fires (like fetch) */
const abortableHang = (req) => new Promise((resolve, reject) => {
  const sig = req.signal;
  if (!sig) { reject(new Error('N3: worker did not pass a signal to llm.chat')); return; }
  if (sig.aborted) { reject(Object.assign(new Error('aborted before call'), { name: 'AbortError' })); return; }
  sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
});

// ---------------- C1: abort reaches the model call, old run discarded -------
const c1 = await makeEngine(ctx, dir, 'p3c1-abort', {
  watchdog: { intervalMs: 80, stallMs: 250, autoRestart: true },
  worker: { maxAttempts: 2, shellProbe: false }
});
const e1 = c1.engine;
const repo1 = e1.repo;
let calls1 = 0; let sawSignal = false;
const origChat = e1.llm.chat.bind(e1.llm);
e1.llm.chat = (req) => {
  const comp = (req.meta && req.meta.component) || '';
  if (comp !== 'worker') return origChat(req);
  const idx = calls1++;
  if (req.signal) sawSignal = true;
  if (idx === 0) return abortableHang(req);            // attempt 1: blocks until aborted
  return Promise.resolve(FINAL('NEW-ATTEMPT-2'));       // attempt 2: finishes normally
};

await e1.submit({ text: '@superagent 实现 取消旧执行 演练', source: 'cli', threadId: 'thread_abort', author: 'gina' });
const tick1 = await e1.tick({ force: true });
const taskId = tick1.taskId;
let settledAt = null; let run1Result = null;
const run1Promise = [...e1.router.runs][0];
if (run1Promise) run1Promise.then((r) => { run1Result = r; settledAt = Date.now(); });

T.eq('setup: router dispatched the task', tick1.action, 'dispatch');
await waitFor(() => repo1.getTask(taskId).status === 'running', 2000);
T.eq('setup: attempt 1 is running and blocked on the model', [repo1.getTask(taskId).status, calls1], ['running', 1]);

let abortCalledAt = null;
const origAbort = e1.worker.abort.bind(e1.worker);
e1.worker.abort = (tid, reason) => { if (abortCalledAt === null) abortCalledAt = Date.now(); return origAbort(tid, reason); };
e1.watchdog.start();
const restart = await waitFor(() => repo1.all("SELECT * FROM events WHERE task_id = ? AND kind = 'watchdog_restart'", taskId)[0], 6000);
e1.watchdog.stop();
const abortEv = await waitFor(() => repo1.all("SELECT * FROM events WHERE task_id = ? AND kind = 'worker_abort'", taskId)[0], 1200);
const findings = e1.watchdog.findings || [];
T.check('watchdog restarted the stalled attempt', Boolean(restart), { restartEvent: restart && JSON.parse(restart.detail) });
T.eq('the watchdog aborted the old run before restarting', Boolean(abortEv), true);
T.eq('the abort event names the reason', JSON.parse(abortEv.detail).reason, 'watchdog:stall');
T.eq('the watchdog finding records aborted=true', findings[0] && findings[0].aborted, true);
T.eq('the attempt was bumped to 2', repo1.getTask(taskId).attempt, 2);

// --- N3: the signal must reach the model call, and settle far below 60 s ---
const settled = await waitFor(() => settledAt !== null, 6000);
T.check('N3: the worker passes an AbortSignal to llm.chat', sawSignal, { sawSignal });
T.check('N3: the aborted model call settled (did not wait for the 60 s timeout)', Boolean(settled), { settled: Boolean(settled) });
const settleMs = (settledAt && abortCalledAt) ? settledAt - abortCalledAt : null;
console.log('--- N3 abort -> settle: ' + settleMs + ' ms (LLM_TIMEOUT_MS default ' + e1.cfg.llm.timeoutMs + ' ms) ---');
T.check('N3: abort -> settle is far below LLM_TIMEOUT_MS (probe threshold 2000 ms)', settleMs !== null && settleMs >= 0 && settleMs < 2000, { settleMs, thresholdMs: 2000, llmTimeoutMs: e1.cfg.llm.timeoutMs });

const superseded = await waitFor(() => repo1.all("SELECT * FROM events WHERE task_id = ? AND kind = 'worker_superseded'", taskId)[0], 4000);
const supDetail = superseded ? JSON.parse(superseded.detail) : {};
T.eq('the old run returned status superseded', run1Result && run1Result.status, 'superseded');
T.eq('the superseded event says the run was aborted', supDetail.aborted, true);
T.eq('the superseded event records which checkpoint caught it', supDetail.where, 'error-path');
T.eq('the superseded counter is 1', e1.worker.counters.superseded, 1);
T.check('the OLD summary never reached the task row', repo1.getTask(taskId).summary !== 'OLD-ATTEMPT-1', { summary: repo1.getTask(taskId).summary });

await waitFor(() => repo1.getTask(taskId).status === 'done', 5000);
const task1 = repo1.getTask(taskId);
T.eq('attempt 2 committed the task', [task1.status, task1.attempt], ['done', 2]);
T.eq('the committed summary belongs to attempt 2', task1.summary, 'NEW-ATTEMPT-2');
T.eq('exactly one worker_report was emitted (no double report)', repo1.all("SELECT * FROM events WHERE task_id = ? AND kind = 'worker_report'", taskId).length, 1);
T.eq('exactly one task_done event', repo1.all("SELECT * FROM events WHERE task_id = ? AND kind = 'task_done'", taskId).length, 1);
const keep = repo1.all("SELECT * FROM events WHERE task_id = ? AND kind = 'active_keep'", taskId);
const keepDetail = keep[0] ? JSON.parse(keep[0].detail) : {};
T.eq('the superseded run logged that it did NOT own the entry any more (N1 backstop)', keep.length, 1);
T.check('active_keep names the real owner (attempt 2) and the stale caller (attempt 1)', /#2#/.test(String(keepDetail.owner)) && /#1#/.test(String(keepDetail.caller)), keepDetail);
await e1.stop(); try { repo1.close(); } catch {}

// ---------------- C4: N1 positive + manual-abort known behaviour -----------
const c4 = await makeEngine(ctx, dir, 'p3c4-n1', {
  watchdog: { intervalMs: 80, stallMs: 250, autoRestart: true },
  worker: { maxAttempts: 3, shellProbe: false }
});
const e4 = c4.engine;
const repo4 = e4.repo;
let calls4 = 0;
const origChat4 = e4.llm.chat.bind(e4.llm);
e4.llm.chat = (req) => {
  const comp = (req.meta && req.meta.component) || '';
  if (comp !== 'worker') return origChat4(req);
  const idx = calls4++;
  if (idx === 2) return Promise.resolve(FINAL('ATTEMPT-3'));
  return abortableHang(req);                            // attempts 1 and 2 block
};
await e4.submit({ text: '@superagent 实现 手工取消 演练', source: 'cli', threadId: 'thread_n1', author: 'kai' });
const tick4 = await e4.tick({ force: true });
const taskId4 = tick4.taskId;
await waitFor(() => repo4.getTask(taskId4).status === 'running', 2000);
e4.watchdog.start();
await waitFor(() => repo4.all("SELECT * FROM events WHERE task_id = ? AND kind = 'watchdog_restart'", taskId4)[0], 6000);
await waitFor(() => calls4 >= 2, 3000);

// the symptom of the old N1 bug: abort() returned false right here
const entry4 = e4.worker.active.get(taskId4);
const manualAbort = e4.worker.abort(taskId4, 'probe:manual');
T.eq('N1: after the supersede the active entry still belongs to attempt 2', entry4 && entry4.attempt, 2);
T.eq('N1: a manual abort() reaches the replacement run', manualAbort, true);
T.check('N1: the manual abort is recorded', repo4.all("SELECT * FROM events WHERE task_id = ? AND kind = 'worker_abort'", taskId4).length >= 2, {
  aborts: repo4.all("SELECT * FROM events WHERE task_id = ? AND kind = 'worker_abort'", taskId4).length
});

// known behaviour (not a defect): a manual abort does not re-queue; the task sits in
// "running" until the next watchdog sweep picks it up.
await waitFor(() => repo4.all("SELECT * FROM events WHERE task_id = ? AND kind = 'worker_superseded'", taskId4).length >= 2, 4000);
const stuck = repo4.getTask(taskId4);
T.eq('known behaviour: a manually aborted task stays running until the next sweep', [stuck.status, stuck.attempt], ['running', 2]);

const restarted2 = await waitFor(() => repo4.getTask(taskId4).attempt === 3, 6000);
const done4 = await waitFor(() => repo4.getTask(taskId4).status === 'done', 6000);
e4.watchdog.stop();
const final4 = repo4.getTask(taskId4);
T.check('known behaviour: the next sweep re-queues it (attempt 3)', Boolean(restarted2), { attempt: final4.attempt });
T.eq('the re-queued attempt commits', [final4.status, final4.summary], ['done', 'ATTEMPT-3']);
T.check('the sweep that picked it up recorded a stall finding', repo4.all("SELECT * FROM events WHERE task_id = ? AND kind = 'watchdog_stall'", taskId4).length >= 2, {
  stalls: repo4.all("SELECT * FROM events WHERE task_id = ? AND kind = 'watchdog_stall'", taskId4).length
});
await e4.stop(); try { repo4.close(); } catch {}

// ---------------- C2: non-cooperative provider still escalates -------------
const c2 = await makeEngine(ctx, dir, 'p3c2-escalate', {
  watchdog: { intervalMs: 80, stallMs: 250, autoRestart: true, loopThreshold: 3, errorThreshold: 2 },
  worker: { maxAttempts: 2, shellProbe: false }
});
const e2 = c2.engine;
const repo2 = e2.repo;
let hangs = 0;
const origChat2 = e2.llm.chat.bind(e2.llm);
e2.llm.chat = async (req) => {
  const comp = (req.meta && req.meta.component) || '';
  if (comp === 'worker') { hangs += 1; return new Promise(() => {}); }   // ignores the signal
  return origChat2(req);
};
await e2.submit({ text: '@superagent 实现 watchdog 升级 演练', source: 'cli', threadId: 'thread_wd2', author: 'hank' });
const tick2 = await e2.tick({ force: true });
const taskId2 = tick2.taskId;
await sleep(60);
e2.watchdog.start();
await waitFor(() => repo2.all("SELECT * FROM events WHERE task_id = ? AND kind = 'watchdog_gave_up'", taskId2)[0], 8000);
e2.watchdog.stop();
const evs2 = repo2.all('SELECT * FROM events WHERE task_id = ? ORDER BY id', taskId2);
const byKind2 = (k) => evs2.filter((e) => e.kind === k);
const task2 = repo2.getTask(taskId2);
const wdDecisions = repo2.all("SELECT * FROM decisions WHERE policy = 'watchdog'");
console.log('--- C2 timeline --- ' + JSON.stringify(evs2.filter((e) => String(e.kind).startsWith('watchdog') || e.kind === 'worker_abort' || e.kind === 'worker_superseded').map((e) => ({ kind: e.kind, detail: JSON.parse(e.detail || '{}') }))));
T.check('C2: stall found at least twice', byKind2('watchdog_stall').length >= 2, { stalls: byKind2('watchdog_stall').length });
T.eq('C2: exactly one automatic restart', byKind2('watchdog_restart').length, 1);
T.check('C2: the restart calls abort even for a provider that ignores it', byKind2('worker_abort').length === 1, { aborts: byKind2('worker_abort').length });
T.eq('C2: a non-cooperative provider yields no superseded marker (provider-level caveat)', byKind2('worker_superseded').length, 0);
T.eq('C2: after the second stall it gave up', byKind2('watchdog_gave_up').length, 1);
T.eq('C2: the task ends failed with the watchdog reason', [task2.status, /watchdog gave up: stall/.test(String(task2.error))], ['failed', true]);
T.eq('C2: a need_human decision with policy watchdog exists', [wdDecisions.length, wdDecisions[0] && wdDecisions[0].action, wdDecisions[0] && wdDecisions[0].policy], [1, 'need_human', 'watchdog']);
T.check('C2: that decision is unresolved and visible to a person', repo2.pendingHumanDecisions().some((d) => d.policy === 'watchdog'), { pending: repo2.pendingHumanDecisions().length });
T.check('C2: the worker really was started twice', hangs >= 2, { hangs });
await e2.stop(); try { repo2.close(); } catch {}

// ---------------- C3: loop detection --------------------------------------
const c3 = await makeEngine(ctx, dir, 'p3c3-loop', { watchdog: { intervalMs: 3600000, stallMs: 60000, autoRestart: true, loopThreshold: 3 } });
const repo3 = c3.engine.repo;
repo3.createSession({ id: 'sess_loop_fixture', role: 'worker', model: 'mock', status: 'active' });
repo3.createTask({ id: 'task_loop_fixture', title: 'loop fixture', status: 'running', origin: 'router', sessionId: 'sess_loop_fixture', threadId: 'thread_loop' });
for (let i = 0; i < 3; i += 1) repo3.event({ kind: 'tool_call', actor: 'worker', taskId: 'task_loop_fixture', detail: { tool: 'fs.read', argsHash: 'same', ok: true } });
const wd3 = await c3.engine.watchdog.tick();
const loopFinding = wd3.findings.find((f) => f.taskId === 'task_loop_fixture');
T.check('C3: a repeated identical tool call is a loop, not a stall', loopFinding && loopFinding.kind === 'loop', loopFinding || wd3.findings);
T.eq('C3: loop signature and repeat count recorded', [loopFinding && loopFinding.detail.signature, loopFinding && loopFinding.detail.repeats], ['fs.read:same', 3]);
T.eq('C3: the loop path reports whether it aborted a run', typeof (loopFinding && loopFinding.aborted), 'boolean');
await c3.engine.stop(); try { repo3.close(); } catch {}

T.finish();
process.exit(process.exitCode || 0);
