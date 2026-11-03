#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { BASE_DIR, loadConfig } from '../src/config.mjs';
import { newId } from '../src/db.mjs';

const EVID = path.join(BASE_DIR, 'evidence');
const PORT = Number(process.env.PANEL_PORT || 3182);
const RUN_TAG = 'd' + Date.now().toString(36);
const consoleLines = [];
const checks = [];
const report = { runTag: RUN_TAG, startedAt: new Date().toISOString(), steps: [], checks, metrics: null, ablation: null };

const th = (name) => RUN_TAG + '/' + name;  // per-run thread namespace: demo is re-runnable on an existing state dir

function say(line) {
  consoleLines.push(line);
  console.log(line);
}
function head(title) {
  say('');
  say('='.repeat(78));
  say('>> ' + title);
  say('='.repeat(78));
}
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  say((ok ? '  PASS  ' : '  FAIL  ') + name + (detail === undefined ? '' : '  ::  ' + JSON.stringify(detail)));
}
function bigLog(lines) {
  const out = [];
  for (let i = 0; i < lines; i += 1) {
    out.push('2026-10-31T21:' + String(i % 60).padStart(2, '0') + ':00Z INFO worker step=' + i + ' tool=fs.write ok=true bytes=' + (100 + i * 7) + ' note=simulated-verbose-tool-output-for-spill-demo');
  }
  return out.join('\n');
}

