import fs from 'node:fs';
import path from 'node:path';
import { newId, pj } from './db.mjs';
import { truncate } from './log.mjs';

/**
 * Context-as-cache: Inline & Spill + chained recall.
 *
 * Rule 1 (Inline & Spill): anything above CONTEXT_SPILL_THRESHOLD characters is written
 * to <state>/spill/<session>/<message>.md and the context only keeps a head/tail summary
 * plus a resume handle. The full bytes stay on disk and are re-readable with one call,
 * so in-context size is bounded while nothing is lost.
 *
 * Rule 2 (chained recall): every object embeds the id of the next object to look at:
 * message -> thread -> session -> task -> deliverable. `recall()` walks that chain.
 */
export class ContextStore {
  constructor(opts) {
    const o = opts || {};
    this.repo = o.repo;
    this.cfg = o.cfg;
    this.logger = o.logger;
    this.spillDir = o.spillDir || o.cfg.spillDir;
    this.threshold = o.cfg.context.spillThreshold;
    this.clock = o.clock || (() => Date.now());
    this.spillBytes = 0;
    this.spillCount = 0;
  }

  appendMessage(m) {
    const id = m.id || newId('msg');
    const content = m.content == null ? '' : String(m.content);
    let spilled = false;
    let blobPath = null;
    let summary = null;
    if (content.length > this.threshold) {
      blobPath = this.spill(id, m.sessionId, content);
      summary = this.summarize(content, blobPath, id);
      spilled = true;
      this.spillCount += 1;
      this.spillBytes += Buffer.byteLength(content, 'utf8');
    }
    const nextHop = m.nextHop || (m.threadId ? { kind: 'thread', id: m.threadId } : { kind: 'session', id: m.sessionId });
    this.repo.insertMessage({
      id,
      sessionId: m.sessionId,
      threadId: m.threadId,
      role: m.role,
      content,
      spilled,
      blobPath,
      summary,
      nextHop,
      now: this.clock()
    });
    if (m.threadId) this.repo.hop({ fromKind: 'message', fromId: id, toKind: 'thread', toId: m.threadId, label: 'message.thread' });
    this.repo.hop({ fromKind: 'message', fromId: id, toKind: 'session', toId: m.sessionId, label: 'message.session' });
    return { id, spilled, blobPath, inlineChars: spilled ? summary.length : content.length, fullChars: content.length };
  }

  spill(messageId, sessionId, content) {
    const dir = path.join(this.spillDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, messageId + '.md');
    fs.writeFileSync(file, content, 'utf8');
    return file;
  }

  summarize(content, blobPath, messageId) {
    const head = content.slice(0, this.cfg.context.previewHead);
    const tail = content.slice(-this.cfg.context.previewTail);
    const spilledMark = '…〔已落盘 ' + content.length + ' chars〕';
    const resumeMark = '〔续读 hop: ' + messageId + ' -> ' + path.basename(path.dirname(blobPath)) + '/' + messageId + '.md〕';
    return [head.replace(/\s+$/, ''), spilledMark, tail.replace(/^\s+/, ''), resumeMark].join('\n');
  }

  /** Full bytes for a spilled message (the resume entry point). */
  readSpill(messageId) {
    const msg = this.repo.getMessage(messageId);
    if (!msg) return null;
    if (!msg.spilled) return msg.content;
    try {
      return fs.readFileSync(msg.blob_path, 'utf8');
    } catch (err) {
      if (this.logger) this.logger.warn('context.spill_missing', { messageId, error: String(err.message) });
      return null;
    }
  }

  /** Bounded prompt block for a session; spilled messages render as summary + resume handle. */
  inline(sessionId, opts) {
    const o = opts || {};
    const limit = o.limit || this.cfg.context.windowMessages;
    const rows = this.repo.listMessages(sessionId, limit);
    const budget = o.budget || 6000;
    const lines = [];
    let used = 0;
    let spilled = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i];
      const body = r.spilled ? r.summary : r.content;
      if (used + body.length > budget && lines.length) continue;
      used += body.length;
      if (r.spilled) spilled += 1;
      const hop = r.spilled ? ' (续读 id=' + r.id + ')' : '';
      lines.push('[' + r.role + ']' + hop + ' ' + body);
    }
    lines.reverse();
    return { text: lines.join('\n\n'), chars: used, messages: rows.length, spilled };
  }

  /** Persisted chain edge: from -> to. */
  link(fromKind, fromId, toKind, toId, label) {
    this.repo.hop({ fromKind, fromId, toKind, toId, label: label || fromKind + '.' + toKind });
  }

  /** Walk message -> thread -> session -> task; each node carries a `next` pointer. */
  recall(kind, id, opts) {
    const o = opts || {};
    const maxDepth = o.depth || 5;
    const nodes = [];
    const seen = new Set();
    let cur = { kind, id };
    while (cur && cur.id && nodes.length < maxDepth) {
      const key = cur.kind + ':' + cur.id;
      if (seen.has(key)) break;
      seen.add(key);
      const node = this.loadNode(cur.kind, cur.id);
      if (!node) break;
      nodes.push(node);
      cur = node.next;
    }
    return nodes;
  }

  loadNode(kind, id) {
    const hops = this.repo.hopsFrom(kind, id);
    if (kind === 'message') {
      const m = this.repo.getMessage(id);
      if (!m) return null;
      const text = m.spilled ? m.summary : m.content;
      return {
        kind: 'message',
        id: m.id,
        role: m.role,
        spilled: Boolean(m.spilled),
        chars: (m.content || '').length,
        text: truncate(text, 800),
        blob: m.blob_path,
        next: this.nextFrom(hops) || pj(m.next_hop, null)
      };
    }
    if (kind === 'thread') {
      const t = this.repo.getThread(id);
      if (!t) return null;
      const recent = this.repo.all('SELECT text, author FROM triggers WHERE thread_id = ? ORDER BY created_at DESC LIMIT 3', id);
      return {
        kind: 'thread',
        id: t.id,
        title: t.title,
        source: t.source,
        messageCount: t.message_count,
        text: recent.map((r) => '(' + (r.author || '?') + ') ' + truncate(r.text, 160)).join(' | '),
        next: this.nextFrom(hops) || (t.session_id ? { kind: 'session', id: t.session_id } : null)
      };
    }
    if (kind === 'session') {
      const s = this.repo.getSession(id);
      if (!s) return null;
      return {
        kind: 'session',
        id: s.id,
        role: s.role,
        model: s.model,
        summary: s.summary,
        messages: this.repo.countMessages(s.id),
        text: truncate(s.summary || '', 600),
        next: this.nextFrom(hops) || (s.task_id ? { kind: 'task', id: s.task_id } : null)
      };
    }
    if (kind === 'task') {
      const t = this.repo.getTask(id);
      if (!t) return null;
      return {
        kind: 'task',
        id: t.id,
        title: t.title,
        status: t.status,
        deliverable: t.deliverable,
        workdir: t.workdir,
        text: truncate(t.summary || '', 600),
        next: null
      };
    }
    return null;
  }

  nextFrom(hops) {
    const hop = (hops || []).find((h) => h.to_id);
    if (!hop) return null;
    return { kind: hop.to_kind, id: hop.to_id };
  }

  stats() {
    return { spills: this.spillCount, spillBytes: this.spillBytes, threshold: this.threshold };
  }
}
