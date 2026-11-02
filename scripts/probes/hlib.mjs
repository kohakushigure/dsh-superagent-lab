import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cleanDir, loadCopy, checker, sleep } from './lib.mjs';

export { cleanDir, loadCopy, checker, sleep };

/** Pick a free loopback port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

/**
 * Spawn the real resident loop from the clean copy and wait until /api/health answers.
 * Everything (state dir, logs) stays inside the clean copy, never in the original tree.
 */
export async function startResident(opts) {
  const o = opts || {};
  const port = o.port || await freePort();
  const stateDir = path.join(o.copyDir, 'verify-tmp', (o.name || 'hosted') + '-state');
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const env = Object.assign({}, process.env, {
    SUPERAGENT_STATE_DIR: stateDir,
    PANEL_PORT: String(port),
    LOG_LEVEL: o.logLevel || 'error'
  }, o.env || {});
  const proc = spawn(process.execPath, [path.join(o.copyDir, 'bin', 'superagent.mjs'), 'start', '--port', String(port)], {
    cwd: o.copyDir, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  const r = { proc, port, url: 'http://127.0.0.1:' + port, stateDir, out: '', err: '', exited: false };
  proc.stdout.on('data', (d) => { r.out += d.toString(); });
  proc.stderr.on('data', (d) => { r.err += d.toString(); });
  proc.on('exit', () => { r.exited = true; });
  const deadline = Date.now() + (o.timeoutMs || 20000);
  let healthy = false;
  while (Date.now() < deadline) {
    try { const h = await getJson(r.url + '/api/health', 1500); if (h.status === 200 && h.body && h.body.ok) { healthy = true; break; } } catch { /* not up yet */ }
    await sleep(120);
  }
  if (!healthy) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    throw new Error('resident did not become healthy on ' + r.url + '\nSTDOUT:\n' + r.out.slice(-1500) + '\nSTDERR:\n' + r.err.slice(-2500));
  }
  r.dbPath = path.join(stateDir, 'superagent.sqlite');
  r.stop = async () => {
    try { await postJson(r.url + '/api/stop', {}); } catch { /* ignore */ }
    const until = Date.now() + 8000;
    while (!r.exited && Date.now() < until) await sleep(80);
    if (!r.exited) { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
    await sleep(80);
    return r.exited;
  };
  r.kill = async () => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } const until = Date.now() + 4000; while (!r.exited && Date.now() < until) await sleep(50); return r.exited; };
  return r;
}

export async function getJson(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 5000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { _raw: text }; }
    return { status: res.status, body, text };
  } finally { clearTimeout(timer); }
}

export async function postJson(url, body, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 10000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: ac.signal });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
    return { status: res.status, body: parsed, text };
  } finally { clearTimeout(timer); }
}

export function openReadOnly(ctx, dbPath) {
  const db = ctx.openDb(dbPath, { migrate: false });
  return { repo: new ctx.Repo(db), close: () => { try { db.close(); } catch { /* ignore */ } } };
}

/**
 * OpenAI-compatible stub. Router model answers instantly with a dispatch decision;
 * the worker model answers after `workerDelayMs` with the next payload in the queue
 * (default: a final answer). Used to make concurrency and escape attempts deterministic.
 */
export async function startStub(opts) {
  const o = opts || {};
  const routerModel = o.routerModel || 'r-model';
  const workerModel = o.workerModel || 'w-model';
  const delay = o.workerDelayMs == null ? 300 : o.workerDelayMs;
  const queue = (o.workerPayloads || []).slice();
  const st = { calls: { router: 0, worker: 0 }, bodies: [], port: 0, url: null, closed: false };
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(data || '{}'); } catch { body = {}; }
      st.bodies.push({ model: body.model, head: String((body.messages || []).slice(-1).map((m) => m.content).join(' ')).slice(0, 200) });
      const isWorker = body.model === workerModel;
      const answer = async () => {
        if (isWorker) {
          st.calls.worker += 1;
          if (delay) await sleep(delay);
          const next = queue.length ? queue.shift() : JSON.stringify({ thought: 'stub done', final: { summary: 'stub worker done', deliverable: null } });
          return next;
        }
        st.calls.router += 1;
        return JSON.stringify({ action: 'dispatch', confidence: 0.9, reason: 'stub dispatch', title: 'stub task', intent: 'stub intent' });
      };
      try {
        const content = await answer();
        const payload = { id: 'stub-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message) }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  st.port = server.address().port;
  st.url = 'http://127.0.0.1:' + st.port + '/v1';
  st.close = () => new Promise((r) => { st.closed = true; server.close(() => r(true)); });
  return st;
}

/** Sample /api/state at a fixed cadence and record the peak concurrency window. */
export async function sampleConcurrency(url, durationMs, intervalMs) {
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < durationMs) {
    try {
      const s = await getJson(url + '/api/state', 2000);
      if (s.status === 200 && s.body && s.body.concurrency) samples.push({ at: Date.now() - t0, cap: s.body.concurrency.cap, inflight: s.body.concurrency.inflight, queued: s.body.concurrency.queued });
    } catch { /* skip a beat */ }
    await sleep(intervalMs || 40);
  }
  const peakInflight = samples.reduce((a, s) => Math.max(a, s.inflight), 0);
  const maxQueued = samples.reduce((a, s) => Math.max(a, s.queued), 0);
  const overCap = samples.filter((s) => Number.isFinite(s.cap) && s.inflight > s.cap);
  return { samples, peakInflight, maxQueued, overCap: overCap.length, cap: samples.length ? samples[samples.length - 1].cap : null };
}

export async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step || 60); }
  return null;
}
