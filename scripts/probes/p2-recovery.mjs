import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanDir, loadCopy, tmpState, probeCfg, checker, sleep } from './lib.mjs';

/**
 * CASE B — crash recovery with a REAL process kill.
 * 1. child 'hold' starts an engine, the worker blocks on its model call => task status=running
 * 2. parent SIGKILLs the process (no graceful shutdown, no flush)
 * 3. child 'resume' opens the same state dir with recovery on and must finish the task
 *    on the SAME persisted worker session (context reused, attempt bumped).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('B', 'a task in flight when the process dies is recovered and finished');

const stateDir = tmpState(dir, 'p2-recovery');
const cfg = probeCfg(ctx, stateDir, {});
const childPath = path.join(HERE, 'child-engine.mjs');

function launch(role) {
  const p = spawn(process.execPath, [childPath, dir, role, stateDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.err = '';
  p.stdout.on('data', (d) => { p.out += d.toString(); });
  p.stderr.on('data', (d) => { p.err += d.toString(); });
  return p;
}
function waitLine(p, prefix, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const line = p.out.split(/\r?\n/).find((l) => l.startsWith(prefix));
      if (line) { clearInterval(iv); resolve(line); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('timeout waiting for ' + prefix + ' ; out=' + p.out + ' err=' + p.err)); }
    }, 40);
  });
}

// ---- 1. hold, then wait for a real in-flight task -------------------------
const hold = launch('hold');
const holdLine = JSON.parse((await waitLine(hold, 'HOLD ', 20000)).slice(5));
const dbPath = path.join(stateDir, 'superagent.sqlite');
const db = ctx.openDb(dbPath, { migrate: false });
const repo = new ctx.Repo(db);

let running = null;
const t0 = Date.now();
while (Date.now() - t0 < 8000) {
  const t = repo.getTask(holdLine.taskId);
  if (t && t.status === 'running') { running = t; break; }
  await sleep(30);
}
await waitLine(hold, 'WORKER_BLOCKED', 8000).catch(() => null);

T.check('setup: a real task reached status=running before the kill', Boolean(running), running && { id: running.id, status: running.status, attempt: running.attempt });
const before = {
  taskId: running.id,
  attempt: running.attempt,
  sessionId: running.session_id,
  status: running.status,
  messages: running.session_id ? repo.countMessages(running.session_id) : 0,
  runs: running.runs
};
console.log('--- before kill --- ' + JSON.stringify(before));

// ---- 2. hard kill --------------------------------------------------------
const killed = hold.kill('SIGKILL');
await sleep(400);
let afterKill;
try { afterKill = repo.getTask(before.taskId); } catch (e) { afterKill = null; }
T.check('the kill was delivered (process gone)', killed === true && hold.exitCode !== 0 || hold.signalCode === 'SIGKILL' || hold.killed, { killed, exitCode: hold.exitCode, signal: hold.signalCode });

// re-open read side: WAL means the killed process left durable state
try { db.close(); } catch { /* ignore */ }
const db2 = ctx.openDb(dbPath, { migrate: false });
const repo2 = new ctx.Repo(db2);
const stale = repo2.getTask(before.taskId);
T.eq('the crash left the task stuck in running (no graceful shutdown)', stale.status, 'running');

// ---- 3. resume ----------------------------------------------------------
const resume = launch('resume');
const resumeLine = JSON.parse((await waitLine(resume, 'RESUME ', 30000)).slice(7));
await new Promise((r) => { resume.on('exit', r); setTimeout(r, 3000); });
try { db2.close(); } catch { /* ignore */ }

const task = resumeLine.tasks.find((t) => t.id === before.taskId);
const session = resumeLine.sessions.find((s) => s.id === before.sessionId);
const recEvent = resumeLine.recoveredEvents.find((e) => e.taskId === before.taskId);
const starts = resumeLine.starts.find((s) => s.task_id === before.taskId);
console.log('--- resume --- ' + JSON.stringify({ task, session, recEvent, starts }));
console.log('--- resume stdout --- ' + resumeLine.recovered.join(','));

T.check('the new process reported the task as recovered', resumeLine.recovered.includes(before.taskId), { recovered: resumeLine.recovered });
T.eq('a recovered event records the pre-crash status', recEvent && recEvent.detail.from, 'running');
T.eq('the attempt counter was bumped (recovered, not restarted from zero)', task.attempt, before.attempt + 1);
T.eq('the task finished after the restart', [task.status, task.error], ['done', null]);
T.eq('the same worker session was reused', task.sessionId, before.sessionId);
T.check('the worker context grew inside that reused session', session && session.messages > before.messages, { before: before.messages, after: session && session.messages });
T.check('the worker ran a second time in the fresh process', starts && starts.n >= 2, { taskStartEvents: starts && starts.n });
T.check('the deliverable exists on disk after recovery', Boolean(task.deliverable) && fs.existsSync(task.deliverable), { deliverable: task.deliverable });
T.check('the recovered run is the one that wrote the deliverable', task.runs >= 2, { runs: task.runs });

T.finish();
