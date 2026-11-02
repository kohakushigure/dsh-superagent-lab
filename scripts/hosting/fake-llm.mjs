#!/usr/bin/env node
/**
 * fake-llm.mjs — a deliberately slow, deliberately unreliable OpenAI-compatible stub.
 *
 * Why: local-superagent's offline brain (src/mock.mjs) answers instantly, so nothing about
 * "does MAX_CONCURRENCY actually bound anything under real model latency" can be measured
 * with it. This stub speaks the same wire protocol as a real gateway
 * (POST /v1/chat/completions) and injects delay / jitter / failures, so the concurrency,
 * queueing and retry behaviour of the real adapter path can be observed.
 *
 * The answer bodies are not guesses: they mirror exactly what local-superagent parses.
 *   - Router (src/filter.mjs DEFAULT_POLICY + slowPath) parses
 *       {"action":"dispatch|ignore|need_human","confidence":n,"reason":s,"title":s,"intent":s}
 *   - Worker (src/worker.mjs WORKER_SYSTEM + the STEP n/m prompt line) parses
 *       {"thought":s,"tool":"fs.write","args":{path,content}}  or
 *       {"thought":s,"final":{summary,deliverable}}
 *   - src/llm.mjs reads data.choices[0].message.content (a *string*) and data.model.
 *
 * Zero dependencies. Node 24.
 *
 * Usage:
 *   node scripts/hosting/fake-llm.mjs --port 18900 --delay-ms 1500 --jitter-ms 0 \
 *        --fail-rate 0 --fail-role all|router|worker --worker-steps 1 --log <file> --summary <file>
 *
 * Endpoints:
 *   POST /v1/chat/completions   the model
 *   GET  /v1/models             minimal model list (some clients probe it)
 *   GET  /__stats               live counters (calls, failures, inflight, peak)
 *   POST /__reset               zero the counters (used between measurement runs)
 *   POST /__shutdown            write the summary file and exit
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function parseArgs(argv) {
  const out = {
    port: 18900, delayMs: 0, jitterMs: 0, failRate: 0, failRole: 'all',
    workerSteps: 1, log: '', summary: '', model: 'fake-slow-model'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next && !next.startsWith('--') ? (i += 1, next) : 'true';
    if (key === 'port') out.port = Number(val);
    else if (key === 'delay-ms') out.delayMs = Number(val);
    else if (key === 'jitter-ms') out.jitterMs = Number(val);
    else if (key === 'fail-rate') out.failRate = Number(val);
    else if (key === 'fail-role') out.failRole = String(val);
    else if (key === 'worker-steps') out.workerSteps = Number(val);
    else if (key === 'model') out.model = String(val);
    else if (key === 'log') out.log = String(val);
    else if (key === 'summary') out.summary = String(val);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args.log) fs.mkdirSync(path.dirname(path.resolve(args.log)), { recursive: true });
const logStream = args.log ? fs.createWriteStream(args.log, { flags: 'a' }) : null;
function logLine(obj) {
  const line = JSON.stringify(obj);
  if (logStream) logStream.write(line + '\n');
  process.stdout.write(line + '\n');
}

const counters = {
  startedAt: Date.now(),
  requests: 0,
  byRole: { router: 0, worker: 0, unknown: 0 },
  failures: 0,
  failuresByStatus: {},
  inflight: 0,
  peakInflight: 0,
  latency: { sum: 0, max: 0 },
  promptTokens: 0,
  completionTokens: 0
};

/** Router role is identified by the policy sentence src/filter.mjs sends as the system message. */
function detectRole(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = msgs.filter((m) => m && m.role === 'system').map((m) => String(m.content || '')).join('\n');
  if (/slow-path semantic filter/i.test(sys)) return 'router';
  if (/You are a worker of a Super-agent/i.test(sys)) return 'worker';
  return 'unknown';
}

function lastUserText(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i] && msgs[i].role === 'user') return String(msgs[i].content || '');
  }
  return '';
}

function cleanTitle(text) {
  const s = String(text || '').replace(/@superagent|@agent|\/agent/gi, '').replace(/\s+/g, ' ').trim();
  return s.length > 72 ? s.slice(0, 72) + '…' : (s || 'untitled request');
}

/** Router answer: one decision for one thread's batch, same JSON shape src/filter.mjs parses. */
function routerAnswer(body) {
  const prompt = lastUserText(body);
  const batchBlock = prompt.split('BATCH (')[1] || prompt;
  const lines = batchBlock.split('\n').filter((l) => /^\d+\.\s/.test(l.trim()));
  const first = lines.length ? lines[0].replace(/^\s*\d+\.\s*/, '') : prompt;
  const text = first.replace(/^\[[^\]]*\]\s*/, '').replace(/^[^:]*:\s*/, '');
  return {
    action: 'dispatch',
    confidence: 0.9,
    reason: 'policy: actionable work request (' + (lines.length || 1) + ' event(s), fake-llm)',
    title: cleanTitle(text),
    intent: String(text).slice(0, 400)
  };
}

/** Worker answer: WORKER_STEPS tool calls, then a final that names the deliverable. */
function workerAnswer(body) {
  const prompt = lastUserText(body);
  const m = prompt.match(/STEP\s+(\d+)\/(\d+)/);
  const step = m ? Number(m[1]) - 1 : 0;
  const taskLine = (prompt.match(/TASK:\s*(.+)/) || [])[1] || 'task';
  const body_ = [
    '# ' + String(taskLine).trim(),
    '',
    'generated by scripts/hosting/fake-llm.mjs under a synthetic latency budget',
    '',
    '## Request',
    '',
    (prompt.match(/REQUEST:\s*([\s\S]*?)\n\n/) || [])[1] ? String((prompt.match(/REQUEST:\s*([\s\S]*?)\n\n/) || [])[1]).trim().slice(0, 400) : '',
    '',
    '## Status',
    '',
    'done'
  ].join('\n');
  if (step < args.workerSteps) {
    return { thought: 'write the deliverable (step ' + (step + 1) + ')', tool: 'fs.write', args: { path: 'deliverable.md', content: body_ } };
  }
  return {
    thought: 'the deliverable exists; finish',
    final: { summary: 'deliverable.md written for: ' + String(taskLine).trim(), deliverable: 'deliverable.md' }
  };
}

