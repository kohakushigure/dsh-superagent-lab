import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { newId } from '../src/db.mjs';
import { testCfg, tmpDir, cleanup } from '../testkit/helpers.mjs';

test('a task in flight when the process dies is recovered and finished', async () => {
  const dir = tmpDir('recovery');
  const cfg = testCfg(dir);
  const taskId = newId('task');
  const sessionId = newId('sess');
  try {
    const first = await Engine.create({ cfg, echo: false });
    first.repo.createTask({
      id: taskId, title: 'in-flight work', intent: '@superagent 生成交付物', status: 'running',
      origin: 'router', sessionId, threadId: 'th-rec', workdir: path.join(cfg.workRoot, taskId), triggerIds: []
    });
    first.repo.createSession({ id: sessionId, role: 'worker', taskId, threadId: 'th-rec', model: 'mock', status: 'active' });
    first.ctx.appendMessage({ sessionId, threadId: 'th-rec', role: 'user', content: 'step 1 already executed before the crash' });
    first.repo.updateTask(taskId, { runs: 1, progress_at: Date.now() });
    await first.close();

    const second = await Engine.create({ cfg, echo: false });
    assert.deepEqual(second.recovered, [taskId], 'in-flight task must be re-queued at init');
    const recoveredEvents = second.repo.all("SELECT * FROM events WHERE kind = 'recovered'");
    assert.equal(recoveredEvents.length, 1);
    assert.equal(JSON.parse(recoveredEvents[0].detail).from, 'running');

    await second.drain();
    const task = second.repo.getTask(taskId);
    assert.equal(task.status, 'done');
    assert.equal(task.attempt, 2, 'recovery bumps the attempt counter');
    assert.ok(task.deliverable && task.deliverable.endsWith('deliverable.md'));
    assert.ok(second.repo.countMessages(sessionId) >= 2, 'the worker session context was reused, not rebuilt');
    await second.close();

    const third = await Engine.create({ cfg, echo: false });
    assert.deepEqual(third.recovered, [], 'a finished task is not recovered again');
    await third.close();
  } finally {
    cleanup(dir);
  }
});

test('a queued task that never started is recovered too', async () => {
  const dir = tmpDir('recovery-queued');
  const cfg = testCfg(dir);
  const taskId = newId('task');
  const sessionId = newId('sess');
  try {
    const first = await Engine.create({ cfg, echo: false });
    first.repo.createTask({
      id: taskId, title: 'queued work', intent: '@superagent 生成交付物', status: 'queued',
      origin: 'router', sessionId, threadId: 'th-q', workdir: path.join(cfg.workRoot, taskId), triggerIds: []
    });
    first.repo.createSession({ id: sessionId, role: 'worker', taskId, threadId: 'th-q', model: 'mock' });
    await first.close();

    const second = await Engine.create({ cfg, echo: false });
    assert.ok(second.recovered.includes(taskId));
    await second.drain();
    assert.equal(second.repo.getTask(taskId).status, 'done');
    await second.close();
  } finally {
    cleanup(dir);
  }
});
