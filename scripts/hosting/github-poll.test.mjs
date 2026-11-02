import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMentions, toTrigger, nextWatermark, pollOnce, isBotLogin, parseRepo } from './github-poll.mjs';

const c = (id, login, body, number, kind) => ({
  id, body, user: { login }, issueNumber: number, kind: kind || 'issue',
  createdAt: '2026-11-02T10:00:00Z'
});
const repo = { owner: 'acme', name: 'demo' };

test('gh: mention detection is case-insensitive and bot-aware', () => {
  const comments = [
    c(1, 'alice', '@superagent please fix the build', 7),
    c(2, 'bob', 'just a normal comment', 7),
    c(3, 'carol', '@DSH-SuperAgent-Lab take this one', 8),
    c(4, 'dave', 'superagent without at-sign is not a mention', 8)
  ];
  const picked = extractMentions(comments, {});
  assert.deepEqual(picked.map((x) => x.id), [1, 3]);
});

test('gh: self and bot comments are skipped', () => {
  const comments = [
    c(1, 'agent-bot', '@superagent echo', 1),
    c(2, 'dependabot[bot]', '@superagent bump deps', 1),
    c(3, 'ci-bot', '@superagent rerun', 1),
    c(4, 'alice', '@superagent real request', 1)
  ];
  const picked = extractMentions(comments, { self: 'agent-bot', skipBots: ['ci-bot'] });
  assert.deepEqual(picked.map((x) => x.id), [4]);
  assert.equal(isBotLogin('anything[bot]', {}), true);
  assert.equal(isBotLogin('alice', {}), false);
});

test('gh: several comments on one issue share one thread (passthrough friendly)', () => {
  const a = toTrigger(c(11, 'alice', '@superagent 1', 42), repo);
  const b = toTrigger(c(12, 'bob', '@superagent 2', 42), repo);
  assert.equal(a.thread, 'acme/demo#42');
  assert.equal(b.thread, a.thread);
  assert.equal(a.key, 'gh:acme/demo#42:11');
  assert.equal(a.source, 'github');
  assert.equal(a.author, 'alice');
});

test('gh: watermark stops re-emitting the same comment', () => {
  const comments = [c(1, 'alice', '@superagent old', 5), c(2, 'bob', '@superagent newer', 5)];
  const first = extractMentions(comments, {});
  assert.equal(first.length, 2);
  const state = nextWatermark({ issues: {} }, comments, 1000);
  assert.equal(state.issues[5], 2);
  const second = extractMentions(comments, { watermarkFor: (n) => state.issues[n] || 0 });
  assert.equal(second.length, 0, 'nothing is delivered twice');
  assert.deepEqual(nextWatermark(state, [], 2000).issues, state.issues, 'empty poll keeps the watermark');
});

test('gh: pull-request comments and issue comments both count', () => {
  const comments = [c(1, 'alice', '@superagent in an issue', 9, 'issue'), c(2, 'bob', '@superagent in a PR review', 9, 'review')];
  assert.equal(extractMentions(comments, {}).length, 2);
  assert.equal(toTrigger(comments[1], repo).thread, 'acme/demo#9');
});

test('gh: pollOnce normalises the API, honours 304, and counts emitted in dry mode', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/issues?')) {
      return {
        ok: true, status: 200,
        headers: new Map([['etag', 'W/"1"'], ['x-ratelimit-remaining', '57'], ['x-ratelimit-reset', '1800000000']]),
        json: async () => [
          { number: 3, pull_request: { url: 'x' } },
          { number: 4 }
        ]
      };
    }
    if (url.includes('/issues/3/comments')) {
      return { ok: true, status: 200, headers: new Map(), json: async () => [{ id: 100, body: '@superagent from a PR', user: { login: 'alice' }, created_at: '2026-11-02T10:00:00Z' }] };
    }
    if (url.includes('/issues/4/comments')) {
      return { ok: true, status: 200, headers: new Map(), json: async () => [{ id: 101, body: 'no mention here', user: { login: 'bob' }, created_at: '2026-11-02T10:00:00Z' }] };
    }
    throw new Error('unexpected url ' + url);
  };
  const state = { issues: {}, etags: {} };
  const { createClient } = await import('./github-poll.mjs');
  const client = createClient({ fetchImpl, state, log: () => {} });
  const summary = await pollOnce({
    repo, client, state,
    opts: { port: 1, dry: true, sinceMinutes: 0, maxComments: 10, skipBots: [] },
    log: () => {}
  });
  assert.equal(summary.found, 2);
  assert.equal(summary.emitted, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.ratelimit.remaining, 57);
  assert.ok(state.etags[calls[0]], 'etag stored for the conditional next poll');

  const notModified = await pollOnce({
    repo,
    client: { call: async () => ({ notModified: true, rate: { remaining: 1, reset: 1 } }) },
    state, opts: { port: 1, dry: true, sinceMinutes: 0, maxComments: 10 }, log: () => {}
  });
  assert.equal(notModified.emitted, 0);
  assert.equal(notModified.notModified, true);
});

test('gh: --repo parsing rejects malformed values', () => {
  assert.deepEqual(parseRepo('acme/demo'), { owner: 'acme', name: 'demo' });
  assert.throws(() => parseRepo('acme'), /owner\/name/);
});
