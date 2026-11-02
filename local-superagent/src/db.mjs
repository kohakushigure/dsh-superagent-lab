import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function newId(prefix) {
  const t = Date.now().toString(36).slice(-5);
  const r = crypto.randomBytes(4).toString('hex');
  return (prefix ? prefix + '_' : '') + t + r;
}

export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, source TEXT, group_id TEXT, title TEXT, session_id TEXT, message_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS triggers (id TEXT PRIMARY KEY, source TEXT NOT NULL, group_id TEXT, thread_id TEXT, author TEXT, text TEXT NOT NULL, dedupe_key TEXT, status TEXT NOT NULL, reason TEXT, batch_id TEXT, task_id TEXT, created_at INTEGER NOT NULL, processed_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_triggers_status ON triggers(status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_triggers_dedupe ON triggers(dedupe_key, created_at)",
  "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, intent TEXT, status TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'router', session_id TEXT, thread_id TEXT, workdir TEXT, trigger_ids TEXT, deliverable TEXT, summary TEXT, attempt INTEGER NOT NULL DEFAULT 1, runs INTEGER NOT NULL DEFAULT 0, progress_at INTEGER, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at)",
  "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, role TEXT NOT NULL, task_id TEXT, thread_id TEXT, model TEXT, status TEXT, summary TEXT, tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, task_id TEXT NOT NULL, session_id TEXT, worker_id TEXT, status TEXT NOT NULL DEFAULT 'active', hits INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, closed_at INTEGER)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_thread ON subscriptions(thread_id, task_id)",
  "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, thread_id TEXT, role TEXT NOT NULL, content TEXT, spilled INTEGER NOT NULL DEFAULT 0, blob_path TEXT, summary TEXT, next_hop TEXT, seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq)",
  "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT, task_id TEXT, thread_id TEXT, detail TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id)",
  "CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, ts)",
  "CREATE TABLE IF NOT EXISTS hops (id INTEGER PRIMARY KEY AUTOINCREMENT, from_kind TEXT NOT NULL, from_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_hops_from ON hops(from_kind, from_id)",
  "CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, router_session_id TEXT, trigger_ids TEXT NOT NULL, action TEXT NOT NULL, policy TEXT, reason TEXT, payload TEXT, latency_ms INTEGER NOT NULL DEFAULT 0, resolved INTEGER NOT NULL DEFAULT 0, resolution TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_decisions_action ON decisions(action, resolved)",
  "CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, speaker TEXT NOT NULL, thread_id TEXT, task_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS control (key TEXT PRIMARY KEY, value TEXT)"
];

export function openDb(dbPath, opts) {
  const o = opts || {};
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = OFF');
  if (o.migrate !== false) {
    for (const sql of SCHEMA) db.exec(sql);
    const cols = db.prepare("PRAGMA table_info('tasks')").all().map((r) => r.name);
    if (!cols.includes('project')) db.exec('ALTER TABLE tasks ADD COLUMN project TEXT');
  }
  return db;
}

export function j(v) {
  return v == null ? null : JSON.stringify(v);
}
export function pj(v, fallback) {
  if (v == null || v === '') return fallback === undefined ? null : fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback === undefined ? null : fallback;
  }
}

/** Thin data-access layer: all SQL lives here so the rest of the code stays testable. */
export class Repo {
  constructor(db) {
    this.db = db;
    this.stmt = new Map();
  }

