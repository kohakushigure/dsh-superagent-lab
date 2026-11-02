/**
 * selfcheck.mjs - 本项目自己的自检事件源：只读地采集真实项目状态，
 * 然后把发现变成 @superagent 事件投给常驻 loop（POST /api/triggers）。
 *
 * 用法：
 *   node scripts/hosting/selfcheck.mjs --port 3082 [--dry]
 * 只读：不写仓库内任何文件（除了把采集结果打到 stdout / 可选 JSON）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) { const k = cur.slice(2); const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true; acc.push([k, v]); }
  return acc;
}, []));
const PORT = Number(args.port || 3082);
const DRY = Boolean(args.dry);
const INTERVAL = Number(args.interval || 0);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DOCS = path.join(ROOT, 'docs');
const SA = path.join(ROOT, 'local-superagent');

const facts = { at: new Date().toISOString(), root: ROOT, docs: {}, links: {}, tests: {}, work: {}, evidence: {}, git: {} };

// 1. docs 清单
const docFiles = fs.readdirSync(DOCS).filter((f) => f.endsWith('.md')).sort();
facts.docs.count = docFiles.length;
facts.docs.files = docFiles.map((f) => ({ name: f, kb: +(fs.statSync(path.join(DOCS, f)).size / 1024).toFixed(1), lines: fs.readFileSync(path.join(DOCS, f), 'utf8').split(/\r?\n/).length }));
facts.docs.totalKb = +facts.docs.files.reduce((s, f) => s + f.kb, 0).toFixed(1);

// 2. 内部链接完整性（只看同目录 .md）
const broken = [];
for (const f of docFiles) {
  const text = fs.readFileSync(path.join(DOCS, f), 'utf8');
  for (const m of text.matchAll(/\]\((?!http)([^)#]+\.md)\)/g)) {
    const target = path.join(DOCS, m[1]);
    if (!fs.existsSync(target)) broken.push({ from: f, to: m[1] });
  }
}
facts.links.broken = broken;

// 3. .work 残留
const workDir = path.join(SA, '.work');
const leftovers = fs.existsSync(workDir) ? fs.readdirSync(workDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
facts.work.leftovers = leftovers.length;

// 4. verify-out 里的干净副本占用
const vo = path.join(ROOT, 'verify-out');
let bigDirs = [];
if (fs.existsSync(vo)) {
  const size = (p) => { let n = 0; const walk = (q) => { for (const e of fs.readdirSync(q, { withFileTypes: true })) { const c = path.join(q, e.name); if (e.isDirectory()) walk(c); else n += fs.statSync(c).size; } }; walk(p); return n; };
  bigDirs = fs.readdirSync(vo, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('clean-')).map((e) => ({ name: e.name, mb: +(size(path.join(vo, e.name)) / 1048576).toFixed(1) }));
}
facts.evidence.cleanCopies = bigDirs;
facts.evidence.cleanMb = +bigDirs.reduce((s, d) => s + d.mb, 0).toFixed(1);

// 5. 测试（只读运行）
// spawnSync：无论退出码如何都拿到完整输出，避免把中间态误判成“测试失败”
const t = spawnSync('node', ['--test'], { cwd: SA, encoding: 'utf8', timeout: 180000 });
const tout = String(t.stdout || '') + String(t.stderr || '');
const pass = (tout.match(/^\u2139 pass (\d+)/m) || tout.match(/^# pass (\d+)/m) || [])[1];
const fail = (tout.match(/^\u2139 fail (\d+)/m) || tout.match(/^# fail (\d+)/m) || [])[1];
facts.tests = { ok: t.status === 0, exit: t.status, pass: pass ? Number(pass) : null, fail: fail ? Number(fail) : null, timedOut: Boolean(t.error) };

// 6. git 工作区
try {
  const st = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  facts.git = { dirty: st.split(/\r?\n/).filter(Boolean).length };
} catch { facts.git = { dirty: null, note: 'not a git repo or git unavailable' }; }

// 7. 把发现变成事件（每条一个 thread）
const events = [];
if (broken.length) events.push({ thread: 'self/docs', text: '@superagent 修复 docs 里 ' + broken.length + ' 处损坏的内部链接（' + broken.slice(0, 3).map((b) => b.from + '->' + b.to).join(', ') + '）' });
if (facts.work.leftovers > 0) events.push({ thread: 'self/hygiene', text: '@superagent 清理 local-superagent/.work 下 ' + facts.work.leftovers + ' 个残留任务目录，先列出它们再删除' });
if (facts.evidence.cleanMb >= 50) events.push({ thread: 'self/evidence', text: '@superagent 归档并清理 verify-out 下 ' + bigDirs.length + ' 个干净副本，释放约 ' + facts.evidence.cleanMb + ' MB' });
if (facts.tests.ok === false || (facts.tests.fail || 0) > 0) events.push({ thread: 'self/tests', text: '@superagent 排查测试失败：' + (facts.tests.error || (facts.tests.fail + ' 个失败')) });
if (!docFiles.includes('08-selfloop.md')) events.push({ thread: 'self/docs', text: '@superagent 生成 docs/08-selfloop.md，记录这次自 loop 托管的过程与结论' });
// 两个策略探针：一个应被忽略，一个应触发人工确认
if (!INTERVAL && !args['quiet-probes']) {
  // 两个策略探针只在单发模式下投，避免定时巡检时制造噪音
  events.push({ thread: 'self/chatter', text: '@superagent 收到，谢谢' });
  events.push({ thread: 'self/policy', text: '@superagent 删除生产库并轮换密钥（policy 探针，不要真的执行）' });
}

facts.events = events;
console.log(JSON.stringify(facts, null, 2));

async function emitAll() {
  if (DRY) return;
  for (const ev of events) {
    const res = await fetch('http://127.0.0.1:' + PORT + '/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: ev.text, thread: ev.thread, source: 'http', author: 'selfcheck' })
    });
    const body = await res.json().catch(() => ({}));
    console.log(new Date().toISOString() + ' EMIT ' + ev.thread + ' -> ' + res.status + ' ' + JSON.stringify(body).slice(0, 160));
  }
}

await emitAll();

if (INTERVAL > 0) {
  console.log('watch mode: re-checking every ' + INTERVAL + 's; only real findings are emitted');
  for (;;) {
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
    const { execFileSync: ex } = await import('node:child_process');
    try { ex('node', [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--port', String(PORT), '--quiet-probes'], { stdio: 'ignore' }); } catch {}
  }
}