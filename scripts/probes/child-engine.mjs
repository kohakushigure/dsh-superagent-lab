import path from 'node:path';
import { loadCopy, probeCfg } from './lib.mjs';

/**
 * Child harness for CASE B. Two roles:
 *   hold   : start a real engine, let the worker block forever on the LLM call, then idle
 *            (the parent kills this process with SIGKILL while the DB says status=running).
 *   resume : start a real engine on the same state dir with recovery enabled, finish the
 *            recovered task and print a JSON summary.
 */
const dir = process.argv[2];
const role = process.argv[3];
const stateDir = process.argv[4];
const ctx = await loadCopy(dir);

const cfg = probeCfg(ctx, stateDir, {
  worker: { shellProbe: false },
  watchdog: { intervalMs: 3600000 }
});

if (role === 'hold') {
  const engine = await ctx.Engine.create({ cfg, echo: false });
  const origChat = engine.llm.chat.bind(engine.llm);
  engine.llm.chat = async (req) => {
    const comp = (req.meta && req.meta.component) || '';
    if (comp === 'worker') {
      // block forever: this is the crash window the parent kills
      process.stdout.write('WORKER_BLOCKED\n');
      return new Promise(() => {});
    }
    return origChat(req);
  };
  const r = await engine.submit({ text: '@superagent 实现 崩溃恢复 演练', source: 'cli', threadId: 'thread_crash', author: 'frank' });
  const t = await engine.tick({ force: true });
  const task = engine.repo.getTask(t.taskId);
  process.stdout.write('HOLD ' + JSON.stringify({ taskId: t.taskId, action: t.action, status: task.status, sessionId: task.session_id, attempt: task.attempt }) + '\n');
  setInterval(() => {}, 1000);
} else {
  const engine = await ctx.Engine.create({ cfg, echo: false });
  const recovered = engine.recovered.slice();
  process.stdout.write('RECOVERED ' + JSON.stringify(recovered) + '\n');
  engine.resume();
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const rows = engine.repo.inFlightTasks();
    if (!rows.length) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  await engine.router.drain().catch(() => {});
  const tasks = engine.repo.all('SELECT id, status, attempt, session_id, deliverable, error, runs FROM tasks').map((t) => ({
    id: t.id, status: t.status, attempt: t.attempt, sessionId: t.session_id, deliverable: t.deliverable,
    deliverableExists: t.deliverable ? true : false, error: t.error, runs: t.runs
  }));
  const sessions = engine.repo.all('SELECT id, role, task_id, status, summary FROM sessions').map((s) => ({
    id: s.id, role: s.role, taskId: s.task_id, status: s.status,
    messages: engine.repo.countMessages(s.id)
  }));
  const recoveredEvents = engine.repo.all("SELECT * FROM events WHERE kind = 'recovered'").map((e) => ({ taskId: e.task_id, detail: JSON.parse(e.detail || '{}') }));
  const starts = engine.repo.all("SELECT task_id, COUNT(*) AS n FROM events WHERE kind = 'task_start' GROUP BY task_id");
  process.stdout.write('RESUME ' + JSON.stringify({ recovered, tasks, sessions, recoveredEvents, starts }) + '\n');
  await engine.repo.close();
  process.exit(0);
}
