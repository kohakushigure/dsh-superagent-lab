import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { Toolbox } from '../src/tools.mjs';
import { makeEngine, cleanup, testCfg, tmpDir } from '../testkit/helpers.mjs';

// 面板支持 listen(0)：让内核分配端口，避免并行跑测试时的 EADDRINUSE（旧实现用随机高位端口会偶发碰撞）

test('H1 POST /api/triggers feeds the resident engine (received counter grows)', async () => {
  const { engine, dir } = await makeEngine('host-ingest', { filter: { batchWindowMs: 0 } });
  try {
    const url = await engine.startPanel(0);
    assert.equal(engine.router.counters.received, 0);
    const res = await fetch(url + '/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '@superagent 写一份 ingest 说明', source: 'http', thread: 'h1/t1', author: 'alice' })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.triggerId, 'the endpoint returns a trigger id');
    assert.equal(engine.router.counters.received, 1, 'the SAME engine received it, no CLI process involved');
    await engine.drain();
    assert.equal(engine.repo.getTask(body.taskId).status, 'done');

    const blank = await fetch(url + '/api/triggers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(blank.status, 400);

    const noMention = await fetch(url + '/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'implement a hosting probe', source: 'http', thread: 'h1/t2' })
    });
    const nm = await noMention.json();
    assert.equal(nm.decision, 'dropped', 'the default accept regex still governs ingestion');
    assert.match(nm.reason, /no-mention/);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('H2 MAX_CONCURRENCY caps simultaneous workers and drains the queue', async () => {
  const { engine, dir } = await makeEngine('host-cap', { worker: { maxConcurrency: 2, shellProbe: false }, filter: { batchMax: 1 } });
  try {
    // worker turns are slow (200ms), router decisions are fast (1ms): that keeps the queue full
    engine.llm.chat = async (req) => {
      const component = (req.meta && req.meta.component) || 'worker';
      const isWorker = component === 'worker';
      const delay = isWorker ? 200 : 1;
      await new Promise((r) => setTimeout(r, delay));
      const answer = isWorker
        ? { final: { summary: 'ok', deliverable: null } }
        : { action: 'dispatch', confidence: 0.9, reason: 'test double', title: '并发测试工单' };
      return { text: JSON.stringify(answer), provider: 'mock', model: 'mock', latencyMs: delay, usage: null };
    };
    const orig = engine.worker.run.bind(engine.worker);
    let cur = 0;
    let peak = 0;
    engine.worker.run = async (id) => {
      cur += 1;
      peak = Math.max(peak, cur);
      try { return await orig(id); } finally { cur -= 1; }
    };
    for (let i = 0; i < 10; i += 1) {
      await engine.submit({ source: 'slack', author: 'alice', threadId: 'cap/' + i, text: '@superagent 生成第 ' + i + ' 份交付物' });
      await engine.tick({ force: true });
    }
    const pendingNow = engine.router.inflight.size + engine.router.queue.length;
    assert.equal(pendingNow, 10, 'all ten tasks are either running or queued');
    assert.ok(engine.router.inflight.size <= 2, 'never more than the cap in flight');
    assert.ok(engine.router.queue.length >= 8, 'the rest waits in the queue');
    await engine.drain();
    assert.ok(peak <= 2, 'peak concurrency was ' + peak);
    const tasks = engine.repo.listTasks(20);
    assert.equal(tasks.filter((t) => t.status === 'done').length, 10);
    assert.equal(engine.router.queue.length, 0);
    assert.equal(engine.router.inflight.size, 0);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('H3 PROJECTS binds a thread prefix to a real project dir and blocks cross-project writes', async () => {
  const dir = tmpDir('host-proj');
  const projA = path.join(dir, 'projA');
  const projB = path.join(dir, 'projB');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });
  const cfg = testCfg(dir, { projects: { 'pa/': projA, 'pb/': projB }, filter: { batchWindowMs: 0 } });
  const engine = await Engine.create({ cfg, echo: false });
  try {
    await engine.submit({ source: 'slack', author: 'alice', threadId: 'pa/t1', text: '@superagent 给 A 项目写交付物' });
    const tick = await engine.tick({ force: true });
    await engine.drain();
    const taskA = engine.repo.getTask(tick.taskId);
    assert.equal(taskA.project, 'pa/');
    assert.equal(path.resolve(taskA.workdir), path.resolve(projA), 'the worker ran inside project A');
    assert.ok(taskA.deliverable.startsWith(path.join(projA, 'agent-out')), 'project deliverables live under agent-out/');
    assert.ok(fs.existsSync(taskA.deliverable));
    assert.equal(fs.existsSync(path.join(projB, 'agent-out')), false, 'project B untouched');

    const boxA = new Toolbox({ workdir: projA, cfg, clock: () => Date.now() });
    const escape = await boxA.call('fs.write', { path: '../projB/pwn.md', content: 'x' });
    assert.equal(escape.ok, false);
    assert.equal(escape.denied, true, 'a project-A sandbox cannot write into project B');
    assert.equal(fs.existsSync(path.join(projB, 'pwn.md')), false);
    const absEscape = await boxA.call('fs.write', { path: projB + '/pwn2.md', content: 'x' });
    assert.equal(absEscape.denied, true);

    await engine.submit({ source: 'slack', author: 'alice', threadId: 'other/t1', text: '@superagent 写一份普通交付物' });
    const tick2 = await engine.tick({ force: true });
    await engine.drain();
    const taskB = engine.repo.getTask(tick2.taskId);
    assert.equal(taskB.project, null, 'unmatched thread keeps the default behaviour');
    assert.ok(path.resolve(taskB.workdir).startsWith(path.resolve(cfg.workRoot)), 'default tasks stay under .work');
  } finally {
    await engine.close();
    cleanup(dir);
  }
});
test('D1 different threads never merge into one decision (no cross-project bleed)', async () => {
  const dir = tmpDir('host-group');
  const blog = path.join(dir, 'demo-blog');
  const guest = path.join(dir, 'demo-guest');
  fs.mkdirSync(blog, { recursive: true });
  fs.mkdirSync(guest, { recursive: true });
  const cfg = testCfg(dir, {
    projects: { 'demo-blog/': blog, 'demo-guest/': guest },
    filter: { batchWindowMs: 60000, batchMax: 8 },
    worker: { shellProbe: false }
  });
  const engine = await Engine.create({ cfg, echo: false });
  try {
    const threads = [];
    for (let i = 1; i <= 8; i += 1) {
      const threadId = (i % 2 === 1 ? 'demo-blog/issue-' : 'demo-guest/issue-') + i;
      threads.push(threadId);
      await engine.submit({ source: 'slack', author: 'alice', threadId, text: '@superagent 处理 ' + threadId });
    }
    const tick = await engine.tick({ force: true });
    await engine.drain();
    assert.ok(tick.decisions >= 2, 'one decision per thread, got ' + tick.decisions);
    assert.equal(tick.decisions, 8, 'eight distinct threads -> eight decisions');
    const tasks = engine.repo.listTasks(20);
    assert.equal(tasks.length, 8);
    for (const task of tasks) {
      const expected = task.thread_id.startsWith('demo-blog/') ? 'demo-blog/' : 'demo-guest/';
      assert.equal(task.project, expected, 'task project matches its thread prefix');
      assert.ok(!task.intent.includes('issue-' + (task.thread_id.includes('blog') ? '2' : '1')), 'intent carries only same-thread events');
      const intentThreads = (task.intent.match(/demo-(blog|guest)\/issue-\d+/g) || []);
      assert.ok(intentThreads.every((t) => t === task.thread_id), 'intent mixes threads: ' + JSON.stringify(intentThreads));
    }
    assert.ok(tasks.some((t) => t.deliverable && t.deliverable.startsWith(path.join(blog, 'agent-out'))));
    assert.ok(tasks.some((t) => t.deliverable && t.deliverable.startsWith(path.join(guest, 'agent-out'))));
    assert.ok(tasks.every((t) => t.deliverable && fs.existsSync(t.deliverable)), 'every project deliverable exists on disk');
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('D1 regression: six events on ONE thread still merge into a single decision', async () => {
  const { engine, dir } = await makeEngine('host-same-thread', { filter: { batchWindowMs: 60000, batchMax: 8 }, worker: { shellProbe: false } });
  try {
    for (let i = 0; i < 6; i += 1) {
      await engine.submit({ source: 'slack', author: 'alice', threadId: 'one/thread', text: '@superagent 同一线程第 ' + i + ' 条' });
    }
    const tick = await engine.tick({ force: true });
    await engine.drain();
    assert.equal(tick.decisions, 1, 'same-thread batching must stay intact');
    assert.equal(tick.batchSize, 6);
    assert.equal(engine.repo.listDecisions(5).length, 1);
    const tasks = engine.repo.listTasks(5);
    assert.equal(tasks.length, 1);
    assert.equal(JSON.parse(engine.repo.listDecisions(5)[0].trigger_ids).length, 6);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});
test('D2 project hosting gives every task its own deliverable file (no overwrite)', async () => {
  const dir = tmpDir('host-out');
  const proj = path.join(dir, 'same-project');
  fs.mkdirSync(proj, { recursive: true });
  const cfg = testCfg(dir, { projects: { 'same/': proj }, filter: { batchWindowMs: 0 }, worker: { shellProbe: false, maxConcurrency: 4 } });
  const engine = await Engine.create({ cfg, echo: false });
  try {
    await engine.submit({ source: 'slack', author: 'alice', threadId: 'same/a', text: '@superagent 任务A：写甲交付物' });
    const t1 = await engine.tick({ force: true });
    await engine.submit({ source: 'slack', author: 'alice', threadId: 'same/b', text: '@superagent 任务B：写乙交付物' });
    const t2 = await engine.tick({ force: true });
    await engine.drain();
    const a = engine.repo.getTask(t1.taskId);
    const b = engine.repo.getTask(t2.taskId);
    assert.notEqual(a.deliverable, b.deliverable, 'two tasks never share one file');
    assert.ok(a.deliverable.endsWith(path.join('agent-out', a.id + '.md')));
    assert.ok(fs.existsSync(a.deliverable) && fs.existsSync(b.deliverable));
    const ca = fs.readFileSync(a.deliverable, 'utf8');
    const cb = fs.readFileSync(b.deliverable, 'utf8');
    assert.notEqual(ca, cb, 'contents differ, neither file was overwritten');
    assert.match(ca, /甲|A/);
    assert.match(cb, /乙|B/);
    assert.equal(fs.existsSync(path.join(proj, 'deliverable.md')), false, 'project mode no longer drops a shared deliverable.md');
  } finally {
    await engine.close();
    cleanup(dir);
  }
});
