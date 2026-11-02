import { cleanDir, loadCopy, makeEngine, checker } from './lib.mjs';

/**
 * CASE A — subscription passthrough really bypasses the Router.
 * Evidence = router decision counters + decisions table + subscriptions.hits + trigger status,
 * all read by this probe, not by the author's demo script.
 *
 * The trick: same thread, second event. With passthrough ON it must NOT create a decision row.
 * Control: identical workload with PASSTHROUGH_ENABLED=0 must create the second decision.
 */
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('A', 'subscription passthrough bypasses the router');

async function run(passthrough, tag) {
  const { engine } = await makeEngine(ctx, dir, 'p1-' + tag, { passthrough: { enabled: passthrough } });
  const repo = engine.repo;
  const ev1 = '@superagent 实现 登录页 的 单元测试';
  const ev2 = '@superagent 再补一个 集成 测试';
  const thread = 'thread_alpha';

  const r1 = await engine.submit({ text: ev1, source: 'cli', threadId: thread, author: 'alice' });
  const t1 = await engine.tick({ force: true });
  await engine.drain();
  const m1 = engine.metrics();
  const decisions1 = repo.countDecisions();

  const subBefore = repo.findSubscription(thread);
  const r2 = await engine.submit({ text: ev2, source: 'cli', threadId: thread, author: 'alice' });
  let t2 = null;
  if (r2.decision === 'batched') t2 = await engine.tick({ force: true });
  await engine.drain();
  const m2 = engine.metrics();

  const trig2 = repo.get('SELECT * FROM triggers WHERE id = ?', r2.triggerId);
  const decisionsForTrg2 = repo.all('SELECT * FROM decisions').filter((d) => JSON.parse(d.trigger_ids || '[]').includes(r2.triggerId));
  const passthroughTasks = repo.all("SELECT * FROM tasks WHERE origin = 'passthrough'");
  const subs = repo.all('SELECT * FROM subscriptions');
  const evPassthrough = repo.all("SELECT * FROM events WHERE kind = 'passthrough'");

  const out = {
    tag, passthrough,
    r1, tick1: t1, r2, tick2: t2,
    decisionsAfterFirst: decisions1,
    decisionsAfterSecond: repo.countDecisions(),
    routerDecisionsInProcess: m2.router.decisions,
    passthroughHitsInProcess: m2.router.passthroughHits,
    passthroughHitsInDb: m2.passthroughHitsInDb,
    trigger2Status: trig2 && trig2.status,
    decisionsTouchingSecondTrigger: decisionsForTrg2.length,
    passthroughTasks: passthroughTasks.length,
    subscriptionRows: subs.length,
    subscriptionSessions: subs.map((s) => ({ thread: s.thread_id, session: s.session_id, hits: s.hits, status: s.status })),
    passthroughEvents: evPassthrough.length,
    bypassed: evPassthrough[0] ? JSON.parse(evPassthrough[0].detail || '{}').bypassed : null,
    subSessionBeforeSecond: subBefore[0] ? subBefore[0].session_id : null,
    taskSession: passthroughTasks[0] ? passthroughTasks[0].session_id : null,
    taskStatus: passthroughTasks[0] ? passthroughTasks[0].status : null,
    deliverable: passthroughTasks[0] ? passthroughTasks[0].deliverable : null
  };
  await engine.close();
  return out;
}

const ON = await run(true, 'on');
const OFF = await run(false, 'off');

console.log('--- passthrough ON  --- ' + JSON.stringify({
  decisions: ON.decisionsAfterSecond, bypassHits: ON.passthroughHitsInDb,
  trigger2: ON.trigger2Status, decisionsTouching2: ON.decisionsTouchingSecondTrigger
}));
console.log('--- passthrough OFF --- ' + JSON.stringify({
  decisions: OFF.decisionsAfterSecond, bypassHits: OFF.passthroughHitsInDb,
  trigger2: OFF.trigger2Status, decisionsTouching2: OFF.decisionsTouchingSecondTrigger
}));

T.eq('ON: first event is batched then dispatched by the router', [ON.r1.decision, ON.tick1.action], ['batched', 'dispatch']);
T.eq('ON: second event on the same thread is passthrough', ON.r2.decision, 'passthrough');
T.eq('ON: second event creates NO new router decision', [ON.decisionsAfterFirst, ON.decisionsAfterSecond], [1, 1], ON);
T.eq('ON: no decision row references the second trigger', ON.decisionsTouchingSecondTrigger, 0);
T.eq('ON: bypass counter = 1 in process and 1 in db', [ON.passthroughHitsInProcess, ON.passthroughHitsInDb], [1, 1]);
T.eq('ON: trigger status is "passthrough"', ON.trigger2Status, 'passthrough');
T.eq('ON: passthrough task reuses the subscribed worker session', ON.taskSession, ON.subSessionBeforeSecond);
T.eq('ON: the passthrough event records what was skipped', ON.bypassed, ['batch', 'slow_path']);
T.eq('ON: passthrough task still completes', ON.taskStatus, 'done');

T.eq('OFF control: second event is batched, not passthrough', [OFF.r1.decision, OFF.r2.decision], ['batched', 'batched']);
T.eq('OFF control: second event costs a second router decision', [OFF.decisionsAfterFirst, OFF.decisionsAfterSecond], [1, 2], OFF);
T.eq('OFF control: the second trigger is referenced by a decision', OFF.decisionsTouchingSecondTrigger, 1);
T.eq('OFF control: bypass counter stays 0', [OFF.passthroughHitsInProcess, OFF.passthroughHitsInDb], [0, 0]);
T.eq('OFF control: no passthrough task exists', OFF.passthroughTasks, 0);

const delta = ON.decisionsAfterSecond === 0 ? null : Number((((OFF.decisionsAfterSecond - ON.decisionsAfterSecond) / ON.decisionsAfterSecond) * 100).toFixed(1));
T.check('decision delta without passthrough = +100% for this 2-event workload', delta === 100, { on: ON.decisionsAfterSecond, off: OFF.decisionsAfterSecond, deltaPercent: delta });
T.finish();
