import http from 'node:http';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const CSS = [
  'body{background:#0d1117;color:#c9d1d9;font:13px/1.6 ui-monospace,Consolas,monospace;margin:24px}',
  'h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:26px 0 8px;color:#58a6ff}',
  'table{border-collapse:collapse;width:100%;margin-bottom:8px}',
  'th,td{border-bottom:1px solid #21262d;padding:4px 8px;text-align:left;vertical-align:top}',
  'th{color:#8b949e;font-weight:500}.m{color:#8b949e}',
  'button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:1px 8px;cursor:pointer}'
].join('');

/**
 * HTTP panel (loopback by default). A read view over the SQLite state plus two control
 * actions: resolve a pending human decision, retry a task.
 */
export function createPanel(opts) {
  const o = opts || {};
  const engine = o.engine;
  const cfg = engine.cfg;
  const repo = engine.repo;
  let server = null;

  function state() {
    return {
      ok: true,
      llmMode: engine.llm.mode,
      passthrough: cfg.passthrough.enabled,
      metrics: engine.metrics(),
      pending: repo.pendingHumanDecisions().map((d) => ({
        id: d.id,
        reason: d.reason,
        createdAt: d.created_at,
        triggers: d.trigger_ids
      })),
      concurrency: { cap: engine.metrics().router.concurrencyCap, inflight: engine.router.inflight.size, queued: engine.router.queue.length },
      tasks: repo.listTasks(20).map((t) => ({
        id: t.id, title: t.title, status: t.status, origin: t.origin, attempt: t.attempt, project: t.project,
        deliverable: t.deliverable, updatedAt: t.updated_at
      })),
      subscriptions: repo.listSubscriptions(20).map((s) => ({
        thread: s.thread_id, task: s.task_id, session: s.session_id, status: s.status, hits: s.hits
      })),
      events: repo.recentEvents(15).map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, actor: e.actor, task: e.task_id }))
    };
  }

  function tableRows(arr, cols) {
    return arr.map((r) => '<tr>' + cols.map((c) => '<td>' + esc(typeof c === 'function' ? c(r) : r[c]) + '</td>').join('') + '</tr>').join('');
  }

  function page() {
    const s = state();
    const pendingRows = s.pending.map((d) =>
      '<tr><td>' + d.id + '</td><td>' + esc(d.reason) + '</td><td>' + esc(d.triggers) + '</td>' +
      '<td><button onclick="resolve(' + d.id + ',\x27approve\x27)">approve</button> ' +
      '<button onclick="resolve(' + d.id + ',\x27reject\x27)">reject</button></td></tr>'
    ).join('');
    return [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<title>local-superagent panel</title><style>' + CSS + '</style></head><body>',
      '<h1>local-superagent</h1>',
      '<div class="m">llm=' + esc(s.llmMode) + ' · passthrough=' + esc(String(s.passthrough)) +
        ' · router decisions(db)=' + esc(String(s.metrics.router.decisionsInDb)) +
        ' · this-process=' + esc(String(s.metrics.router.decisions)) +
        ' · bypass(db hits)=' + esc(String(s.metrics.passthroughHitsInDb)) +
        ' · bypass(this-process)=' + esc(String(s.metrics.router.passthroughHits)) +
        ' · inflight=' + esc(String(s.concurrency.inflight)) + '/' + esc(String(s.concurrency.cap)) +
        ' · queued=' + esc(String(s.concurrency.queued)) +
        ' · tasks=' + esc(JSON.stringify(s.metrics.tasks)) + '</div>',
      '<h2>待人工决策 / pending human decisions (' + s.pending.length + ')</h2>',
      s.pending.length
        ? '<table><tr><th>id</th><th>reason</th><th>triggers</th><th></th></tr>' + pendingRows + '</table>'
        : '<div class="m">(none)</div>',
      '<h2>tasks</h2>',
      '<table><tr><th>id</th><th>status</th><th>project</th><th>origin</th><th>attempt</th><th>title</th><th>deliverable</th></tr>',
      tableRows(s.tasks, ['id', 'status', (r) => r.project || '-', 'origin', 'attempt', 'title', (r) => String(r.deliverable || '').split(/[\\/]/).pop()]),
      '</table>',
      '<h2>subscriptions (thread -&gt; worker session)</h2>',
      '<table><tr><th>thread</th><th>session</th><th>status</th><th>hits</th><th></th></tr>',
      s.subscriptions.map((r) => '<tr><td>' + esc(r.thread) + '</td><td>' + esc(r.session) + '</td><td>' + esc(r.status) + '</td><td>' + esc(r.hits) + '</td><td>' +
        (r.status === 'active' ? '<button onclick="unsub(\x27' + esc(r.thread) + '\x27)">unsubscribe</button>' : '') + '</td></tr>').join(''),
      '</table>',
      '<h2>recent events</h2>',
      '<table><tr><th>#</th><th>kind</th><th>actor</th><th>task</th></tr>',
      tableRows(s.events, ['id', 'kind', 'actor', 'task']), '</table>',
      '<script>async function resolve(id,r){await fetch("/api/decisions/"+id+"/resolve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({resolution:r})});location.reload()}',
      'async function unsub(t){await fetch("/api/unsubscribe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({thread:t})});location.reload()}</script>',
      '</body></html>'
    ].join('\n');
  }

  /** 写操作鉴权：设了 SUPERAGENT_AUTH_TOKEN 才生效；未设时保持“仅本机可写”的默认行为。 */
  function authorized(req) {
    const want = cfg.panel && cfg.panel.authToken;
    if (!want) return true;
    const header = req.headers['x-auth-token'] || '';
    const auth = String(req.headers.authorization || '');
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    return header === want || bearer === want;
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname.startsWith('/api/') && !authorized(req)) {
      return json(res, 401, { ok: false, error: 'unauthorized: send x-auth-token or Authorization: Bearer' });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, llm: engine.llm.mode });

    const mResolve = url.pathname.match(/^\/api\/decisions\/(\d+)\/resolve$/);
    if (req.method === 'POST' && mResolve) {
      const body = await readBody(req);
      const id = Number(mResolve[1]);
      const resolution = body.resolution === 'approve' ? 'approved' : 'rejected';
      const row = repo.resolveDecision(id, resolution);
      repo.event({ kind: 'human_decision', actor: 'panel', detail: { decisionId: id, resolution } });
      return json(res, 200, { ok: true, decision: row });
    }
    const mRetry = url.pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/);
    if (req.method === 'POST' && mRetry) {
      const taskId = decodeURIComponent(mRetry[1]);
      const task = repo.getTask(taskId);
      if (!task) return json(res, 404, { ok: false, error: 'task not found' });
      repo.updateTask(taskId, { status: 'queued', progress_at: Date.now(), error: null });
      repo.event({ kind: 'manual_retry', actor: 'panel', taskId });
      engine.router.schedule(taskId);
      return json(res, 200, { ok: true, taskId });
    }
    if (req.method === 'POST' && url.pathname === '/api/triggers') {
      const body = await readBody(req);
      const text = body.text == null ? '' : String(body.text);
      if (!text.trim()) return json(res, 400, { ok: false, error: 'text is required' });
      try {
        const out = await engine.submit({
          text,
          source: body.source || 'http',
          threadId: body.thread || body.threadId,
          author: body.author,
          groupId: body.group || body.groupId,
          dedupeKey: body.key
        });
        // outside the resident loop (panel-only mode) decide immediately, same semantics as CLI submit
        if (!engine.running && out.decision === 'batched') {
          const tick = await engine.tick({ force: true });
          if (tick && tick.taskId) out.taskId = tick.taskId;
          if (tick && tick.action) out.action = tick.action;
        }
        return json(res, 200, { ok: true, ...out, received: engine.router.counters.received });
      } catch (err) {
        return json(res, 500, { ok: false, error: String(err && err.message) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/unsubscribe') {
      const body = await readBody(req);
      let rows = [];
      if (body.id) {
        const row = repo.closeSubscription(Number(body.id));
        if (row) rows = [row];
      } else if (body.thread) {
        rows = repo.closeSubscriptionsByThread(String(body.thread));
      } else {
        return json(res, 400, { ok: false, error: 'need id or thread' });
      }
      repo.event({ kind: 'unsubscribe', actor: 'panel', threadId: body.thread || null, detail: { id: body.id || null, closed: rows.length } });
      return json(res, 200, { ok: true, closed: rows.length, subscriptions: rows });
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      repo.setControl('stop_requested', '1');
      repo.event({ kind: 'stop_requested', actor: 'panel' });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  }

  let pruneTimer = null;

  return {
    async start(port) {
      const p = port === undefined || port === null ? cfg.panel.port : port;
      server = http.createServer((req, res) => {
        handler(req, res).catch((err) => json(res, 500, { ok: false, error: String(err && err.message) }));
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, cfg.panel.host, () => resolve());
      });
      const addr = server.address();
      const url = 'http://' + cfg.panel.host + ':' + addr.port;
      engine.logger.info('panel.listening', { url });
      // 保留策略：每小时清一次“已终结的触发器 + 纯日志类表”，任务/会话/订阅不动
      const days = (cfg.retention && cfg.retention.days) || 0;
      if (days > 0) {
        const tick = () => {
          try {
            const cutoff = Date.now() - days * 86400000;
            const out = repo.pruneBefore(cutoff);
            const total = Object.entries(out).filter(([k]) => k !== 'cutoffMs').reduce((s, [, v]) => s + v, 0);
            if (total > 0) repo.event({ kind: 'retention_prune', actor: 'system', detail: Object.assign({ days }, out) });
          } catch (err) {
            engine.logger.warn('retention.failed', { error: String(err && err.message) });
          }
        };
        tick();
        pruneTimer = setInterval(tick, (cfg.retention && cfg.retention.intervalMs) || 3600000);
        if (pruneTimer.unref) pruneTimer.unref();
      }
      return url;
    },
    async stop() {
      if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
      if (!server) return;
      await new Promise((resolve) => server.close(() => resolve()));
      server = null;
    },
    get server() { return server; }
  };
}
