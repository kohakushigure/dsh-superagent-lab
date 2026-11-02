#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDb, Repo, pj } from '../src/db.mjs';

const USAGE = [
  'local-superagent CLI (Node 24, zero deps)',
  '',
  '  node bin/superagent.mjs start   [--port 3082]        resident router + worker + watchdog + panel',
  '  node bin/superagent.mjs submit  <text> [--source] [--thread] [--author] [--group] [--key]',
  '  node bin/superagent.mjs status                       tasks / triggers / metrics snapshot',
  '  node bin/superagent.mjs logs    [--task ID] [-n 30]  event log',
  '  node bin/superagent.mjs watch   [--interval 1000]    follow the event log',
  '  node bin/superagent.mjs stop    [--port 3082]        graceful stop (panel or db flag)',
  '  node bin/superagent.mjs unsubscribe <subId|threadId> close a subscription (stop thread passthrough)',
  '  node bin/superagent.mjs demo                         scripted end-to-end demo',
  '',
  'env: OPENAI_BASE_URL OPENAI_API_KEY MODEL_ROUTER MODEL_WORKER PANEL_PORT PASSTHROUGH_ENABLED'
].join('\n');

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out.flags[key] = next; i += 1; } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

function table(rows, cols) {
  if (!rows.length) return '(empty)';
  const width = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) == null ? '' : c.get(r)).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(width[i])).join('  ');
  const out = [line(cols.map((c) => c.label)), line(width.map((w) => '-'.repeat(w)))];
  for (const r of rows) out.push(line(cols.map((c) => (c.get(r) == null ? '' : c.get(r)))));
  return out.join('\n');
}

function openReadOnly(cfg) {
  if (!fs.existsSync(cfg.dbPath)) return null;
  const db = openDb(cfg.dbPath, { migrate: false });
  return new Repo(db);
}

