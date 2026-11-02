import fs from 'node:fs';
import { cleanDir, loadCopy, makeEngine, checker } from './lib.mjs';

/**
 * CASE D — Inline & Spill + chained recall.
 * Asserts on bytes: the spilled blob on disk must equal the original message byte for byte,
 * the context window must only carry a summary + resume id, and recall() must walk
 * message -> thread -> session -> task.
 */
const dir = cleanDir();
const ctx = await loadCopy(dir);
const T = checker('D', 'spill keeps full bytes on disk and recall walks the chain');

const { engine, stateDir } = await makeEngine(ctx, dir, 'p4-spill', { context: { spillThreshold: 1200, previewHead: 240, previewTail: 120 } });
const repo = engine.repo;

const sub = await engine.submit({ text: '@superagent 实现 上下文 缓存 报告', source: 'cli', threadId: 'thread_spill', author: 'bob' });
const tick = await engine.tick({ force: true });
await engine.drain();
const task = repo.getTask(tick.taskId);
T.eq('setup: task dispatched and finished', task.status, 'done');

const session = repo.getSession(task.session_id);
T.eq('setup: worker session exists', Boolean(session), true);

const BIG = ('A'.repeat(200) + '|') .repeat(15) + 'TAIL-END-1234567890';
T.check('setup: payload exceeds the spill threshold', BIG.length > 1200, { chars: BIG.length });

const rec = engine.ctx.appendMessage({
  sessionId: task.session_id,
  threadId: task.thread_id,
  role: 'tool',
  content: BIG,
  nextHop: { kind: 'session', id: task.session_id }
});

const row = repo.getMessage(rec.id);
T.eq('message is marked spilled', [rec.spilled, row.spilled], [true, 1]);
T.check('a blob path is recorded', Boolean(row.blob_path) && fs.existsSync(row.blob_path), { blob: row.blob_path });

const onDisk = fs.readFileSync(row.blob_path, 'utf8');
T.eq('blob bytes on disk == original message (byte identical)', [onDisk.length, Buffer.byteLength(onDisk, 'utf8')], [BIG.length, Buffer.byteLength(BIG, 'utf8')]);
T.check('blob content is identical, not just same length', onDisk === BIG);

const resumed = engine.ctx.readSpill(rec.id);
T.check('readSpill() returns the exact original bytes', resumed === BIG, { chars: resumed.length });

T.check('summary carries a resume hop with the message id', row.summary.includes('续读 hop: ' + rec.id + ' ->'), { summaryHead: row.summary.slice(0, 80) });
T.check('summary names the spill file', row.summary.includes(task.session_id + '/' + rec.id + '.md'));
T.check('summary states the original size', row.summary.includes('已落盘 ' + BIG.length + ' chars'), { sizeMarker: (row.summary.match(/〔已落盘 [0-9]+ chars〕/) || [null])[0], expectedChars: BIG.length });
T.check('summary is much smaller than the original', row.summary.length < 1200, { summaryChars: row.summary.length, originalChars: BIG.length });

const win = engine.ctx.inline(task.session_id, { budget: 5000, limit: 24 });
T.check('inline window renders the resume id for the spilled message', win.text.includes('续读 id=' + rec.id), { spilled: win.spilled });
T.check('inline window is bounded (does not contain the full payload)', win.chars < BIG.length, { inlineChars: win.chars, originalChars: BIG.length });

const chain = engine.ctx.recall('message', rec.id, { depth: 6 });
const kinds = chain.map((n) => n.kind);
console.log('--- recall chain --- ' + JSON.stringify(chain.map((n) => ({ kind: n.kind, id: n.id, next: n.next }))));
T.eq('recall walks message -> thread -> session -> task', kinds, ['message', 'thread', 'session', 'task']);
T.eq('recall ends on the task that owns the work', chain[chain.length - 1].id, task.id);
T.eq('the terminal task node reports the real status', chain[chain.length - 1].status, 'done');

const hops = repo.all('SELECT from_kind, to_kind, label FROM hops ORDER BY id');
const labels = hops.map((h) => h.from_kind + '.' + h.to_kind);
T.check('persisted hop edges exist for the chain', ['message.thread', 'message.session', 'thread.session', 'session.task'].every((l) => labels.includes(l)), { labels });

const small = engine.ctx.appendMessage({ sessionId: task.session_id, role: 'assistant', content: 'short note' });
T.eq('a short message stays inline (no spill)', [small.spilled, repo.getMessage(small.id).blob_path], [false, null]);

// resume snapshot: the spilled file must survive a fresh engine open on the same state dir
await engine.close();
const again = await ctx.Engine.create({ cfg: engine.cfg, echo: false });
const reread = again.ctx.readSpill(rec.id);
T.check('spill is still readable after a fresh engine opens the same state dir', reread === BIG, { chars: reread ? reread.length : null });
await again.close();

T.finish();
