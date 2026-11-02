import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length <= n ? str : str.slice(0, n) + '…(+' + (str.length - n) + ')';
}

/**
 * Tee logger: human-readable line to stdout + JSONL appended to <evidence>/run.jsonl,
 * so every run leaves reproducible evidence on disk without extra dependencies.
 */
export function createLogger(opts) {
  const o = opts || {};
  const threshold = LEVELS[o.level || 'info'] || 20;
  const echo = o.echo !== false;
  let stream = null;
  if (o.file) {
    fs.mkdirSync(path.dirname(o.file), { recursive: true });
    stream = fs.createWriteStream(o.file, { flags: 'a' });
  }
  const lines = [];

  function emit(lvl, msg, data) {
    if ((LEVELS[lvl] || 20) < threshold) return;
    const rec = { ts: new Date().toISOString(), level: lvl, msg };
    if (data !== undefined) rec.data = data;
    const line = JSON.stringify(rec);
    lines.push(rec);
    if (stream) stream.write(line + '\n');
    if (o.sink) o.sink(rec);
    if (echo) {
      const tail = data === undefined ? '' : ' ' + truncate(JSON.stringify(data), 900);
      const ts = rec.ts.slice(11, 23);
      const tag = ('[' + ts + ']').padEnd(16);
      const out = tag + lvl.toUpperCase().padEnd(5) + ' ' + msg + tail + '\n';
      if (lvl === 'error' || lvl === 'warn') process.stderr.write(out);
      else process.stdout.write(out);
    }
  }

  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    lines,
    async close() {
      if (stream) await new Promise((r) => stream.end(r));
    }
  };
}

/** In-memory logger for tests: keeps records, no I/O. */
export function memoryLogger() {
  const records = [];
  const mk = (lvl) => (m, d) => records.push({ level: lvl, msg: m, data: d });
  return { records, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), lines: records, async close() {} };
}
