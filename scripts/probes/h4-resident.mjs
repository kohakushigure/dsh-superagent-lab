import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { cleanDir, loadCopy, checker, startStub, getJson, postJson, openReadOnly, freePort, waitFor, sleep } from './hlib.mjs';

/**
 * H4 — resident survival via the delivered scripts/hosting/start-hosted.ps1.
 * starts detached -> serves -> survives a hard kill -> recovers the in-flight task on restart
 * -> -Stop releases the port. Runs against the real project tree (the script resolves
 * <repo>/local-superagent itself) but keeps state and logs inside verify-out.
 */
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('H4', 'hosted resident survives a hard kill, recovers work, and releases the port');

const proj = path.resolve(dir, '..', '..');
const starter = path.join(proj, 'scripts', 'hosting', 'start-hosted.ps1');
const port = await freePort();
const stateDir = path.join(dir, '..', 'h4-state');
const logDir = path.join(dir, '..', 'h4-logs');
fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
const dbPath = path.join(stateDir, 'superagent.sqlite');
const pidFile = path.join(logDir, 'hosted-' + port + '.pid');

function portListening(p) {
  return new Promise((resolve) => {
    const s = net.connect({ port: p, host: '127.0.0.1' });
    s.setTimeout(700);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

function runPs(args, env) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', starter].concat(args), {
      env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('exit', (code) => resolve({ code, out, err }));
  });
}

const stub = await startStub({ workerDelayMs: 2500 });
const env = {
  SUPERAGENT_STATE_DIR: stateDir,
  BATCH_MAX: '1', BATCH_WINDOW_MS: '0', MAX_CONCURRENCY: '2',
  OPENAI_API_KEY: 'stub-key', OPENAI_BASE_URL: stub.url, MODEL_ROUTER: 'r-model', MODEL_WORKER: 'w-model'
};

try {
  const first = await runPs(['-Port', String(port), '-LogDir', logDir], env);
  console.log('--- start-hosted #1 ---\n' + first.out.trim());
  T.eq('start-hosted.ps1 exits 0 on first start', first.code, 0);
  const health = await getJson('http://127.0.0.1:' + port + '/api/health');
  T.eq('the detached resident answers /api/health', [health.status, health.body.ok], [200, true]);

  const again = await runPs(['-Port', String(port), '-LogDir', logDir], env);
  T.check('start-hosted.ps1 is idempotent (already running)', /already running/i.test(again.out) && again.code === 0, { out: again.out.trim().slice(0, 160) });
  T.eq('state+dbs live inside verify-out, not in local-superagent', fs.existsSync(dbPath), true);
  const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
  T.check('a pid file was written for the hosted process', Number.isFinite(pid) && pid > 0, { pid });

  await postJson('http://127.0.0.1:' + port + '/api/triggers', { text: '@superagent H4 崩溃恢复 演练', thread: 'h4/t1', author: 'qa-h4' });
  const db = openReadOnly(ctx, dbPath);
  const running = await waitFor(() => {
    const t = db.repo.all('SELECT id, status, attempt, session_id FROM tasks');
    return t.length && t[0].status === 'running' ? t[0] : null;
  }, 12000);
  T.check('a task really reached status=running before the kill', Boolean(running), running);
  db.close();

  const killed = spawn('taskkill.exe', ['/F', '/PID', String(pid)]);
  await new Promise((r) => killed.on('exit', r));
  const gone = await waitFor(async () => (await portListening(port)) === false, 8000);
  T.check('the hard kill closed the port (process is really gone)', Boolean(gone), { port, stillListening: await portListening(port) });

  const db2 = openReadOnly(ctx, dbPath);
  const stale = db2.repo.getTask(running.id);
  T.eq('the crash left the task in running (no graceful shutdown path)', stale.status, 'running');
  db2.close();

  const restart = await runPs(['-Port', String(port), '-LogDir', logDir], env);
  console.log('--- start-hosted #2 ---\n' + restart.out.trim());
  T.eq('the resident restarts on the same port', restart.code, 0);
  const db3 = openReadOnly(ctx, dbPath);
  const recovered = await waitFor(() => {
    const t = db3.repo.getTask(running.id);
    return t.status === 'done' ? t : null;
  }, 25000);
  const recEvent = db3.repo.all("SELECT * FROM events WHERE kind = 'recovered'");
  db3.close();
  T.check('the in-flight task was recovered and finished', Boolean(recovered), recovered && { status: recovered.status, attempt: recovered.attempt });
  T.eq('recovery bumped the attempt', recovered && recovered.attempt, 2);
  T.eq('the same worker session was reused', recovered && recovered.session_id, running.session_id);
  T.check('a recovered event was recorded with the pre-crash status', recEvent.length >= 1 && JSON.parse(recEvent[0].detail).from === 'running', {
    events: recEvent.length, detail: recEvent[0] && JSON.parse(recEvent[0].detail)
  });

  const stopped = await runPs(['-Port', String(port), '-LogDir', logDir, '-Stop'], env);
  console.log('--- start-hosted -Stop ---\n' + stopped.out.trim());
  T.eq('start-hosted -Stop exits 0', stopped.code, 0);
  const freed = await waitFor(async () => (await portListening(port)) === false, 10000);
  T.check('after -Stop the port is free again', Boolean(freed), { port });
  T.check('-Stop reports the port as free', /free/i.test(stopped.out), { out: stopped.out.trim().slice(0, 160) });
  T.eq('the pid file was cleaned up', fs.existsSync(pidFile), false);
} finally {
  await stub.close();
  try { await runPs(['-Port', String(port), '-LogDir', logDir, '-Stop'], env); } catch { /* best effort */ }
}
T.finish();
process.exit(process.exitCode || 0);