async function cmdStart(args) {
  const engine = await Engine.create({});
  const url = await engine.start({ port: args.flags.port ? Number(args.flags.port) : undefined });
  console.log('');
  console.log('local-superagent running');
  console.log('  panel      : ' + url.url);
  console.log('  llm mode   : ' + engine.llm.mode + (engine.llm.mode === 'mock' ? '  (set OPENAI_API_KEY for a real model)' : ''));
  console.log('  db         : ' + engine.dbPath);
  console.log('  work root  : ' + engine.cfg.workRoot);
  console.log('  router ssn : ' + engine.router.routerSessionId);
  console.log('  recovered  : ' + (engine.recovered.length ? engine.recovered.join(',') : 'none'));
  console.log('  stop with  : node bin/superagent.mjs stop');
  console.log('');
  const shutdown = async () => {
    console.log('shutting down…');
    await engine.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // exit as soon as the resident loop stops (panel /api/stop or db flag)
  while (engine.running) await new Promise((r) => setTimeout(r, 300));
  console.log('resident loop stopped');
  await engine.close();
  process.exit(0);
}

async function cmdSubmit(args) {
  const text = args._.slice(1).join(' ');
  if (!text) throw new Error('submit needs text');
  // one-shot client: do not reclaim in-flight tasks, the resident process owns those
  const engine = await Engine.create({ echo: false, recover: false });
  const res = await engine.submit({
    text,
    source: args.flags.source || 'cli',
    threadId: args.flags.thread,
    author: args.flags.author || 'cli-user',
    groupId: args.flags.group,
    dedupeKey: args.flags.key
  });
  console.log('ingest: ' + JSON.stringify(res));
  if (res.decision === 'batched') {
    const t = await engine.tick({ force: true });
    console.log('tick  : ' + JSON.stringify(t));
  }
  await engine.drain();
  const tasks = engine.repo.listTasks(5);
  console.log('');
  console.log(table(tasks, [
    { label: 'task', get: (r) => r.id },
    { label: 'status', get: (r) => r.status },
    { label: 'origin', get: (r) => r.origin },
    { label: 'title', get: (r) => String(r.title || '').slice(0, 40) },
    { label: 'deliverable', get: (r) => (r.deliverable ? path.basename(r.deliverable) : '') }
  ]));
  await engine.close();
}

async function cmdStatus() {
  const cfg = loadConfig();
  const repo = openReadOnly(cfg);
  if (!repo) { console.log('no state yet at ' + cfg.dbPath); return; }
  console.log('db: ' + cfg.dbPath);
  console.log('');
  console.log('== tasks ==');
  console.log(table(repo.listTasks(15), [
    { label: 'id', get: (r) => r.id },
    { label: 'status', get: (r) => r.status },
    { label: 'origin', get: (r) => r.origin },
    { label: 'att', get: (r) => r.attempt },
    { label: 'title', get: (r) => String(r.title || '').slice(0, 44) }
  ]));
  console.log('');
  console.log('== triggers by status ==');
  console.log(table(repo.countTriggersByStatus(), [{ label: 'status', get: (r) => r.status }, { label: 'n', get: (r) => r.n }]));
  console.log('');
  console.log('== decisions ==');
  console.log(table(repo.listDecisions(10), [
    { label: 'id', get: (r) => r.id },
    { label: 'action', get: (r) => r.action },
    { label: 'n', get: (r) => JSON.parse(r.trigger_ids || '[]').length },
    { label: 'reason', get: (r) => String(r.reason || '').slice(0, 54) }
  ]));
  console.log('');
  console.log('== subscriptions ==');
  console.log(table(repo.listSubscriptions(10), [
    { label: 'thread', get: (r) => r.thread_id },
    { label: 'session', get: (r) => r.session_id },
    { label: 'status', get: (r) => r.status },
    { label: 'hits', get: (r) => r.hits }
  ]));
  const pending = repo.pendingHumanDecisions();
  console.log('');
  console.log('== pending human decisions: ' + pending.length + ' ==');
  for (const p of pending) console.log('  #' + p.id + ' ' + p.reason);
}

async function cmdLogs(args) {
  const cfg = loadConfig();
  const repo = openReadOnly(cfg);
  if (!repo) { console.log('no state yet at ' + cfg.dbPath); return; }
  const n = Number(args.flags.n || 30);
  const rows = args.flags.task ? repo.eventsForTask(args.flags.task, n) : repo.recentEvents(n);
  for (const e of rows) {
    const detail = e.detail ? String(e.detail).slice(0, 150) : '';
    console.log(new Date(e.ts).toISOString().slice(11, 23) + '  ' + String(e.kind).padEnd(22) + ' ' + String(e.actor || '').padEnd(10) + ' ' + (e.task_id || '').padEnd(14) + ' ' + detail);
  }
}

async function cmdWatch(args) {
  const cfg = loadConfig();
  const interval = Number(args.flags.interval || 1000);
  const repo = openReadOnly(cfg);
  if (!repo) { console.log('no state yet at ' + cfg.dbPath); return; }
  let after = repo.recentEvents(1)[0] ? repo.recentEvents(1)[0].id : 0;
  console.log('watching ' + cfg.dbPath + ' (ctrl-c to stop)');
  for (;;) {
    const rows = repo.recentEvents(50, after);
    for (const e of rows) {
      after = e.id;
      console.log(new Date(e.ts).toISOString().slice(11, 23) + '  ' + String(e.kind).padEnd(22) + ' ' + String(e.actor || '').padEnd(10) + ' ' + (e.task_id || ''));
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function cmdStop(args) {
  const cfg = loadConfig();
  const port = Number(args.flags.port || cfg.panel.port);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/stop', { method: 'POST' });
    console.log('panel stop -> ' + res.status);
    return;
  } catch {
    // panel not running: fall back to the persisted control flag
  }
  const repo = openReadOnly(cfg);
  if (!repo) { console.log('nothing to stop'); return; }
  repo.setControl('stop_requested', '1');
  repo.event({ kind: 'stop_requested', actor: 'cli' });
  console.log('stop flag set in db (the resident loop exits on its next tick)');
}

async function cmdUnsubscribe(args) {
  const target = args._.slice(1).join(' ').trim();
  if (!target) throw new Error('unsubscribe needs <subscriptionId|threadId>');
  const cfg = loadConfig();
  const repo = new Repo(openDb(cfg.dbPath));
  const rows = /^\\d+$/.test(target) ? [repo.closeSubscription(Number(target))] : repo.closeSubscriptionsByThread(target);
  const closed = rows.filter(Boolean).length;
  repo.event({ kind: 'unsubscribe', actor: 'cli', threadId: target, detail: { target, closed } });
  console.log('closed ' + closed + ' subscription(s) matching ' + target);
  repo.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.flags.help) { console.log(USAGE); return; }
  if (cmd === 'start') return cmdStart(args);
  if (cmd === 'submit') return cmdSubmit(args);
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'logs') return cmdLogs(args);
  if (cmd === 'watch') return cmdWatch(args);
  if (cmd === 'stop') return cmdStop(args);
  if (cmd === 'unsubscribe') return cmdUnsubscribe(args);
  if (cmd === 'demo') { await import('./demo.mjs'); return; }
  console.log('unknown command: ' + cmd);
  console.log(USAGE);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('error: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
