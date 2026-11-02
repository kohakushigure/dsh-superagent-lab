import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, cleanup } from '../testkit/helpers.mjs';

const ev = (threadId, text) => ({ source: 'slack', author: 'alice', threadId, text });

test('subscription passthrough bypasses the router (no new decision)', async () => {
  const { engine, dir } = await makeEngine('pass-on');
  try {
    await engine.submit(ev('th1', '@superagent 写 README 草稿'));
    const first = await engine.tick({ force: true });
    assert.equal(first.action, 'dispatch');
    await engine.drain();
    const sub = engine.repo.findSubscription('th1')[0];
    assert.ok(sub, 'dispatch must create a thread subscription');

    const decisionsBefore = engine.repo.countDecisions();
    const second = await engine.submit(ev('th1', '@superagent 再补一节安装说明'));
    assert.equal(second.decision, 'passthrough');
    await engine.drain();

    assert.equal(engine.repo.countDecisions(), decisionsBefore, 'passthrough must not create a decision');
    assert.equal(engine.router.counters.passthroughHits, 1);
    assert.equal(engine.repo.findSubscription('th1')[0].hits, 1);
    const passthroughEvents = engine.repo.all("SELECT * FROM events WHERE kind = 'passthrough'");
    assert.equal(passthroughEvents.length, 1);
    const detail = JSON.parse(passthroughEvents[0].detail);
    assert.deepEqual(detail.bypassed, ['batch', 'slow_path']);
    assert.equal(engine.repo.getTask(second.taskId).session_id, sub.session_id, 'follow-up shares the worker session');
    assert.equal(engine.repo.getTask(second.taskId).status, 'done');
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('without passthrough the same event goes through the router again', async () => {
  const { engine, dir } = await makeEngine('pass-off', { passthrough: { enabled: false } });
  try {
    await engine.submit(ev('th1', '@superagent 写 README 草稿'));
    const first = await engine.tick({ force: true });
    assert.equal(first.action, 'dispatch');
    await engine.drain();
    assert.ok(engine.repo.findSubscription('th1').length === 1, 'subscription row still exists');

    const decisionsBefore = engine.repo.countDecisions();
    const second = await engine.submit(ev('th1', '@superagent 再补一节安装说明'));
    assert.equal(second.decision, 'batched');
    assert.equal(engine.router.counters.passthroughHits, 0);
    const ticked = await engine.tick({ force: true });
    assert.equal(ticked.decisions, 1);
    assert.equal(engine.repo.countDecisions(), decisionsBefore + 1);
    await engine.drain();
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('ablation: same workload, passthrough on/off changes only the router decision count', async () => {
  async function run(enabled, tag) {
    const { engine, dir } = await makeEngine(tag, { passthrough: { enabled } });
    try {
      for (let i = 0; i < 3; i += 1) {
        await engine.submit(ev('th' + i, '@superagent 生成第 ' + i + ' 份交付物'));
        await engine.tick({ force: true });
        await engine.drain();
        await engine.submit(ev('th' + i, '@superagent 追加第 ' + i + ' 份的验收标准'));
        await engine.tick({ force: true });
        await engine.drain();
      }
      const m = engine.metrics();
      return { decisions: m.router.decisions, bypass: m.router.passthroughHits, tasks: m.tasks };
    } finally {
      await engine.close();
      cleanup(dir);
    }
  }
  const on = await run(true, 'abl-on');
  const off = await run(false, 'abl-off');
  assert.equal(on.decisions, 3);
  assert.equal(off.decisions, 6);
  assert.equal(on.bypass, 3);
  assert.equal(off.bypass, 0);
  assert.deepEqual(on.tasks, off.tasks, 'the same amount of work is produced either way');
});