function replyFor(body, role) {
  const answer = role === 'router' ? routerAnswer(body) : (role === 'worker' ? workerAnswer(body) : { action: 'ignore', reason: 'unknown role' });
  return JSON.stringify(answer);
}

function sendJson(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function writeSummary(why) {
  const s = {
    role: 'fake-llm',
    stoppedBy: why,
    port: args.port,
    delayMs: args.delayMs,
    jitterMs: args.jitterMs,
    failRate: args.failRate,
    failRole: args.failRole,
    workerSteps: args.workerSteps,
    wallMs: Date.now() - counters.startedAt,
    requests: counters.requests,
    byRole: counters.byRole,
    failures: counters.failures,
    failuresByStatus: counters.failuresByStatus,
    peakInflight: counters.peakInflight,
    avgLatencyMs: counters.requests ? Math.round(counters.latency.sum / counters.requests) : 0,
    maxLatencyMs: counters.latency.max,
    promptTokens: counters.promptTokens,
    completionTokens: counters.completionTokens
  };
  const text = JSON.stringify(s, null, 2);
  if (args.summary) {
    fs.mkdirSync(path.dirname(path.resolve(args.summary)), { recursive: true });
    fs.writeFileSync(args.summary, text + '\n');
  }
  process.stdout.write('[fake-llm] ' + text.replace(/\n/g, ' ') + '\n');
  return s;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return sendJson(res, 200, { object: 'list', data: [{ id: args.model, object: 'model', owned_by: 'fake-llm' }] });
  }
  if (req.method === 'GET' && url.pathname === '/__stats') {
    return sendJson(res, 200, { ...counters, port: args.port });
  }
  if (req.method === 'POST' && url.pathname === '/__reset') {
    counters.requests = 0;
    counters.byRole = { router: 0, worker: 0, unknown: 0 };
    counters.failures = 0;
    counters.failuresByStatus = {};
    counters.peakInflight = counters.inflight;
    counters.latency = { sum: 0, max: 0 };
    counters.promptTokens = 0;
    counters.completionTokens = 0;
    counters.startedAt = Date.now();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/__shutdown') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => { writeSummary('http'); if (logStream) logStream.end(); process.exit(0); }, 50);
    return undefined;
  }

  if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    return sendJson(res, 404, { error: { message: 'not found: ' + url.pathname, type: 'invalid_request_error' } });
  }

  return handleChat(req, res);
});

async function handleChat(req, res) {
  const started = Date.now();
  const body = await readBody(req);
  const role = detectRole(body);
  const stepMatch = lastUserText(body).match(/STEP\s+(\d+)\/(\d+)/);
  counters.requests += 1;
  counters.byRole[role] += 1;
  counters.inflight += 1;
  if (counters.inflight > counters.peakInflight) counters.peakInflight = counters.inflight;

  const willFail = args.failRate > 0 && (args.failRole === 'all' || args.failRole === role)
    && Math.random() < args.failRate;
  const jitter = args.jitterMs > 0 ? Math.floor(Math.random() * args.jitterMs) : 0;
  const waited = Math.max(0, args.delayMs + jitter);

  try {
    await sleep(waited);
    const latency = Date.now() - started;
    counters.latency.sum += latency;
    if (latency > counters.latency.max) counters.latency.max = latency;

    if (willFail) {
      // 429 and 500 are both retryable in src/llm.mjs (status===429 || status>=500)
      const status = Math.random() < 0.5 ? 429 : 500;
      counters.failures += 1;
      counters.failuresByStatus[status] = (counters.failuresByStatus[status] || 0) + 1;
      logLine({ t: new Date().toISOString(), role, step: stepMatch ? Number(stepMatch[1]) : null, status, fail: true, latencyMs: latency, waitedMs: waited });
      return sendJson(res, status, {
        error: { message: 'synthetic failure injected by fake-llm (' + status + ')', type: 'server_error', code: status }
      });
    }

    const content = replyFor(body, role);
    const promptTokens = Math.max(1, Math.round(JSON.stringify(body.messages || []).length / 4));
    const completionTokens = Math.max(1, Math.round(content.length / 4));
    counters.promptTokens += promptTokens;
    counters.completionTokens += completionTokens;
    logLine({
      t: new Date().toISOString(),
      role,
      step: stepMatch ? Number(stepMatch[1]) : null,
      status: 200,
      fail: false,
      latencyMs: latency,
      waitedMs: waited,
      inflight: counters.inflight
    });
    return sendJson(res, 200, {
      id: 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || args.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
    });
  } finally {
    counters.inflight -= 1;
  }
}

server.listen(args.port, '127.0.0.1', () => {
  logLine({
    t: new Date().toISOString(),
    event: 'listening',
    url: 'http://127.0.0.1:' + args.port + '/v1',
    delayMs: args.delayMs,
    jitterMs: args.jitterMs,
    failRate: args.failRate,
    failRole: args.failRole,
    workerSteps: args.workerSteps
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    writeSummary(sig);
    if (logStream) logStream.end();
    process.exit(0);
  });
}
