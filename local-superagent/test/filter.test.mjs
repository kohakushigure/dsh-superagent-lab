import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, cleanup } from '../testkit/helpers.mjs';

const base = { source: 'slack', author: 'alice' };

test('fast path: deterministic drops without any model call', async () => {
  const { engine, dir } = await makeEngine('filter-fast', {
    filter: { allowlist: ['alice'], groups: ['team-a'], acceptRegexSource: '#work' }
  });
  try {
    const noMention = await engine.submit({ ...base, text: 'hello there', threadId: 't1', groupId: 'team-a' });
    assert.equal(noMention.decision, 'dropped');
    assert.match(noMention.reason, /no-mention/);

    const wrongGroup = await engine.submit({ ...base, text: '#work do it', threadId: 't2', groupId: 'team-b' });
    assert.match(wrongGroup.reason, /group-not-allowed/);

    const wrongAuthor = await engine.submit({ source: 'slack', author: 'mallory', text: '#work do it', threadId: 't3', groupId: 'team-a' });
    assert.match(wrongAuthor.reason, /author-not-allowed/);

    const wrongSource = await engine.submit({ source: 'twitter', author: 'alice', text: '#work do it', threadId: 't4', groupId: 'team-a' });
    assert.match(wrongSource.reason, /source-not-allowed/);

    const self = await engine.submit({ source: 'slack', author: 'superagent', text: '#work echo', threadId: 't5', groupId: 'team-a' });
    assert.match(self.reason, /self-message/);

    const dupA = await engine.submit({ ...base, text: '#work write docs', threadId: 't6', groupId: 'team-a', dedupeKey: 'k1' });
    assert.equal(dupA.decision, 'batched');
    const dupB = await engine.submit({ ...base, text: '#work write docs', threadId: 't6', groupId: 'team-a', dedupeKey: 'k1' });
    assert.match(dupB.reason, /duplicate-of/);

    assert.equal(engine.filter.counters.slowCalls, 0, 'no model call during the whole fast path');
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('fast path: token bucket rate limit', async () => {
  const { engine, dir } = await makeEngine('filter-rate', { filter: { ratePerMin: 3, acceptRegexSource: 'go' } });
  try {
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await engine.submit({ ...base, text: 'go task ' + i, threadId: 'r' + i }));
    }
    assert.deepEqual(results.map((r) => r.decision), ['batched', 'batched', 'batched', 'dropped', 'dropped']);
    assert.match(results[3].reason, /rate-limited/);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('slow path: one model call decides dispatch / ignore / need_human', async () => {
  const { engine, dir } = await makeEngine('filter-slow');
  try {
    await engine.submit({ source: 'slack', author: 'alice', text: '@superagent 写一份 README 草稿', threadId: 's1' });
    const d1 = await engine.tick({ force: true });
    assert.equal(d1.action, 'dispatch');
    assert.equal(d1.batchSize, 1);
    await engine.drain();

    await engine.submit({ source: 'slack', author: 'alice', text: '@superagent 今天天气不错哈哈，随便聊聊', threadId: 's2' });
    const d2 = await engine.tick({ force: true });
    assert.equal(d2.action, 'ignore');

    await engine.submit({ source: 'slack', author: 'alice', text: '@superagent 删除生产库并轮换密钥', threadId: 's3' });
    const d3 = await engine.tick({ force: true });
    assert.equal(d3.action, 'need_human');
    assert.equal(engine.repo.pendingHumanDecisions().length, 1);

    const rows = engine.repo.listDecisions(10);
    assert.deepEqual(rows.map((r) => r.action).sort(), ['dispatch', 'ignore', 'need_human']);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('batch window merges several triggers into a single decision', async () => {
  const { engine, dir } = await makeEngine('filter-batch', { filter: { batchMax: 8, batchWindowMs: 60000 } });
  try {
    for (let i = 0; i < 3; i += 1) {
      await engine.submit({ source: 'slack', author: 'alice', text: '@superagent 生成文档第 ' + i + ' 部分', threadId: 'b0' });
    }
    const forced = await engine.tick({ force: true });
    assert.equal(forced.decisions, 1, 'one decision for the whole window');
    assert.equal(forced.batchSize, 3);
    await engine.drain();
    const decisions = engine.repo.listDecisions(5);
    assert.equal(decisions.length, 1);
    assert.equal(JSON.parse(decisions[0].trigger_ids).length, 3);
    // a full window flushes without force
    for (let i = 0; i < 8; i += 1) {
      await engine.submit({ source: 'slack', author: 'alice', text: '@superagent 批量任务 ' + i, threadId: 'c0' });
    }
    const auto = await engine.tick({});
    assert.equal(auto.batchSize, 8, 'batchMax forces a flush');
    await engine.drain();
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('slow path failure escalates instead of dropping the work', async () => {
  const { engine, dir } = await makeEngine('filter-llmfail');
  try {
    engine.llm.cfg.apiKey = 'sk-test';
    engine.llm.fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    await engine.submit({ source: 'slack', author: 'alice', text: '@superagent 处理这个请求', threadId: 'e1' });
    const d = await engine.tick({ force: true });
    assert.equal(d.action, 'need_human');
    assert.ok(engine.repo.countEvents('llm_error', 0) >= 1);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});