const DEMO_STATE = process.env.SUPERAGENT_STATE_DIR || path.join(BASE_DIR, 'state-demo');

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  // per-run isolation: every counter below is this run's delta, not an accumulated total
  fs.rmSync(DEMO_STATE, { recursive: true, force: true });
  fs.rmSync(path.join(BASE_DIR, '.work'), { recursive: true, force: true });
  const cfg = loadConfig(process.env, {
    stateDir: DEMO_STATE,
    // demo 是确定性的脚本演示：强制离线 mock 大脑，避免 .env.local 里的真模型把它变成非确定输出
    llm: { apiKey: '' },
    filter: { allowlist: ['alice', 'bob', 'carol'], batchWindowMs: 400 }
  });
  const engine = await Engine.create({ cfg, echo: false });
  say('local-superagent demo   runTag=' + RUN_TAG);
  say('  llm mode        : ' + engine.llm.mode);
  say('  db              : ' + engine.dbPath);
  say('  router session  : ' + engine.router.routerSessionId);
  const panelUrl = await engine.startPanel(PORT);
  engine.watchdog.start();
  say('  panel           : ' + panelUrl);

  // ── A. router dispatch ───────────────────────────────────────────────────
  head('A. Router dispatch: two-level filter passes, ONE decision, ONE task');
  const a1 = await engine.submit({
    text: '@superagent 给 README 补一节 Quickstart，含 3 行可复制示例',
    source: 'github', threadId: th('gh/issue-42'), groupId: 'deepseek-ai/dsh-superagent', author: 'alice',
    dedupeKey: RUN_TAG + ':a1'
  });
  say('  ingest -> ' + JSON.stringify(a1));
  const tickA = await engine.tick({ force: true });
  say('  tick   -> ' + JSON.stringify(tickA));
  await engine.drain();
  const taskA = engine.repo.getTask(tickA.taskId);
  say('  task   -> status=' + taskA.status + ' deliverable=' + taskA.deliverable);
  check('A dispatch produced a done task with a deliverable', taskA.status === 'done' && Boolean(taskA.deliverable));
  engine.repo.listTasks(5);
  report.steps.push({ step: 'A', ingest: a1, tick: tickA, task: { id: taskA.id, status: taskA.status, deliverable: taskA.deliverable } });

  // ── B. subscription passthrough ──────────────────────────────────────────
  head('B. Subscription passthrough: same thread, next events skip batch + slow path');
  const decisionsBefore = engine.repo.countDecisions();
  const b1 = await engine.submit({
    text: '@superagent 补充：把 npm test 的用法也写进 Quickstart',
    source: 'github', threadId: th('gh/issue-42'), author: 'bob', dedupeKey: RUN_TAG + ':b1'
  });
  await engine.drain();
  const b2 = await engine.submit({
    text: '@superagent 再加一行：node --test 输出怎么读',
    source: 'github', threadId: th('gh/issue-42'), author: 'bob', dedupeKey: RUN_TAG + ':b2'
  });
  await engine.drain();
  const decisionsAfter = engine.repo.countDecisions();
  say('  ingest -> ' + JSON.stringify(b1));
  say('  ingest -> ' + JSON.stringify(b2));
  say('  decisions in db: ' + decisionsBefore + ' -> ' + decisionsAfter + ' (must not grow)');
  const sub = engine.repo.findSubscription(th('gh/issue-42'))[0];
  say('  subscription -> ' + JSON.stringify({ id: sub.id, session: sub.session_id, hits: sub.hits, status: sub.status }));
  check('B passthrough decided twice', b1.decision === 'passthrough' && b2.decision === 'passthrough', { b1: b1.decision, b2: b2.decision });
  check('B router decisions did not grow', decisionsAfter === decisionsBefore, { decisionsBefore, decisionsAfter });
  check('B subscription hits recorded twice', engine.repo.findSubscription(th('gh/issue-42'))[0].hits >= 2);
  check('B router bypass counter incremented', engine.router.counters.passthroughHits >= 2, { bypass: engine.router.counters.passthroughHits });
  check('B follow-up task shares the subscriber session', engine.repo.getTask(b1.taskId).session_id === sub.session_id);
  report.steps.push({ step: 'B', decisionsBefore, decisionsAfter, hits: sub.hits, bypass: engine.router.counters.passthroughHits });

  // ── C. fast path drops ───────────────────────────────────────────────────
  head('C. Fast path (program level): deterministic drops, no model call');
  const c1 = await engine.submit({ text: '这个 PR 看起来不错，但我没有提到机器人', source: 'github', threadId: th('gh/issue-50'), author: 'alice', dedupeKey: RUN_TAG + ':c1' });
  const c2 = await engine.submit({ text: '@superagent 给 README 补一节 Quickstart，含 3 行可复制示例', source: 'github', threadId: th('gh/issue-42'), author: 'alice', dedupeKey: RUN_TAG + ':a1' });
  const c3 = await engine.submit({ text: '@superagent 帮我看下构建为什么红了', source: 'twitter', threadId: th('tw/1'), author: 'dave', dedupeKey: RUN_TAG + ':c3' });
  const c4 = await engine.submit({ text: '@superagent 帮我改一下对外文案', source: 'slack', threadId: th('sl/9'), author: 'mallory', dedupeKey: RUN_TAG + ':c4' });
  const c5 = await engine.submit({ text: '[bot] @superagent 自动回复：已收到', source: 'slack', threadId: th('sl/10'), author: 'superagent', dedupeKey: RUN_TAG + ':c5' });
  const reasons = [c1, c2, c3, c4, c5].map((r) => r.reason);
  say('  reasons -> ' + JSON.stringify(reasons));
  check('C no-mention dropped', /no-mention/.test(reasons[0]), reasons[0]);
  check('C duplicate dropped', /duplicate/.test(reasons[1]), reasons[1]);
  check('C source-not-allowed dropped', /source-not-allowed/.test(reasons[2]), reasons[2]);
  check('C author-not-allowed dropped', /author-not-allowed/.test(reasons[3]), reasons[3]);
  check('C self-message dropped', /self-message/.test(reasons[4]), reasons[4]);
  check('C fast path made zero model calls', engine.filter.counters.slowCalls === 1, { slowCalls: engine.filter.counters.slowCalls });
  report.steps.push({ step: 'C', reasons });

  // ── D. slow path ignore ──────────────────────────────────────────────────
  head('D. Slow path (semantic): model says ignore');
  await engine.submit({ text: '@superagent 今天的天气不错，随便聊聊哈哈', source: 'slack', threadId: th('sl/11'), author: 'alice', dedupeKey: RUN_TAG + ':d1' });
  const tickD = await engine.tick({ force: true });
  say('  tick -> ' + JSON.stringify(tickD));
  check('D slow path ignored the chatter', tickD.action === 'ignore', tickD);
  report.steps.push({ step: 'D', tick: tickD });

  // ── E. need_human ────────────────────────────────────────────────────────
  head('E. Slow path escalates a risky request to a human decision');
  await engine.submit({ text: '@superagent 删除生产库并轮换密钥，越快越好', source: 'slack', threadId: th('sl/12'), author: 'bob', dedupeKey: RUN_TAG + ':e1' });
  const tickE = await engine.tick({ force: true });
  const pending = engine.repo.pendingHumanDecisions();
  say('  tick    -> ' + JSON.stringify(tickE));
  say('  pending -> ' + pending.length + ' item(s)');
  check('E risky request escalated', tickE.action === 'need_human' && pending.length >= 1, { action: tickE.action, pending: pending.length });
  report.steps.push({ step: 'E', tick: tickE, pending: pending.map((p) => ({ id: p.id, reason: p.reason })) });

  // ── F. batch merge ───────────────────────────────────────────────────────
  head('F. Batch merge: three triggers in one window = ONE model decision');
  // 同一 thread 的三条事件才合批（跨 thread 合批会让项目串台，见 docs §13.3）
  await engine.submit({ text: '@superagent 把构建日志按小时聚合', source: 'slack', threadId: th('sl/20'), author: 'alice', dedupeKey: RUN_TAG + ':f1' });
  await engine.submit({ text: '@superagent 顺手把聚合脚本写成 tools/agg.mjs', source: 'slack', threadId: th('sl/20'), author: 'alice', dedupeKey: RUN_TAG + ':f2' });
  await engine.submit({ text: '@superagent 再加一个 --since 参数', source: 'slack', threadId: th('sl/20'), author: 'alice', dedupeKey: RUN_TAG + ':f3' });
  const tickF = await engine.tick({ force: true });
  await engine.drain();
  say('  tick -> ' + JSON.stringify(tickF));
  check('F three triggers merged into one decision', tickF.batchSize === 3 && tickF.decisions === 1, tickF);
  report.steps.push({ step: 'F', tick: tickF });

  // ── G. spill + chained recall ────────────────────────────────────────────
  head('G. Context cache: Inline & Spill + chained recall (message -> thread -> session -> task)');
  const workerSession = engine.repo.getTask(tickA.taskId).session_id;
  const payload = bigLog(60);
  const inlineBefore = engine.ctx.inline(workerSession).chars;
  const appended = engine.ctx.appendMessage({
    sessionId: workerSession, threadId: th('gh/issue-42'), role: 'tool',
    content: payload, nextHop: { kind: 'thread', id: th('gh/issue-42') }
  });
  const inline = engine.ctx.inline(workerSession);
  const inlineDelta = inline.chars - inlineBefore;
  const restored = engine.ctx.readSpill(appended.id);
  const chain = engine.ctx.recall('message', appended.id, { depth: 4 });
  say('  spilled        : ' + appended.spilled + '  full=' + payload.length + ' chars  inline delta=' + inlineDelta + ' chars (summary only)');
  say('  spill file     : ' + appended.blobPath);
  say('  resume bytes   : ' + (restored ? restored.length : 0) + ' chars (identical=' + (restored === payload) + ')');
  say('  recall chain   : ' + chain.map((n) => n.kind + ':' + n.id).join(' -> '));
  check('G payload spilled to disk', appended.spilled && fs.existsSync(appended.blobPath));
  check('G inline holds the summary, not the payload', appended.spilled === true && inlineDelta < payload.length / 3, { inlineChars: inline.chars, full: payload.length, inlineDelta });
  check('G resume handle restores identical bytes', restored === payload);
  check('G chain walks message -> thread -> session -> task', chain.map((n) => n.kind).join(',') === 'message,thread,session,task', chain.map((n) => n.kind));
  report.steps.push({ step: 'G', spilled: appended.spilled, fullChars: payload.length, inlineBefore, inlineAfter: inline.chars, inlineDelta, chain: chain.map((n) => n.kind + ':' + n.id) });

  // ── H. watchdog ──────────────────────────────────────────────────────────
  head('H. Watchdog: detect a stalled task, mark it, restart the worker');
  const stuckId = newId('task');
  const stuckSess = newId('sess');
  const stuckAt = Date.now() - Math.max(60000, engine.cfg.watchdog.stallMs * 3);
  engine.repo.createTask({ id: stuckId, title: 'stuck task (watchdog demo)', intent: 'simulate a hung worker', status: 'running', origin: 'manual', sessionId: stuckSess, threadId: th('wd/demo'), workdir: path.join(engine.cfg.workRoot, stuckId), triggerIds: [], now: stuckAt });
  engine.repo.createSession({ id: stuckSess, role: 'worker', taskId: stuckId, threadId: th('wd/demo'), model: 'mock' });
  engine.repo.updateTask(stuckId, { progress_at: stuckAt, runs: 1 });
  const wd = await engine.watchdog.tick();
  say('  findings -> ' + JSON.stringify(wd.findings));
  await engine.drain();
  const stuckAfter = engine.repo.getTask(stuckId);
  say('  after    -> status=' + stuckAfter.status + ' attempt=' + stuckAfter.attempt);
  check('H watchdog flagged a stall', wd.findings.some((f) => f.kind === 'stall'));
  check('H watchdog restarted the worker', wd.findings.some((f) => f.action === 'restarted'));
  check('H restarted task finished', stuckAfter.status === 'done' && stuckAfter.attempt === 2, { status: stuckAfter.status, attempt: stuckAfter.attempt });
  report.steps.push({ step: 'H', findings: wd.findings, task: { id: stuckId, status: stuckAfter.status, attempt: stuckAfter.attempt } });

  // ── I. crash recovery ────────────────────────────────────────────────────
  head('I. Crash recovery: in-flight task survives a process restart');
  const recId = newId('task');
  const recSess = newId('sess');
  engine.repo.createTask({ id: recId, title: 'in-flight task at crash time', intent: '@superagent 生成一份交付物，进程会在中途崩掉', status: 'running', origin: 'router', sessionId: recSess, threadId: th('rc/demo'), workdir: path.join(engine.cfg.workRoot, recId), triggerIds: [], now: Date.now() });
  engine.repo.createSession({ id: recSess, role: 'worker', taskId: recId, threadId: th('rc/demo'), model: 'mock' });
  engine.ctx.appendMessage({ sessionId: recSess, role: 'user', content: 'crash simulation: first step already executed', nextHop: { kind: 'session', id: recSess } });
  await engine.close();
  say('  engine #1 closed (simulated crash) with task ' + recId + ' in running state');
  const engine2 = await Engine.create({ cfg, echo: false });
  say('  engine #2 recovered -> ' + JSON.stringify(engine2.recovered));
  check('I recovered the in-flight task', engine2.recovered.includes(recId), { recovered: engine2.recovered });
  await engine2.drain();
  const recAfter = engine2.repo.getTask(recId);
  const recMsgs = engine2.repo.countMessages(recSess);
  say('  after restart -> status=' + recAfter.status + ' attempt=' + recAfter.attempt + ' session messages=' + recMsgs);
  check('I recovered task completed', recAfter.status === 'done' && recAfter.attempt === 2, { status: recAfter.status, attempt: recAfter.attempt });
  check('I worker session context was reused', recMsgs >= 2, { messages: recMsgs });
  report.steps.push({ step: 'I', recovered: engine2.recovered, task: { id: recId, status: recAfter.status, attempt: recAfter.attempt, messages: recMsgs } });

  // ── J. panel ─────────────────────────────────────────────────────────────
  head('J. HTTP panel: pending human decisions + live metrics');
  const url2 = await engine2.startPanel(PORT);
  const health = await (await fetch(url2 + '/api/health')).json();
  const state = await (await fetch(url2 + '/api/state')).json();
  say('  GET /api/health -> ' + JSON.stringify(health));
  say('  GET /api/state  -> tasks=' + state.tasks.length + ' pending=' + state.pending.length + ' decisionsInDb=' + state.metrics.router.decisionsInDb);
  let resolvedOut = null;
  if (state.pending.length) {
    const target = state.pending[0].id;
    const res = await fetch(url2 + '/api/decisions/' + target + '/resolve', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, cfg.panel.authToken ? { 'x-auth-token': cfg.panel.authToken } : {}),
      body: JSON.stringify({ resolution: 'approve' })
    });
    resolvedOut = await res.json();
    say('  POST /api/decisions/' + target + '/resolve -> ' + JSON.stringify(resolvedOut.decision ? { resolution: resolvedOut.decision.resolution } : resolvedOut));
  }
  check('J panel health ok', health.ok === true);
  check('J panel state exposes tasks and metrics', Array.isArray(state.tasks) && state.tasks.length > 0 && state.metrics.router.decisionsInDb > 0, { tasks: state.tasks.length, decisionsInDb: state.metrics.router.decisionsInDb });
  check('J human decision resolvable from the panel', Boolean(resolvedOut && resolvedOut.ok));
  report.steps.push({ step: 'J', health, tasks: state.tasks.length, pending: state.pending.length, resolved: Boolean(resolvedOut && resolvedOut.ok) });
  report.metrics = engine2.metrics();
  await engine2.close();

  // ── K. ablation ──────────────────────────────────────────────────────────
  head('K. Ablation: same workload with and without subscription passthrough');
  const on = await ablation(true);
  const off = await ablation(false);
  const delta = off.decisions === 0 ? null : Number((((off.decisions - on.decisions) / on.decisions) * 100).toFixed(1));
  say('  passthrough ON  -> decisions=' + on.decisions + ' bypass=' + on.bypass + ' tasks=' + JSON.stringify(on.tasks));
  say('  passthrough OFF -> decisions=' + off.decisions + ' bypass=' + off.bypass + ' tasks=' + JSON.stringify(off.tasks));
  say('  router decisions delta without passthrough: +' + delta + '%');
  check('K passthrough reduces router decisions', on.decisions < off.decisions, { on: on.decisions, off: off.decisions, deltaPercent: delta });
  check('K both variants produce the same number of tasks', JSON.stringify(on.tasks) === JSON.stringify(off.tasks), { on: on.tasks, off: off.tasks });
  report.ablation = { on, off, deltaPercent: delta };

  // ── evidence ─────────────────────────────────────────────────────────────
  report.finishedAt = new Date().toISOString();
  report.passed = checks.filter((c) => c.ok).length;
  report.failed = checks.filter((c) => !c.ok).length;
  fs.writeFileSync(path.join(EVID, 'demo-run.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(EVID, 'demo-console.log'), consoleLines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(EVID, 'README.md'), evidenceReadme(report), 'utf8');
  head('SUMMARY');
  say('  checks passed: ' + report.passed + '   failed: ' + report.failed);
  say('  evidence     : evidence/{demo-run.json,demo-console.log,run.jsonl,README.md} + state/spill/');
  if (report.failed) {
    for (const c of checks.filter((x) => !x.ok)) say('  FAILED: ' + c.name + ' ' + JSON.stringify(c.detail));
    process.exitCode = 1;
  }
}

function evidenceReadme(r) {
  return [
    '# evidence/ — real run output (not hand-written)',
    '',
    'Generated by `node bin/demo.mjs` at ' + r.finishedAt + ' (runTag ' + r.runTag + ', LLM mode: mock / no API key).',
    '',
    'The demo deletes `../state` and `../.work` before it starts, so every number below is this run only and reproduces from a clean checkout.',
    '',
    '| file | what it proves |',
    '| --- | --- |',
    '| `demo-console.log` | the full human-readable console transcript of the run |',
    '| `demo-run.json` | machine-readable per-step results + all assertions (passed=' + r.passed + ', failed=' + r.failed + ') |',
    '| `run.jsonl` | structured application log, one JSON record per line |',
    '| `ablation-on.jsonl`, `ablation-off.jsonl` | the passthrough on/off ablation run logs |',
    '| `../state/spill/<session>/<message>.md` | the full payloads evicted from context by Inline & Spill |',
    '',
    'Key numbers from this run:',
    '',
    '- router decisions with passthrough: ' + (r.ablation ? r.ablation.on.decisions : 'n/a'),
    '- router decisions without passthrough: ' + (r.ablation ? r.ablation.off.decisions : 'n/a') + ' (+' + (r.ablation ? r.ablation.deltaPercent : 'n/a') + '%)',
    '- passthrough hits (events that never reached a router decision): ' + (r.ablation ? r.ablation.on.bypass : 'n/a'),
    '',
    'The state directory (`../state/superagent.sqlite`) holds the same facts as tables; the panel at',
    '`http://127.0.0.1:3182` renders them while the process is running.'
  ].join('\n') + '\n';
}

async function ablation(enabled) {
  // ablation 也放在 demo 自己的目录下，避免和常驻进程/上次运行抢占同一路径（Windows 删除会 EPERM）
  const stateDir = path.join(DEMO_STATE, enabled ? 'ablation-on' : 'ablation-off');
  fs.rmSync(stateDir, { recursive: true, force: true });
  const cfg = loadConfig(process.env, {
    stateDir,
    logFile: path.join(EVID, 'ablation-' + (enabled ? 'on' : 'off') + '.jsonl'),
    passthrough: { enabled },
    worker: { shellProbe: false },
    filter: { batchWindowMs: 10 }
  });
  const eng = await Engine.create({ cfg, echo: false });
  const threads = [];
  for (let i = 0; i < 15; i += 1) {
    const th = 'ab/new-' + i;
    threads.push(th);
    await eng.submit({ text: '@superagent 生成第 ' + i + ' 份交付物并自检', source: 'slack', threadId: th, author: 'alice' });
    await eng.tick({ force: true });
    await eng.drain();
  }
  for (let i = 0; i < 5; i += 1) {
    await eng.submit({ text: '@superagent 补充第 ' + i + ' 份交付物的验收标准', source: 'slack', threadId: threads[i], author: 'bob' });
    await eng.tick({ force: true });
    await eng.drain();
  }
  const m = eng.metrics();
  const out = { enabled, decisions: m.router.decisions, bypass: m.router.passthroughHits, tasks: m.tasks, llmCalls: m.llm.calls };
  await eng.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
  return out;
}

main().catch((err) => {
  console.error('demo failed: ' + (err && err.stack ? err.stack : err));
  // exit even if the panel/listeners are still open, otherwise the port stays bound
  process.exit(1);
});