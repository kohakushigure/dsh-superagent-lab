import fs from 'node:fs';
import path from 'node:path';
import { cleanDir, loadCopy, checker, startResident, startStub, getJson, postJson, openReadOnly, waitFor, sleep } from './hlib.mjs';

/**
 * H3 — project isolation.
 * PROJECTS maps thread prefixes to real project directories; a task must only write inside
 * its own project, the sibling project's files must stay byte-identical, and an explicit
 * escape attempt must be refused by the path guard (denied counter + tool_denied event).
 */
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('H3', 'PROJECTS isolation: each task writes only its own project, escapes are denied');

const projRoot = path.resolve(dir, '..', 'hosted-projects');
const manifestPath = path.join(projRoot, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const A = manifest.tenants.find((t) => t.id === 'proj-a');
const B = manifest.tenants.find((t) => t.id === 'proj-b');
const projectsEnv = 'proj-a/=' + A.path + ';proj-b/=' + B.path;
const sha = (p) => (fs.existsSync(p) ? require('node:crypto') : null);

async function runMock() {
  const res = await startResident({
    copyDir: dir, name: 'h3a',
    env: { PROJECTS: projectsEnv, MAX_CONCURRENCY: '1', BATCH_MAX: '1', BATCH_WINDOW_MS: '0' }
  });
  try {
    const beforeA = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(A.canaryPath)).digest('hex');
    const beforeB = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(B.canaryPath)).digest('hex');

    await postJson(res.url + '/api/triggers', { text: '@superagent H3 在 A 项目里产出交付物', thread: 'proj-a/t1', author: 'qa-h3' });
    await postJson(res.url + '/api/triggers', { text: '@superagent H3 在 B 项目里产出交付物', thread: 'proj-b/t1', author: 'qa-h3' });
    await postJson(res.url + '/api/triggers', { text: '@superagent H3 没有项目前缀的线程', thread: 'other/t1', author: 'qa-h3' });

    const db = openReadOnly(ctx, res.dbPath);
    const done = await waitFor(() => {
      const rows = db.repo.all('SELECT id, status, project, workdir, deliverable, thread_id FROM tasks ORDER BY created_at');
      return rows.length >= 3 && rows.every((r) => r.status === 'done') ? rows : null;
    }, 20000);
    T.check('three tasks finished', Boolean(done), { tasks: done && done.map((t) => ({ project: t.project, status: t.status })) });
    const rows = done || db.repo.all('SELECT * FROM tasks ORDER BY created_at');
    const taskA = rows.find((t) => t.thread_id === 'proj-a/t1');
    const taskB = rows.find((t) => t.thread_id === 'proj-b/t1');
    const taskOther = rows.find((t) => t.thread_id === 'other/t1');

    T.eq('project prefix is recorded on the task (A)', taskA && taskA.project, 'proj-a/');
    T.eq('project prefix is recorded on the task (B)', taskB && taskB.project, 'proj-b/');
    T.eq('a thread with no prefix keeps project = null', taskOther && taskOther.project, null);
    T.eq('A task works inside project A', taskA && path.resolve(taskA.workdir), path.resolve(A.path));
    T.eq('B task works inside project B', taskB && path.resolve(taskB.workdir), path.resolve(B.path));
    T.check('no-prefix task falls back to .work/<taskId>', taskOther && taskOther.workdir.includes(path.join('.work', taskOther.id)), { workdir: taskOther && taskOther.workdir });

    T.check('A deliverable lives in project A', taskA && taskA.deliverable && path.resolve(taskA.deliverable).startsWith(path.resolve(A.path) + path.sep), { deliverable: taskA && taskA.deliverable });
    T.check('B deliverable lives in project B', taskB && taskB.deliverable && path.resolve(taskB.deliverable).startsWith(path.resolve(B.path) + path.sep), { deliverable: taskB && taskB.deliverable });
    db.close();

    const crypto = await import('node:crypto');
    const afterA = crypto.createHash('sha256').update(fs.readFileSync(A.canaryPath)).digest('hex');
    const afterB = crypto.createHash('sha256').update(fs.readFileSync(B.canaryPath)).digest('hex');
    T.eq('project A canary is untouched', afterA, beforeA);
    T.eq('project B canary is untouched', afterB, beforeB);
    T.check('no A-owned file appeared inside B', !fs.existsSync(path.join(B.path, 'A-CANARY-ONLY-DO-NOT-TOUCH')));
    T.check('each project only gained its own deliverable', fs.existsSync(path.join(A.path, 'deliverable.md')) && fs.existsSync(path.join(B.path, 'deliverable.md')), {
      a: fs.existsSync(path.join(A.path, 'deliverable.md')), b: fs.existsSync(path.join(B.path, 'deliverable.md'))
    });
  } finally { await res.stop(); }
}

async function runEscape() {
  const escapeFile = path.join(B.path, 'pwn.txt');
  if (fs.existsSync(escapeFile)) fs.rmSync(escapeFile, { force: true });
  const payloads = [
    JSON.stringify({ thought: 'try to escape', tool: 'fs.write', args: { path: '..\\proj-b\\pwn.txt', content: 'ESCAPED' } }),
    JSON.stringify({ thought: 'give up', final: { summary: 'escape denied', deliverable: null } })
  ];
  const stub = await startStub({ workerDelayMs: 0, workerPayloads: payloads });
  const res = await startResident({
    copyDir: dir, name: 'h3b',
    env: {
      PROJECTS: projectsEnv, MAX_CONCURRENCY: '1', BATCH_MAX: '1', BATCH_WINDOW_MS: '0',
      OPENAI_API_KEY: 'stub-key', OPENAI_BASE_URL: stub.url, MODEL_ROUTER: 'r-model', MODEL_WORKER: 'w-model'
    }
  });
  try {
    await postJson(res.url + '/api/triggers', { text: '@superagent H3 越界写入尝试', thread: 'proj-a/t9', author: 'qa-h3' });
    const db = openReadOnly(ctx, res.dbPath);
    const denied = await waitFor(() => db.repo.all("SELECT * FROM events WHERE kind = 'tool_denied'")[0], 15000);
    const st = await getJson(res.url + '/api/state');
    db.close();
    T.check('the escape attempt produced a tool_denied event', Boolean(denied), { deniedEvent: denied && JSON.parse(denied.detail) });
    T.check('the denial names the whitelist path guard', /inside|workdir|outside|denied/i.test(String(denied && JSON.parse(denied.detail).output || (denied && denied.detail))), {
      detail: denied && JSON.parse(denied.detail)
    });
    T.check('worker.denied counter grew', st.body.metrics.worker.denied >= 1, { denied: st.body.metrics.worker.denied });
    T.eq('no file escaped into project B', fs.existsSync(escapeFile), false);
  } finally { await res.stop(); await stub.close(); }
}

await runMock();
await runEscape();
T.finish();
process.exit(process.exitCode || 0);
