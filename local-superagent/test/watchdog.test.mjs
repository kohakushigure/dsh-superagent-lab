import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { newId } from '../src/db.mjs';
import { makeEngine, cleanup } from '../testkit/helpers.mjs';

function plantTask(engine, opts) {
  const id = newId('task');
  const sessionId = newId('sess');
  engine.repo.createTask({
    id,
    title: opts.title || 'planted',
    intent: '@superagent 生成交付物',
    status: opts.status || 'running',
    origin: 'manual',
    sessionId,
    threadId: opts.threadId || 'wd/th',
    workdir: path.join(engine.cfg.workRoot, id),
    triggerIds: []
  });
  engine.repo.createSession({ id: sessionId, role: 'worker', taskId: id, threadId: 'wd/th', model: 'mock' });
  engine.repo.updateTask(id, { runs: opts.runs === undefined ? 1 : opts.runs, progress_at: opts.progressAt });
  return { id, sessionId };
}

test('watchdog marks a task with no progress as stalled and restarts the worker', async () => {
  const { engine, dir } = await makeEngine('wd-stall', { watchdog: { stallMs: 5000, autoRestart: true } });
  try {
    const { id } = plantTask(engine, { progressAt: Date.now() - 60000 });
    const res = await engine.watchdog.tick();
    const finding = res.findings.find((f) => f.taskId === id);
    assert.ok(finding, 'stall must be detected');
    assert.equal(finding.kind, 'stall');
    assert.equal(finding.action, 'restarted');
    assert.ok(engine.repo.countEvents('watchdog_stall', 0) >= 1);
    assert.ok(engine.repo.countEvents('watchdog_restart', 0) >= 1);
    await engine.drain();
    const task = engine.repo.getTask(id);
    assert.equal(task.status, 'done');
    assert.equal(task.attempt, 2);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('watchdog escalates to a human decision when attempts are exhausted', async () => {
  const { engine, dir } = await makeEngine('wd-giveup', { watchdog: { stallMs: 5000 }, worker: { maxAttempts: 1 } });
  try {
    const { id } = plantTask(engine, { progressAt: Date.now() - 60000 });
    const res = await engine.watchdog.tick();
    const finding = res.findings.find((f) => f.taskId === id);
    assert.equal(finding.action, 'escalated');
    assert.equal(engine.repo.getTask(id).status, 'failed');
    const pending = engine.repo.pendingHumanDecisions();
    assert.equal(pending.length, 1);
    assert.match(pending[0].reason, /watchdog gave up/);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('watchdog detects a repeated tool call loop', async () => {
  const { engine, dir } = await makeEngine('wd-loop', { watchdog: { loopThreshold: 3, autoRestart: false } });
  try {
    const { id } = plantTask(engine, { progressAt: Date.now() - 1000 });
    for (let i = 0; i < 3; i += 1) {
      engine.repo.event({ kind: 'tool_call', actor: 'worker', taskId: id, detail: { step: i, tool: 'fs.read', argsHash: 'same', ok: true } });
    }
    const res = await engine.watchdog.tick();
    const finding = res.findings.find((f) => f.taskId === id);
    assert.equal(finding.kind, 'loop');
    assert.equal(finding.detail.repeats, 3);
    assert.equal(engine.repo.getTask(id).status, 'failed');
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('watchdog detects repeated model interface errors', async () => {
  const { engine, dir } = await makeEngine('wd-llm', { watchdog: { errorThreshold: 2, autoRestart: false } });
  try {
    const { id } = plantTask(engine, { progressAt: Date.now() - 500 });
    engine.repo.event({ kind: 'llm_error', actor: 'worker', taskId: id, detail: { error: 'HTTP 503' } });
    engine.repo.event({ kind: 'llm_error', actor: 'worker', taskId: id, detail: { error: 'HTTP 503' } });
    const res = await engine.watchdog.tick();
    const finding = res.findings.find((f) => f.taskId === id);
    assert.equal(finding.kind, 'llm-error');
    assert.equal(finding.detail.errors, 2);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('watchdog restart aborts the in-flight model call and keeps the new attempt abortable', async () => {
  const { engine, dir } = await makeEngine('wd-supersede', {
    watchdog: { stallMs: 1000, autoRestart: true },
    worker: { maxAttempts: 3 }
  });
  try {
    const { id } = plantTask(engine, { progressAt: Date.now() - 5000, runs: 1 });
    let calls = 0;
    // injectable slow model: call #1 would pin the run for 4s, #2 finishes in 1.2s; both honour abort
    engine.llm.chat = (req) => new Promise((resolve, reject) => {
      calls += 1;
      const tag = calls === 1 ? 'OLD' : 'NEW';
      const delay = calls === 1 ? 4000 : 1200;
      const timer = setTimeout(() => resolve({
        text: JSON.stringify({ final: { summary: tag + ' run result', deliverable: null } }),
        provider: 'mock', model: 'mock', latencyMs: delay, usage: null
      }), delay);
      if (req.signal) {
        req.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      }
    });
    const t0 = Date.now();
    const oldRun = engine.worker.run(id);
    await new Promise((r) => setTimeout(r, 60));
    engine.repo.updateTask(id, { progress_at: Date.now() - 5000 });
    const ticks = await engine.watchdog.tick();
    const finding = ticks.findings.find((f) => f.taskId === id);
    assert.equal(finding.action, 'restarted');
    assert.equal(finding.aborted, true, 'watchdog must cancel the running attempt before restarting');

    const oldResult = await oldRun;
    const oldElapsed = Date.now() - t0;
    assert.equal(oldResult.status, 'superseded');
    assert.ok(oldElapsed < 1500, 'the abort must end the run immediately instead of waiting the 4s model delay, took ' + oldElapsed + 'ms');

    // N1: a superseded run must not unregister the successor's entry
    assert.equal(engine.worker.isActive(id), true, 'the new attempt keeps its abort handle');
    assert.equal(engine.worker.active.get(id).attempt, 2);

    await engine.drain();
    const task = engine.repo.getTask(id);
    assert.equal(task.status, 'done');
    assert.match(task.summary, /NEW/, 'only the new attempt owns the task state');
    assert.ok(engine.repo.countEvents('worker_abort', 0) >= 1);
    assert.ok(engine.repo.countEvents('worker_superseded', 0) >= 1);
    assert.equal(engine.worker.isActive(id), false, 'no run is left registered after the task finishes');
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('watchdog leaves a healthy running task alone', async () => {
  const { engine, dir } = await makeEngine('wd-healthy', { watchdog: { stallMs: 60000 } });
  try {
    const { id } = plantTask(engine, { progressAt: Date.now() });
    const res = await engine.watchdog.tick();
    assert.equal(res.findings.length, 0);
    assert.equal(engine.repo.getTask(id).status, 'running');
  } finally {
    await engine.close();
    cleanup(dir);
  }
});