import { cleanDir, loadCopy, makeEngine, checker, sleep } from './lib.mjs';

/**
 * CASE E — HTTP panel, probed with raw fetch (no author test exists for the server).
 * Covers /api/health, /api/state, the HTML page, resolving a human decision,
 * a manual task retry and the 404 path.
 */
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('E', 'HTTP panel serves health/state/HTML and resolves a human decision');

const port = 30000 + (process.pid % 2000);
const { engine } = await makeEngine(ctx, dir, 'p5-panel', { panel: { host: '127.0.0.1', port } });
const repo = engine.repo;

// one task that needs a person, one that finishes normally
const risky = await engine.submit({ text: '@superagent 删除生产库 的全部数据', source: 'cli', threadId: 'thread_panel_risky', author: 'erin' });
const tRisky = await engine.tick({ force: true });
const normal = await engine.submit({ text: '@superagent 实现 面板 文档', source: 'cli', threadId: 'thread_panel_ok', author: 'erin' });
const tNormal = await engine.tick({ force: true });
await engine.drain();

T.eq('setup: risky request became a need_human decision', tRisky.action, 'need_human');
T.eq('setup: normal request became a task', tNormal.action, 'dispatch');
const pendingBefore = repo.pendingHumanDecisions();
T.check('setup: one unresolved decision is queued for a person', pendingBefore.length === 1, { pending: pendingBefore.length });

const { url } = await engine.start({ port });
T.check('engine.start() reports a loopback panel url', /^http:\/\/127\.0\.0\.1:\d+$/.test(url), { url });
await sleep(80);

const j = async (p, init) => {
  const res = await fetch(url + p, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, type: res.headers.get('content-type') || '', text, body };
};

const health = await j('/api/health');
T.eq('GET /api/health -> 200', health.status, 200);
T.eq('GET /api/health reports ok + mock llm', [health.body.ok, health.body.llm], [true, 'mock']);

const state1 = await j('/api/state');
T.eq('GET /api/state -> 200', state1.status, 200);
T.check('state exposes tasks, subscriptions, events and metrics', Array.isArray(state1.body.tasks) && Array.isArray(state1.body.subscriptions) && Array.isArray(state1.body.events) && Boolean(state1.body.metrics), {
  tasks: state1.body.tasks.length, subs: state1.body.subscriptions.length, events: state1.body.events.length
});
T.check('state reports the router decision counter from the db', state1.body.metrics.router.decisionsInDb >= 2, { decisionsInDb: state1.body.metrics.router.decisionsInDb });
T.eq('state lists exactly one pending human decision', state1.body.pending.length, 1);
const pid = state1.body.pending[0].id;
T.check('the pending item carries its reason and trigger ids', Boolean(state1.body.pending[0].reason) && Boolean(state1.body.pending[0].triggers), state1.body.pending[0]);

const page = await j('/');
T.eq('GET / -> 200', page.status, 200);
T.check('GET / is html', page.type.includes('text/html'), { type: page.type });
T.check('the page renders the pending-decision section', page.text.includes('pending human decisions'), {});
T.check('the page renders live counters including bypass hits', /bypass\(db hits\)=/.test(page.text), { snippet: (page.text.match(/bypass\(db hits\)=[0-9]+/) || [null])[0] });
T.check('the page lists the subscribed thread -> worker session table', page.text.includes('thread -&gt; worker session'), {});

const resolved = await j('/api/decisions/' + pid + '/resolve', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: 'approve' })
});
T.eq('POST /api/decisions/:id/resolve -> 200', resolved.status, 200);
T.eq('the decision row is now approved and resolved', [resolved.body.decision.resolution, resolved.body.decision.resolved], ['approved', 1]);
const state2 = await j('/api/state');
T.eq('after resolving, the pending queue is empty', state2.body.pending.length, 0);
T.check('a human_decision event was appended', repo.all("SELECT * FROM events WHERE kind = 'human_decision'").length === 1, {});

const doneTask = tNormal.taskId;
const retry = await j('/api/tasks/' + doneTask + '/retry', { method: 'POST' });
T.eq('POST /api/tasks/:id/retry -> 200', retry.status, 200);
T.eq('the retry echoes the task id', retry.body.taskId, doneTask);
T.check('a manual_retry event was appended', repo.all("SELECT * FROM events WHERE kind = 'manual_retry'").length === 1, {});

const miss = await j('/api/does-not-exist');
T.eq('GET /api/does-not-exist -> 404', miss.status, 404);
T.eq('the 404 body is JSON with ok:false', miss.body.ok, false);

const retryMissing = await j('/api/tasks/nope/retry', { method: 'POST' });
T.eq('retrying an unknown task -> 404', retryMissing.status, 404);

await engine.close();
T.finish();
