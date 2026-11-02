import { cleanDir, loadCopy, checker, startResident, getJson, postJson, openReadOnly, waitFor, sleep } from './hlib.mjs';

/**
 * H1 — ingestion through the resident process.
 * The only trustworthy counter is the resident process's own router.received: a CLI submit
 * would run its own Engine and leave that counter at 0 (lead's prerequisite #1).
 */
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('H1', 'POST /api/triggers feeds the resident loop (not a CLI-side Engine)');

const res = await startResident({ copyDir: dir, name: 'h1' });
try {
  const s0 = await getJson(res.url + '/api/state');
  T.eq('setup: resident answers /api/state', s0.status, 200);
  T.eq('setup: llm runs in mock mode', s0.body.llmMode, 'mock');
  T.eq('setup: received starts at 0', s0.body.metrics.router.received, 0);
  T.eq('setup: default concurrency cap is 3', s0.body.concurrency.cap, 3);
  T.eq('setup: idle inflight/queued are 0', [s0.body.concurrency.inflight, s0.body.concurrency.queued], [0, 0]);

  const bad = await postJson(res.url + '/api/triggers', { text: '   ' });
  T.eq('POST /api/triggers with blank text -> 400', [bad.status, bad.body.ok], [400, false]);

  const posted = [];
  for (let i = 1; i <= 10; i += 1) {
    const r = await postJson(res.url + '/api/triggers', {
      text: '@superagent H1 摄取 第' + i + '条（请整理成文档）',
      thread: 'h1/t' + i,
      author: 'qa-h1',
      source: 'http'
    });
    posted.push({ i, status: r.status, body: r.body });
  }
  T.eq('all 10 posts answered 200', posted.filter((p) => p.status === 200).length, 10);
  T.eq('every post carries a triggerId', posted.filter((p) => p.body && typeof p.body.triggerId === 'string').length, 10);
  T.check('decision is batched (the resident loop, not the request handler, decides)', posted.every((p) => p.body.decision === 'batched'), {
    decisions: [...new Set(posted.map((p) => p.body.decision))]
  });
  const receiptSeq = posted.map((p) => p.body.received);
  T.eq('the endpoint reports a growing resident counter', receiptSeq, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  const s1 = await getJson(res.url + '/api/state');
  T.eq('resident router.received grew by exactly 10', s1.body.metrics.router.received - s0.body.metrics.router.received, 10);
  const noMention = posted.filter((p) => p.body.decision === 'dropped' && /no-mention/.test(String(p.body.reason)));
  T.eq('no trigger was dropped by the fast path (address word present)', noMention.length, 0);

  const db = openReadOnly(ctx, res.dbPath);
  const dispatched = await waitFor(() => {
    const rows = db.repo.all("SELECT status, COUNT(*) AS n FROM triggers GROUP BY status");
    const total = rows.reduce((a, r) => a + r.n, 0);
    const pending = rows.filter((r) => r.status === 'batched' || r.status === 'deciding').reduce((a, r) => a + r.n, 0);
    return total === 10 && pending === 0 ? rows : null;
  }, 15000);
  T.check('all 10 triggers reached a decided state', Boolean(dispatched), { statuses: dispatched });
  T.eq('none of them ended up dropped', (dispatched || []).filter((r) => r.status === 'dropped').length, 0);
  const tasks = db.repo.all('SELECT id, status, origin, trigger_ids FROM tasks');
  T.check('the work landed in the tasks table', tasks.length >= 1, { tasks: tasks.length });
  const triggerIdsInTasks = new Set(tasks.flatMap((t) => JSON.parse(t.trigger_ids || '[]')));
  T.eq('every trigger is attached to a task', triggerIdsInTasks.size, 10);
  const decisions = db.repo.countDecisions();
  T.check('decisions were recorded by the resident router', decisions >= 1, { decisions });
  // D1 fix: batching is per thread, so 10 distinct threads must cost 10 decisions / 10 tasks.
  const threadOf = new Map(db.repo.all('SELECT id, thread_id FROM triggers').map((r) => [r.id, r.thread_id]));
  const crossThread = db.repo.all('SELECT trigger_ids FROM decisions')
    .filter((d) => new Set(JSON.parse(d.trigger_ids || '[]').map((id) => threadOf.get(id))).size > 1);
  T.eq('cross-thread events are NOT merged into one decision', crossThread.length, 0);
  T.eq('one decision per thread (10 threads)', decisions, 10);
  T.eq('one task per thread (10 threads)', tasks.length, 10);
  db.close();

  const page = await getJson(res.url + '/', 5000);
  T.eq('panel HTML renders', page.status, 200);
  const anyTaskId = tasks[0] && tasks[0].id;
  T.check('panel lists the new task', anyTaskId ? page.text.includes(anyTaskId) : false, { lookedFor: anyTaskId });
  T.check('panel shows the concurrency line', /inflight=/.test(page.text), {});

  const s2 = await getJson(res.url + '/api/state');
  T.check('state tasks carry a project field (null when no PROJECTS match)', s2.body.tasks.every((t) => Object.prototype.hasOwnProperty.call(t, 'project')), {
    first: s2.body.tasks[0] && s2.body.tasks[0].project
  });
} finally {
  const stopped = await res.stop();
  T.eq('resident stopped cleanly via /api/stop', stopped, true);
}
T.finish();
process.exit(process.exitCode || 0);
