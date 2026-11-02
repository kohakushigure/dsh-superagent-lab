import { spawn } from 'node:child_process';
import path from 'node:path';
import { cleanDir, loadCopy, makeEngine, checker, sleep } from './lib.mjs';

/**
 * CASE G (new, M1) — after an explicit unsubscribe the same Thread must go through the
 * Router again: the next event is batched (not passthrough), a new decision row appears and
 * the bypass counter stops growing. Exercises both entry points (HTTP route and CLI) plus the
 * 400 path.
 */
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('G', 'unsubscribe stops passthrough: the same thread is routed again');

const port = 31000 + (process.pid % 2000);
const { engine, stateDir } = await makeEngine(ctx, dir, 'p7-unsub', { panel: { host: '127.0.0.1', port } });
const repo = engine.repo;
const THREAD = 'thread_unsub';
const ev = (t) => ({ text: t, source: 'cli', threadId: THREAD, author: 'iris' });

// 1) establish a subscription through a normal dispatch
const r1 = await engine.submit(ev('@superagent 实现 解绑 演练 一'));
const t1 = await engine.tick({ force: true });
await engine.drain();
T.eq('setup: first event is batched then dispatched', [r1.decision, t1.action], ['batched', 'dispatch']);
const sub1 = repo.findSubscription(THREAD);
T.eq('setup: one active subscription exists', sub1.length, 1);

// 2) prove passthrough works before unsubscribing
const r2 = await engine.submit(ev('@superagent 再补 一 点'));
await engine.drain();
const bypassAfterPassthrough = engine.metrics().router.passthroughHits;
T.eq('baseline: same thread event is passthrough before unsubscribe', r2.decision, 'passthrough');
T.eq('baseline: bypass counter is 1', bypassAfterPassthrough, 1);
const decisionsBefore = repo.countDecisions();

// 3) unsubscribe through the HTTP route
const { url } = await engine.start({ port });
await sleep(80);
const post = async (p, body) => {
  const res = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const un = await post('/api/unsubscribe', { thread: THREAD });
T.eq('POST /api/unsubscribe {thread} -> 200', un.status, 200);
T.eq('the response reports ok and how many rows were closed', [un.body.ok, un.body.closed >= 1], [true, true]);
T.eq('no active subscription remains for the thread', repo.findSubscription(THREAD).length, 0);
const closedRow = repo.get('SELECT * FROM subscriptions WHERE id = ?', sub1[0].id);
T.eq('the row is kept for audit but marked closed', [closedRow.status, typeof closedRow.closed_at], ['closed', 'number']);
T.check('an unsubscribe event was recorded', repo.all("SELECT * FROM events WHERE kind = 'unsubscribe'").length >= 1, {});

// 4) the next event on that thread must be routed again
const r3 = await engine.submit(ev('@superagent 解绑 之后 的 新 请求'));
T.eq('after unsubscribe the event is batched again (not passthrough)', r3.decision, 'batched');
const t3 = await engine.tick({ force: true });
await engine.drain();
T.eq('the router decided it', t3.action, 'dispatch');
T.eq('router decisions grew by one', repo.countDecisions(), decisionsBefore + 1);
T.eq('the bypass counter did not grow', engine.metrics().router.passthroughHits, bypassAfterPassthrough);
T.eq('the trigger is dispatched, not passthrough', repo.get('SELECT * FROM triggers WHERE id = ?', r3.triggerId).status, 'dispatched');
const newTask = repo.getTask(t3.taskId);
T.eq('the new work is router-originated', newTask.origin, 'router');
const sub2 = repo.findSubscription(THREAD);
T.eq('a fresh subscription was created for the same thread', [sub2.length, sub2[0].session_id !== sub1[0].session_id], [1, true]);
T.eq('the fresh subscription starts with 0 hits', sub2[0].hits, 0);

// 5) the {id} form and the 400 path
const unById = await post('/api/unsubscribe', { id: sub2[0].id });
T.eq('POST /api/unsubscribe {id} -> 200', [unById.status, unById.body.ok], [200, true]);
T.eq('closing by id also removes the active subscription', repo.findSubscription(THREAD).length, 0);
const bad = await post('/api/unsubscribe', {});
T.eq('POST /api/unsubscribe with neither id nor thread -> 400', bad.status, 400);
await engine.close();

// 6) CLI entry point on a fresh thread (separate process, same state dir)
const c2 = await makeEngine(ctx, dir, 'p7-unsub-cli', {});
const THREAD2 = 'thread_cli_unsub';
await c2.engine.submit({ text: '@superagent 实现 CLI 解绑 演练', source: 'cli', threadId: THREAD2, author: 'iris' });
await c2.engine.tick({ force: true });
await c2.engine.drain();
T.eq('CLI setup: subscription exists', c2.engine.repo.findSubscription(THREAD2).length, 1);
await c2.engine.close();

const cli = await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(dir, 'bin', 'superagent.mjs'), 'unsubscribe', THREAD2], {
    env: Object.assign({}, process.env, { SUPERAGENT_STATE_DIR: c2.stateDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  p.stderr.on('data', (d) => { err += d.toString(); });
  p.on('exit', (code) => resolve({ code, out, err }));
});
const db = ctx.openDb(c2.cfg.dbPath, { migrate: false });
const repo2 = new ctx.Repo(db);
T.eq('CLI unsubscribe exits 0', cli.code, 0);
T.check('CLI prints the closed count', /closed \d+ subscription/.test(cli.out), { out: cli.out.trim(), err: cli.err.trim() });
T.eq('CLI left no active subscription behind', repo2.findSubscription(THREAD2).length, 0);
repo2.close();

T.finish();
process.exit(process.exitCode || 0);
