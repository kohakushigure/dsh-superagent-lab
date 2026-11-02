import { cleanDir, loadCopy, checker, startResident, startStub, getJson, postJson, openReadOnly, sampleConcurrency, waitFor, sleep } from './hlib.mjs';

/**
 * H2 — MAX_CONCURRENCY must actually gate the dispatch, not just decorate /api/state.
 *
 * Deterministic setup: BATCH_MAX=1 + BATCH_WINDOW_MS=0 so each trigger becomes its own task,
 * and an OpenAI-compatible stub that answers the worker after 400 ms (router answers instantly).
 * With cap=2 and 8 triggers the queue must stay non-empty while exactly 2 run.
 */
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('H2', 'MAX_CONCURRENCY=2 gates dispatch: peak inflight <= 2 with queued > 0');

let cap2Peak = null;   // hoisted: the cap=1 control block compares against it
const stub = await startStub({ workerDelayMs: 400 });
const res = await startResident({
  copyDir: dir, name: 'h2',
  env: {
    MAX_CONCURRENCY: '2',
    BATCH_MAX: '1',
    BATCH_WINDOW_MS: '0',
    OPENAI_API_KEY: 'stub-key',
    OPENAI_BASE_URL: stub.url,
    MODEL_ROUTER: 'r-model',
    MODEL_WORKER: 'w-model'
  }
});
try {
  const s0 = await getJson(res.url + '/api/state');
  T.eq('setup: state reports the configured cap', s0.body.concurrency.cap, 2);
  T.eq('setup: llm mode is the real openai branch (stub endpoint)', s0.body.llmMode, 'openai');
  T.eq('setup: nothing in flight yet', [s0.body.concurrency.inflight, s0.body.concurrency.queued], [0, 0]);

  const sampling = sampleConcurrency(res.url, 5000, 30);
  const posted = [];
  for (let i = 1; i <= 8; i += 1) {
    const r = await postJson(res.url + '/api/triggers', { text: '@superagent H2 并发 第' + i + '条', thread: 'h2/t' + i, author: 'qa-h2' });
    posted.push(r.body);
    await sleep(20);
  }
  T.eq('all 8 posts accepted', posted.filter((p) => p.status === undefined && p.triggerId).length, 8);

  const seen = await sampling;
  console.log('--- concurrency samples (first 12) --- ' + JSON.stringify(seen.samples.slice(0, 12)));
  console.log('--- peak inflight=' + seen.peakInflight + ' maxQueued=' + seen.maxQueued + ' cap=' + seen.cap + ' overCapSamples=' + seen.overCap + ' ---');

  cap2Peak = seen.peakInflight;
  T.eq('cap-2 really limits peak inflight to 2', seen.peakInflight, 2);
  T.eq('no sample ever exceeded the cap', seen.overCap, 0);
  T.check('the queue was non-empty while workers were busy (queued > 0)', seen.maxQueued > 0, { maxQueued: seen.maxQueued, peak: seen.peakInflight });
  T.check('at least 8 of the samples saw a saturated pair', seen.samples.filter((s) => s.inflight === 2).length >= 8, {
    saturatedSamples: seen.samples.filter((s) => s.inflight === 2).length, totalSamples: seen.samples.length
  });

  const db = openReadOnly(ctx, res.dbPath);
  const allDone = await waitFor(() => {
    const rows = db.repo.all("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status");
    const done = rows.filter((r) => r.status === 'done').reduce((a, r) => a + r.n, 0);
    return done === 8 ? rows : null;
  }, 20000);
  T.check('all 8 tasks finished after the queue drained', Boolean(allDone), { statuses: allDone || db.repo.all('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status') });
  const queuedEvents = db.repo.all("SELECT * FROM events WHERE kind = 'task_dequeued'");
  T.check('the router recorded dequeue events (slot filling is observable)', queuedEvents.length >= 6, { dequeued: queuedEvents.length });
  const maxInflightInDb = db.repo.all("SELECT detail FROM events WHERE kind = 'task_dequeued'").map((e) => { try { return JSON.parse(e.detail).inflight; } catch { return 0; } });
  T.check('every dequeue happened below the cap', maxInflightInDb.every((n) => n < 2), { inflightAtDequeue: maxInflightInDb });
  db.close();

  T.check('the stub really was called by workers (concurrency came from real runs)', stub.calls.worker >= 8, { workerCalls: stub.calls.worker, routerCalls: stub.calls.router });
} finally {
  await res.stop();
  await stub.close();
}

// ---- cap=1 control: proves the gate is real, not just a reported number ----------
// (cap>=3 is masked by the router's per-thread serial awaits, so the meaningful contrast
//  is cap=1 vs cap=2; both are measured in flight, never from the final state.)
const stub1 = await startStub({ workerDelayMs: 400 });
const res1 = await startResident({
  copyDir: dir, name: 'h2c1',
  env: {
    MAX_CONCURRENCY: '1', BATCH_MAX: '1', BATCH_WINDOW_MS: '0',
    OPENAI_API_KEY: 'stub-key', OPENAI_BASE_URL: stub1.url, MODEL_ROUTER: 'r-model', MODEL_WORKER: 'w-model'
  }
});
try {
  const s = await getJson(res1.url + '/api/state');
  T.eq('cap-1 control: state reports cap=1', s.body.concurrency.cap, 1);
  const sampling1 = sampleConcurrency(res1.url, 3500, 30);
  const posted1 = [];
  for (let i = 1; i <= 4; i += 1) {
    const r = await postJson(res1.url + '/api/triggers', { text: '@superagent H2b 串行 第' + i + '条', thread: 'h2b/t' + i, author: 'qa-h2' });
    posted1.push(r.body);
    await sleep(20);
  }
  const seen1 = await sampling1;
  console.log('--- cap=1 peak inflight=' + seen1.peakInflight + ' maxQueued=' + seen1.maxQueued + ' overCap=' + seen1.overCap + ' ---');
  T.eq('cap-1 control: peak inflight is 1', seen1.peakInflight, 1);
  T.eq('cap-1 control: never above the cap', seen1.overCap, 0);
  T.check('cap-1 control: queue stayed non-empty', seen1.maxQueued > 0, { maxQueued: seen1.maxQueued });
  const db1 = openReadOnly(ctx, res1.dbPath);
  const done1 = await waitFor(() => {
    const rows = db1.repo.all("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status");
    return rows.filter((r) => r.status === 'done').reduce((a, r) => a + r.n, 0) === 4 ? rows : null;
  }, 20000);
  db1.close();
  T.check('cap-1 control: all 4 tasks finished', Boolean(done1), { statuses: done1 });
  T.check('cap-1 control: the gate is strictly tighter than cap=2', seen1.peakInflight < cap2Peak, { cap1Peak: seen1.peakInflight, cap2Peak });
} finally {
  await res1.stop();
  await stub1.close();
}
T.finish();
process.exit(process.exitCode || 0);
