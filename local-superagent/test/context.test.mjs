import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, Repo } from '../src/db.mjs';
import { ContextStore } from '../src/context.mjs';
import { testCfg, tmpDir, cleanup } from '../testkit/helpers.mjs';
import { memoryLogger } from '../src/log.mjs';

function makeCtx(dir, threshold) {
  const cfg = testCfg(dir, { context: { spillThreshold: threshold || 400 } });
  const repo = new Repo(openDb(path.join(dir, 'ctx.sqlite')));
  const ctx = new ContextStore({ repo, cfg, logger: memoryLogger() });
  return { repo, ctx, cfg };
}

test('short messages stay inline', async () => {
  const dir = tmpDir('ctx-inline');
  try {
    const { repo, ctx } = makeCtx(dir);
    const r = ctx.appendMessage({ sessionId: 's1', role: 'user', content: 'short note' });
    assert.equal(r.spilled, false);
    const view = ctx.inline('s1');
    assert.match(view.text, /short note/);
    assert.equal(view.spilled, 0);
    repo.close();
  } finally {
    cleanup(dir);
  }
});

test('a large payload spills to disk and the context keeps only a summary + resume handle', async () => {
  const dir = tmpDir('ctx-spill');
  try {
    const { repo, ctx } = makeCtx(dir, 400);
    const payload = ('line ' + '-'.repeat(60) + '\n').repeat(120) + 'TAIL-MARKER';
    assert.ok(payload.length > 4000);
    const r = ctx.appendMessage({ sessionId: 's2', role: 'tool', content: payload });
    assert.equal(r.spilled, true);
    assert.ok(fs.existsSync(r.blobPath));
    assert.equal(fs.readFileSync(r.blobPath, 'utf8'), payload);
    const view = ctx.inline('s2');
    assert.ok(view.chars < payload.length / 4, 'inline context is a fraction of the payload');
    assert.match(view.text, /续读 hop/);
    assert.equal(ctx.readSpill(r.id), payload, 'the resume handle returns identical bytes');
    assert.equal(ctx.readSpill(r.id).endsWith('TAIL-MARKER'), true);
    assert.equal(ctx.stats().spills, 1);
    repo.close();
  } finally {
    cleanup(dir);
  }
});

test('bounded inline window keeps the newest messages and drops old ones', async () => {
  const dir = tmpDir('ctx-window');
  try {
    const { repo, ctx } = makeCtx(dir, 400);
    for (let i = 0; i < 40; i += 1) ctx.appendMessage({ sessionId: 's3', role: 'user', content: 'message ' + i });
    const view = ctx.inline('s3', { limit: 5 });
    assert.match(view.text, /message 39/);
    assert.doesNotMatch(view.text, /message 30/);
    repo.close();
  } finally {
    cleanup(dir);
  }
});

test('chained recall walks message -> thread -> session -> task', async () => {
  const dir = tmpDir('ctx-recall');
  try {
    const { repo, ctx } = makeCtx(dir, 400);
    repo.upsertThread({ id: 'th1', source: 'slack', groupId: 'g', title: 'thread one', now: Date.now() });
    repo.createSession({ id: 'sess1', role: 'worker', taskId: 'task1', threadId: 'th1', model: 'mock' });
    repo.createTask({ id: 'task1', title: 'recalled task', intent: 'do it', status: 'done', sessionId: 'sess1', threadId: 'th1', workdir: dir, triggerIds: [] });
    ctx.link('thread', 'th1', 'session', 'sess1');
    ctx.link('session', 'sess1', 'task', 'task1');

    const big = 'X'.repeat(2000) + 'END';
    const r = ctx.appendMessage({ sessionId: 'sess1', threadId: 'th1', role: 'tool', content: big });
    const chain = ctx.recall('message', r.id, { depth: 4 });
    assert.deepEqual(chain.map((n) => n.kind), ['message', 'thread', 'session', 'task']);
    assert.equal(chain[0].id, r.id);
    assert.equal(chain[0].spilled, true);
    assert.equal(chain[1].id, 'th1');
    assert.equal(chain[2].id, 'sess1');
    assert.equal(chain[3].id, 'task1');
    assert.equal(chain[3].status, 'done');
    assert.equal(ctx.readSpill(chain[0].id).length, big.length);

    const sessionOnly = ctx.recall('session', 'sess1', { depth: 3 });
    assert.deepEqual(sessionOnly.map((n) => n.kind), ['session', 'task']);
    repo.close();
  } finally {
    cleanup(dir);
  }
});
