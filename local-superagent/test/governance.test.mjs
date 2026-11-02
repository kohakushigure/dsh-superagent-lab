import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, cleanup } from '../testkit/helpers.mjs';

test('auth: POST /api/triggers is 401 without token and 200 with it', async () => {
  const { engine, dir } = await makeEngine('auth', { panel: { authToken: 's3cret' }, retention: { days: 0 } });
  try {
    const { url } = await engine.start({ port: 0 });
    const body = JSON.stringify({ text: '@superagent auth probe', thread: 'auth/1' });
    const anon = await fetch(url + '/api/triggers', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(anon.status, 401);
    const wrong = await fetch(url + '/api/triggers', { method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-token': 'nope' }, body });
    assert.equal(wrong.status, 401);
    const ok = await fetch(url + '/api/triggers', { method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-token': 's3cret' }, body });
    assert.equal(ok.status, 200);
    const bearer = await fetch(url + '/api/triggers', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer s3cret' }, body: JSON.stringify({ text: '@superagent bearer probe', thread: 'auth/2' }) });
    assert.equal(bearer.status, 200);
    // 读接口不受影响（面板仍能刷）
    const st = await fetch(url + '/api/state');
    assert.equal(st.status, 200);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('auth: no token configured keeps the local-only default (write allowed)', async () => {
  const { engine, dir } = await makeEngine('auth-open', { retention: { days: 0 } });
  try {
    const { url } = await engine.start({ port: 0 });
    const res = await fetch(url + '/api/triggers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '@superagent open probe', thread: 'open/1' }) });
    assert.equal(res.status, 200);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('retention: prunes old terminal triggers and logs, keeps tasks and live triggers', async () => {
  const { engine, dir } = await makeEngine('retention', { retention: { days: 7 } });
  try {
    const now = Date.now();
    const old = now - 30 * 86400000;
    // 一条老的已终结触发 + 一条老的待处理触发 + 一条老事件
    engine.repo.run("INSERT INTO triggers (id, source, thread_id, author, text, status, created_at) VALUES ('t-old','cli','r/1','u','x','dropped',?)", old);
    engine.repo.run("INSERT INTO triggers (id, source, thread_id, author, text, status, created_at) VALUES ('t-live','cli','r/2','u','y','batched',?)", old);
    engine.repo.run("INSERT INTO events (kind, actor, ts) VALUES ('old_event','system',?)", old);
    const before = engine.repo.get('SELECT COUNT(*) AS n FROM triggers').n;
    const out = engine.repo.pruneBefore(now - 7 * 86400000);
    const after = engine.repo.get('SELECT COUNT(*) AS n FROM triggers').n;
    assert.equal(out.triggers >= 1, true, 'old terminal trigger should be pruned');
    assert.equal(after, before - out.triggers);
    assert.equal(engine.repo.get("SELECT COUNT(*) AS n FROM triggers WHERE id = 't-live'").n, 1, 'live trigger must survive');
    assert.equal(out.events >= 1, true);
    assert.equal(engine.repo.get('SELECT COUNT(*) AS n FROM events WHERE kind = \'old_event\'').n, 0);
    // 任务表不受影响
    assert.equal(typeof engine.repo.get('SELECT COUNT(*) AS n FROM tasks').n, 'number');
  } finally {
    await engine.close();
    cleanup(dir);
  }
});