  q(sql) {
    let s = this.stmt.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmt.set(sql, s);
    }
    return s;
  }

  run(sql, ...args) { return this.q(sql).run(...args); }
  get(sql, ...args) { return this.q(sql).get(...args); }
  all(sql, ...args) { return this.q(sql).all(...args); }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  // ---- threads -----------------------------------------------------------
  upsertThread(rec) {
    this.run(
      "INSERT INTO threads (id, source, group_id, title, session_id, message_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET message_count = message_count + 1, updated_at = excluded.updated_at, session_id = COALESCE(excluded.session_id, threads.session_id)",
      rec.id, rec.source || null, rec.groupId || null, rec.title || null, rec.sessionId || null, 1, rec.now, rec.now
    );
    return this.get('SELECT * FROM threads WHERE id = ?', rec.id);
  }
  setThreadSession(threadId, sessionId) {
    this.run('UPDATE threads SET session_id = ?, updated_at = ? WHERE id = ?', sessionId, Date.now(), threadId);
  }
  getThread(threadId) { return this.get('SELECT * FROM threads WHERE id = ?', threadId); }

  // ---- triggers ----------------------------------------------------------
  insertTrigger(t) {
    this.run(
      'INSERT INTO triggers (id, source, group_id, thread_id, author, text, dedupe_key, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      t.id, t.source, t.groupId || null, t.threadId || null, t.author || null, t.text, t.dedupeKey || null, t.status || 'pending', t.now
    );
    return this.getTrigger(t.id);
  }
  getTrigger(id) { return this.get('SELECT * FROM triggers WHERE id = ?', id); }
  setTriggerStatus(id, status, extra) {
    const e = extra || {};
    this.run('UPDATE triggers SET status = ?, reason = ?, batch_id = ?, task_id = ?, processed_at = ? WHERE id = ?',
      status, e.reason || null, e.batchId || null, e.taskId || null, e.processedAt || Date.now(), id);
  }
  pendingTriggers(limit) {
    const n = limit || 100;
    return this.all("SELECT * FROM triggers WHERE status IN ('pending','batched') ORDER BY created_at ASC, id ASC LIMIT ?", n);
  }
  recentTriggers(limit) { return this.all('SELECT * FROM triggers ORDER BY created_at DESC LIMIT ?', limit || 50); }
  countTriggersByStatus() {
    return this.all('SELECT status, COUNT(*) AS n FROM triggers GROUP BY status');
  }
  findByDedupe(dedupeKey, sinceTs, excludeId) {
    return this.get(
      'SELECT * FROM triggers WHERE dedupe_key = ? AND created_at >= ? AND id <> ? ORDER BY created_at DESC LIMIT 1',
      dedupeKey, sinceTs, excludeId == null ? '' : excludeId
    );
  }
  countTriggersSince(source, sinceTs) {
    return this.get('SELECT COUNT(*) AS n FROM triggers WHERE source = ? AND created_at >= ?', source, sinceTs).n;
  }

  // ---- tasks -------------------------------------------------------------
  createTask(t) {
    const now = t.now || Date.now();
    this.run(
      'INSERT INTO tasks (id, title, intent, status, origin, session_id, thread_id, workdir, trigger_ids, attempt, runs, progress_at, created_at, updated_at, project) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      t.id, t.title || '(untitled)', t.intent || null, t.status || 'queued', t.origin || 'router',
      t.sessionId || null, t.threadId || null, t.workdir || null, j(t.triggerIds || []), t.attempt || 1, 0, now, now, now, t.project || null
    );
    return this.getTask(t.id);
  }
  getTask(id) { return this.get('SELECT * FROM tasks WHERE id = ?', id); }
  updateTask(id, patch) {
    const cols = Object.keys(patch);
    if (!cols.length) return this.getTask(id);
    const sets = cols.map((c) => c + ' = ?').join(', ');
    const vals = cols.map((c) => patch[c]);
    vals.push(Date.now());
    this.run('UPDATE tasks SET ' + sets + ', updated_at = ? WHERE id = ?', ...vals, id);
    return this.getTask(id);
  }
  listTasks(limit, statuses) {
    if (statuses && statuses.length) {
      const marks = statuses.map(() => '?').join(',');
      return this.all('SELECT * FROM tasks WHERE status IN (' + marks + ') ORDER BY created_at DESC LIMIT ?', ...statuses, limit || 50);
    }
    return this.all('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?', limit || 50);
  }
  inFlightTasks() {
    return this.all("SELECT * FROM tasks WHERE status IN ('queued','running','stalled') ORDER BY created_at ASC");
  }
  countTasksByStatus() {
    return this.all('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status');
  }

  // ---- sessions ----------------------------------------------------------
  createSession(s) {
    const now = s.now || Date.now();
    this.run('INSERT INTO sessions (id, role, task_id, thread_id, model, status, summary, tokens, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      s.id, s.role, s.taskId || null, s.threadId || null, s.model || null, s.status || 'active', s.summary || null, 0, now, now);
    return this.getSession(s.id);
  }
  getSession(id) { return this.get('SELECT * FROM sessions WHERE id = ?', id); }
  updateSession(id, patch) {
    const cols = Object.keys(patch);
    if (!cols.length) return this.getSession(id);
    const sets = cols.map((c) => c + ' = ?').join(', ');
    const vals = cols.map((c) => patch[c]);
    vals.push(Date.now());
    this.run('UPDATE sessions SET ' + sets + ', updated_at = ? WHERE id = ?', ...vals, id);
    return this.getSession(id);
  }
  listSessions(limit) { return this.all('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?', limit || 50); }

  // ---- messages ----------------------------------------------------------
  insertMessage(m) {
    const seqRow = this.get('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages WHERE session_id = ?', m.sessionId);
    const seq = seqRow ? seqRow.s : 1;
    this.run('INSERT INTO messages (id, session_id, thread_id, role, content, spilled, blob_path, summary, next_hop, seq, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      m.id, m.sessionId, m.threadId || null, m.role, m.content || '', m.spilled ? 1 : 0, m.blobPath || null, m.summary || null, j(m.nextHop), seq, m.now || Date.now());
    return this.getMessage(m.id);
  }
  getMessage(id) { return this.get('SELECT * FROM messages WHERE id = ?', id); }
  listMessages(sessionId, limit) {
    const rows = this.all('SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?', sessionId, limit || 50);
    return rows.reverse();
  }
  countMessages(sessionId) {
    return this.get('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', sessionId).n;
  }

  // ---- subscriptions -----------------------------------------------------
  subscribe(rec) {
    this.run('INSERT INTO subscriptions (thread_id, task_id, session_id, worker_id, status, hits, created_at) VALUES (?,?,?,?,?,0,?) ON CONFLICT(thread_id, task_id) DO UPDATE SET status = excluded.status, session_id = excluded.session_id',
      rec.threadId, rec.taskId, rec.sessionId || null, rec.workerId || null, rec.status || 'active', rec.now || Date.now());
    return this.findSubscription(rec.threadId);
  }
  findSubscription(threadId) {
    return this.all("SELECT * FROM subscriptions WHERE thread_id = ? AND status = 'active' ORDER BY id ASC", threadId);
  }
  bumpSubscription(id) { this.run('UPDATE subscriptions SET hits = hits + 1 WHERE id = ?', id); return this.get('SELECT * FROM subscriptions WHERE id = ?', id); }
  closeSubscription(id) {
    this.run("UPDATE subscriptions SET status = 'closed', closed_at = ? WHERE id = ?", Date.now(), id);
    return this.get('SELECT * FROM subscriptions WHERE id = ?', id);
  }
  closeSubscriptionsByThread(threadId) {
    this.run("UPDATE subscriptions SET status = 'closed', closed_at = ? WHERE thread_id = ? AND status = 'active'", Date.now(), threadId);
    return this.all('SELECT * FROM subscriptions WHERE thread_id = ?', threadId);
  }
  closeSubscriptionsForTask(taskId) { this.run("UPDATE subscriptions SET status = 'closed', closed_at = ? WHERE task_id = ? AND status = 'active'", Date.now(), taskId); }
  listSubscriptions(limit) { return this.all('SELECT * FROM subscriptions ORDER BY id DESC LIMIT ?', limit || 50); }

  // ---- events ------------------------------------------------------------
  event(rec) {
    this.run('INSERT INTO events (ts, kind, actor, task_id, thread_id, detail) VALUES (?,?,?,?,?,?)',
      rec.ts || Date.now(), rec.kind, rec.actor || 'system', rec.taskId || null, rec.threadId || null, j(rec.detail));
  }
  eventsForTask(taskId, limit) { return this.all('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?', taskId, limit || 100); }
  recentEvents(limit, afterId) {
    if (afterId) return this.all('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?', afterId, limit || 100);
    const rows = this.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit || 50);
    return rows.reverse();
  }
  countEvents(kind, sinceTs) {
    return this.get('SELECT COUNT(*) AS n FROM events WHERE kind = ? AND ts >= ?', kind, sinceTs || 0).n;
  }

  // ---- hops --------------------------------------------------------------
  hop(rec) {
    this.run('INSERT INTO hops (from_kind, from_id, to_kind, to_id, label, created_at) VALUES (?,?,?,?,?,?)',
      rec.fromKind, rec.fromId, rec.toKind, rec.toId, rec.label || null, Date.now());
  }
  hopsFrom(kind, id) { return this.all('SELECT * FROM hops WHERE from_kind = ? AND from_id = ? ORDER BY id ASC', kind, id); }

  // ---- decisions ---------------------------------------------------------
  decide(rec) {
    const r = this.run('INSERT INTO decisions (batch_id, router_session_id, trigger_ids, action, policy, reason, payload, latency_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      rec.batchId, rec.routerSessionId || null, j(rec.triggerIds || []), rec.action, rec.policy || 'slow', rec.reason || null, j(rec.payload || null), rec.latencyMs || 0, rec.now || Date.now());
    return this.get('SELECT * FROM decisions ORDER BY id DESC LIMIT 1');
  }
  resolveDecision(id, resolution) {
    this.run('UPDATE decisions SET resolved = 1, resolution = ?, resolved_at = ? WHERE id = ?', resolution, Date.now(), id);
    return this.get('SELECT * FROM decisions WHERE id = ?', id);
  }
  pendingHumanDecisions() { return this.all("SELECT * FROM decisions WHERE action = 'need_human' AND resolved = 0 ORDER BY id DESC"); }
  listDecisions(limit) { return this.all('SELECT * FROM decisions ORDER BY id DESC LIMIT ?', limit || 50); }
  countDecisions(action) {
    if (action) return this.get('SELECT COUNT(*) AS n FROM decisions WHERE action = ?', action).n;
    return this.get('SELECT COUNT(*) AS n FROM decisions').n;
  }
  batchSizes() {
    return this.all('SELECT batch_id, json_array_length(trigger_ids) AS n FROM decisions ORDER BY id DESC LIMIT 200');
  }

  // ---- outbox / control --------------------------------------------------
  say(rec) {
    this.run('INSERT INTO outbox (speaker, thread_id, task_id, text, created_at) VALUES (?,?,?,?,?)', rec.speaker, rec.threadId || null, rec.taskId || null, rec.text, Date.now());
    return this.get('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
  }
  outbox(limit) { return this.all('SELECT * FROM outbox ORDER BY id DESC LIMIT ?', limit || 20); }
  setControl(key, value) {
    this.run('INSERT INTO control (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }
  getControl(key) {
    const r = this.get('SELECT value FROM control WHERE key = ?', key);
    return r ? r.value : null;
  }
  delControl(key) { this.run('DELETE FROM control WHERE key = ?', key); }

  // ---- retention ---------------------------------------------------------
  /**
   * 按天清理历史：只删“已终结”的触发器与纯日志类表，任务/会话/订阅/决策永不删除。
   * 返回每张表删掉的行数，便于写进事件日志做审计。
   */
  pruneBefore(cutoffMs) {
    const before = { cutoffMs };
    const runCount = (sql, ...params) => { const r = this.run(sql, ...params); return r && typeof r.changes === 'number' ? r.changes : 0; };
    before.triggers = runCount(
      "DELETE FROM triggers WHERE created_at < ? AND status IN ('dropped','ignored','dispatched','passthrough')",
      cutoffMs
    );
    before.events = runCount('DELETE FROM events WHERE ts < ?', cutoffMs);
    before.messages = runCount('DELETE FROM messages WHERE created_at < ?', cutoffMs);
    before.hops = runCount('DELETE FROM hops WHERE created_at < ?', cutoffMs);
    before.outbox = runCount('DELETE FROM outbox WHERE created_at < ?', cutoffMs);
    return before;
  }
}
