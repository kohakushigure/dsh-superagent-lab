import { cleanDir, loadCopy, makeEngine, checker, sleep } from './lib.mjs';

/**
 * CASE O (informational) — worker.active bookkeeping observations.
 * After the N1/N2 fix these must report still_present = false:
 *   N1 the superseded run must no longer unregister its successor: isActive stays true,
 *      active.attempt === 2 and a manual abort() still reaches the replacement run.
 *   N2 a failed run must not leave its active entry behind.
 */
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('O', 'worker.active bookkeeping observations (informational, not a gate)');
const observe = (name, observed, expectedByDesign, finding) =>
  T.check(name, true, { observed, expectedByDesign, finding, still_present: observed !== expectedByDesign });

// ---- N2: a failing run must clean up its entry ----------------------------
const a = await makeEngine(ctx, dir, 'p8-bookkeeping-a', { worker: { shellProbe: false } });
const ea = a.engine;
ea.llm.chat = async (req) => {
  const comp = (req.meta && req.meta.component) || '';
  if (comp === 'worker') throw new Error('injected provider failure');
  throw new Error('unexpected router call in this fixture');
};
ea.repo.createTask({ id: 'task_n2', title: 'N2 fixture', status: 'queued', origin: 'router', threadId: 'thread_n2' });
const n2Result = await ea.worker.run('task_n2');
await sleep(30);
const activeAfterFailure = ea.worker.isActive('task_n2');
const statusAfterFailure = ea.repo.getTask('task_n2').status;
observe('N2 observed: active entry after a failed run', activeAfterFailure, false, 'N2');
T.eq('N2 control: the run really failed', [statusAfterFailure, n2Result.status], ['failed', 'failed']);
await ea.stop(); try { ea.repo.close(); } catch {}

// ---- N1: the superseded run must not unregister its successor ------------
const b = await makeEngine(ctx, dir, 'p8-bookkeeping-b', {
  watchdog: { intervalMs: 80, stallMs: 250, autoRestart: true },
  worker: { maxAttempts: 2, shellProbe: false }
});
const eb = b.engine;
const pending = [];
let calls = 0;
const origChat = eb.llm.chat.bind(eb.llm);
eb.llm.chat = (req) => {
  const comp = (req.meta && req.meta.component) || '';
  if (comp !== 'worker') return origChat(req);
  const idx = calls++;
  return new Promise((resolve) => pending.push({ idx, resolve }));
};
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(40); } return null; };
await eb.submit({ text: '@superagent 实现 记账 观察 演练', source: 'cli', threadId: 'thread_n1', author: 'jo' });
const tk = await eb.tick({ force: true });
const taskId = tk.taskId;
await waitFor(() => eb.repo.getTask(taskId).status === 'running', 2000);
eb.watchdog.start();
const restarted = await waitFor(() => eb.repo.all("SELECT * FROM events WHERE kind = 'watchdog_restart'")[0], 6000);
eb.watchdog.stop();
T.check('N1 control: the watchdog really restarted the attempt', Boolean(restarted), { restarted: Boolean(restarted) });
T.eq('N1 control: before the old run resumes, attempt 2 owns the active entry', eb.worker.isActive(taskId), true);

const release = (idx, summary) => {
  const it = pending.find((p) => p.idx === idx && !p.done);
  if (!it) return;
  it.done = true;
  it.resolve({ text: JSON.stringify({ final: { summary, deliverable: null } }), provider: 'injected', model: 'injected', latencyMs: 1, usage: null });
};
release(0, 'OLD');
await waitFor(() => eb.repo.all("SELECT * FROM events WHERE kind = 'worker_superseded'")[0], 4000);
const taskNow = eb.repo.getTask(taskId);
const entryNow = eb.worker.active.get(taskId);
observe('N1 observed: isActive() still true after the old run was superseded', eb.worker.isActive(taskId), true, 'N1');
observe('N1 observed: the surviving entry still belongs to attempt 2', entryNow && entryNow.attempt, 2, 'N1');
const abortAfterClobber = eb.worker.abort(taskId, 'probe:after-supersede');
observe('N1 observed: abort() still reaches attempt 2 after the supersede', abortAfterClobber, true, 'N1');
T.eq('N1 control: attempt 2 is the live attempt at that moment', [taskNow.status, taskNow.attempt], ['running', 2]);
const keep = eb.repo.all("SELECT * FROM events WHERE kind = 'active_keep'");
const keepDetail = keep[0] ? JSON.parse(keep[0].detail) : {};
T.eq('N1 control: the stale run logged one active_keep instead of deleting the entry', keep.length, 1);
T.check('N1 control: active_keep owner is attempt 2, caller is attempt 1', /#2#/.test(String(keepDetail.owner)) && /#1#/.test(String(keepDetail.caller)), keepDetail);
await eb.stop(); try { eb.repo.close(); } catch {}

T.finish();
process.exit(process.exitCode || 0);
