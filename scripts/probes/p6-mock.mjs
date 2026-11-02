import fs from 'node:fs';
import { cleanDir, loadCopy, makeEngine, checker } from './lib.mjs';

/**
 * CASE F — no API key => mock path, and zero network.
 * A fetchImpl that throws proves the mock branch never touches the network.
 * A negative control proves the real branch exists (and would need a key + network).
 */
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('F', 'no API key uses the mock path with zero network calls');

delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;

let fetchCalls = 0;
const explodingFetch = () => { fetchCalls += 1; throw new Error('NETWORK CALLED IN MOCK MODE'); };

const { engine } = await makeEngine(ctx, dir, 'p6-nokey', {}, { fetchImpl: explodingFetch });
T.eq('cfg carries no api key', engine.cfg.llm.apiKey, '');
T.eq('llm mode is mock', engine.llm.mode, 'mock');

const sub = await engine.submit({ text: '@superagent 实现 无 Key 演示 文档', source: 'cli', threadId: 'thread_nokey', author: 'carol' });
const tick = await engine.tick({ force: true });
await engine.drain();
const stats = engine.llm.stats();
const task = engine.repo.getTask(tick.taskId);

T.eq('router still dispatched without a key', tick.action, 'dispatch');
T.eq('task finished without a key', task.status, 'done');
T.check('every llm call was served by the mock handler', stats.calls > 0 && stats.mockCalls === stats.calls, { calls: stats.calls, mockCalls: stats.mockCalls });
T.eq('fetch was never called', fetchCalls, 0);
T.eq('llm error counter stayed at 0', stats.errors, 0);
T.check('deliverable exists on disk', Boolean(task.deliverable) && fs.existsSync(task.deliverable), { deliverable: task.deliverable });
const md = fs.readFileSync(task.deliverable, 'utf8');
T.check('deliverable records that the brain was mock', /brain: mock/.test(md), { head: md.split('\n').slice(0, 6).join(' | ') });
await engine.close();

// negative control: with a key set the client must go to the network and surface the failure
const client = new ctx.LLMClient({
  cfg: { apiKey: 'sk-test', baseURL: 'http://127.0.0.1:9/v1', maxRetries: 0, timeoutMs: 500, temperature: 0 },
  fetchImpl: () => { fetchCalls += 1; throw new Error('boom-from-fake-network'); }
});
T.eq('negative control: a key switches the client to openai mode', client.mode, 'openai');
let rejected = false; let msg = '';
try { await client.chat({ model: 'm', messages: [] }); } catch (e) { rejected = true; msg = String(e.message || e); }
T.check('negative control: the real branch calls fetch and fails loudly instead of silently mocking', rejected && fetchCalls === 1, { rejected, fetchCalls, msg });
T.check('mock mode was never reachable while a key was set', client.stats().mockCalls === 0, client.stats());

T.finish();
