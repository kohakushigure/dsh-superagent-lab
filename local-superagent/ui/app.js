'use strict';
const $ = (s) => document.querySelector(s);
const TOKEN_KEY = 'superagent-token';
let tab = 'tasks';
let last = null;

$('#token').value = localStorage.getItem(TOKEN_KEY) || '';
$('#token').addEventListener('input', (e) => localStorage.setItem(TOKEN_KEY, e.target.value));

document.querySelectorAll('nav button').forEach((b) => {
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
    ['tasks', 'decisions', 'subs', 'events', 'ingest'].forEach((t) => { $('#pane-' + t).hidden = t !== tab; });
  });
});

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function when(ts) { if (!ts) return ''; const d = new Date(Number(ts)); return isNaN(d) ? '' : d.toTimeString().slice(0, 8); }
function headers(json) {
  const h = {};
  if (json) h['content-type'] = 'application/json';
  const t = $('#token').value.trim();
  if (t) h['x-auth-token'] = t;
  return h;
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: headers(true), body: JSON.stringify(body || {}) });
  const text = await res.text();
  return { status: res.status, body: text };
}

function render(s) {
  const dot = $('#dot');
  dot.classList.toggle('ok', s && s.ok);
  const m = s.metrics || {};
  const c = s.concurrency || {};
  $('#pills').innerHTML = [
    'llm <b>' + esc(s.llmMode) + '</b>',
    'cap <b>' + esc(c.cap) + '</b>',
    'inflight <b>' + esc(c.inflight) + '</b>',
    'queued <b>' + esc(c.queued) + '</b>',
    'calls <b>' + esc((m.llm || {}).calls || 0) + '</b>',
    'decisions <b>' + esc((m.router || {}).decisions || 0) + '</b>',
    'dispatched <b>' + esc((m.router || {}).dispatched || 0) + '</b>',
    'passthrough <b>' + (s.passthrough ? 'on' : 'off') + '</b>'
  ].map((x) => '<span class="pill">' + x + '</span>').join('');
  $('#stamp').textContent = new Date().toLocaleTimeString();

  const tasks = s.tasks || [];
  $('#taskStat').textContent = tasks.length + ' 条（最近 20）';
  $('#tasks').innerHTML = tasks.map((t) => '<tr>' +
    '<td class="muted">' + esc(t.id) + '</td>' +
    '<td class="s-' + esc(t.status) + '">' + esc(t.status) + '</td>' +
    '<td>' + esc(t.project || '—') + '</td>' +
    '<td>' + esc((t.title || '').slice(0, 70)) + '</td>' +
    '<td>' + esc(t.attempt) + '</td>' +
    '<td class="muted">' + esc((t.deliverable || '').split('\\').pop()) + '</td>' +
    '<td><button class="ghost" data-retry="' + esc(t.id) + '">重试</button></td>' +
    '</tr>').join('') || '<tr><td colspan="7" class="muted">还没有工单</td></tr>';

  const pend = s.pending || [];
  $('#badge').textContent = pend.length;
  $('#decisions').innerHTML = pend.map((d) => '<div class="card">' +
    '<div><b>#' + esc(d.id) + '</b> <span class="muted">' + esc(when(d.createdAt)) + '</span></div>' +
    '<div class="why">' + esc(d.reason || '') + '</div>' +
    '<div class="muted">triggers: ' + esc(d.triggers) + '</div>' +
    '<div style="margin-top:8px"><button class="ghost" data-resolve="' + esc(d.id) + '" data-val="approve">批准</button> ' +
    '<button class="ghost" data-resolve="' + esc(d.id) + '" data-val="reject">驳回</button></div>' +
    '</div>').join('') || '<div class="muted">没有待人工的事，循环在正常跑。</div>';

  const subs = s.subscriptions || [];
  $('#subs').innerHTML = subs.map((x) => '<tr><td>' + esc(x.thread) + '</td><td class="muted">' + esc(x.task) + '</td>' +
    '<td class="muted">' + esc(x.session) + '</td><td>' + esc(x.status) + '</td><td>' + esc(x.hits) + '</td>' +
    '<td><button class="ghost" data-unsub="' + esc(x.thread) + '">解绑</button></td></tr>').join('') ||
    '<tr><td colspan="6" class="muted">暂无订阅</td></tr>';

  const ev = s.events || [];
  $('#events').innerHTML = ev.map((e) => '<li><b>' + esc(e.kind) + '</b> ' + esc(e.actor || '') +
    (e.task ? ' <span class="muted">' + esc(e.task) + '</span>' : '') + ' <span class="muted">' + esc(when(e.ts)) + '</span></li>').join('') ||
    '<li class="muted">暂无事件</li>';
}

async function tick() {
  try {
    const res = await fetch('/api/state', { headers: headers(false), cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    last = await res.json();
    render(last);
  } catch (err) {
    $('#dot').classList.remove('ok');
    $('#pills').innerHTML = '<span class="pill">连接失败：' + esc(err.message) + '</span>';
  }
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.resolve) {
    const r = await post('/api/decisions/' + t.dataset.resolve + '/resolve', { resolution: t.dataset.val });
    if (r.status !== 200) alert('失败 ' + r.status + '\n' + r.body);
    tick();
  }
  if (t.dataset.retry) {
    const r = await post('/api/tasks/' + encodeURIComponent(t.dataset.retry) + '/retry', {});
    if (r.status !== 200) alert('失败 ' + r.status + '\n' + r.body);
    tick();
  }
  if (t.dataset.unsub) {
    const r = await post('/api/unsubscribe', { thread: t.dataset.unsub });
    if (r.status !== 200) alert('失败 ' + r.status + '\n' + r.body);
    tick();
  }
});

$('#send').addEventListener('click', async () => {
  const body = {
    text: $('#f-text').value,
    thread: $('#f-thread').value || undefined,
    source: $('#f-source').value || 'http',
    author: $('#f-author').value || 'panel'
  };
  const r = await post('/api/triggers', body);
  $('#result').textContent = r.status + '\n' + r.body;
  tick();
});

tick();
setInterval(tick, 2000);
