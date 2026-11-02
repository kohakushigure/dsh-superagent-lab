/**
 * watchdog-ext.mjs - 进程外的看门狗（官方设计里“外部 Watchdog”的落地版）。
 * 只做三件事：探活、判定、重启。不做业务判断。
 *
 *   node scripts/hosting/watchdog-ext.mjs --port 3082 [--interval 15] [--fail-threshold 3] [--max-restarts 3]
 *
 * 设计取舍：
 * - 与进程内 watchdog 互补：进程内管“任务卡住”，这里管“进程死了/端口不通”。
 * - 重启走 scripts/hosting/start-hosted.ps1（同一个启动入口，避免两份逻辑）。
 * - 每小时最多重启 max-restarts 次，连续失败则退避并只记日志，不会狂刷。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) { const k = cur.slice(2); const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true; acc.push([k, v]); }
  return acc;
}, []));
const PORT = Number(args.port || 3082);
const INTERVAL = Number(args.interval || 15) * 1000;
const THRESHOLD = Number(args['fail-threshold'] || 3);
const MAX_RESTARTS = Number(args['max-restarts'] || 3);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(ROOT, 'local-superagent', 'evidence', 'hosting');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'watchdog-ext-' + new Date().toISOString().slice(0, 10) + '.jsonl');

const say = (obj) => {
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj));
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};

async function probe() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/api/health', { signal: ctl.signal });
    if (!res.ok) return { ok: false, why: 'http ' + res.status };
    const body = await res.json();
    return { ok: body.ok === true, why: 'health', llm: body.llm };
  } catch (err) {
    return { ok: false, why: String(err && err.message).slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

function restart() {
  return new Promise((resolve) => {
    // 走统一入口：它会先加载 local-superagent/.env.local，保证重启后模型配置不丢
    const ps = path.join(ROOT, 'scripts', 'hosting', 'start-all.ps1');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Port', String(PORT)], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => resolve({ code, out: out.slice(-400) }));
  });
}

let fails = 0;
let restarts = 0;
let windowStart = Date.now();
say({ event: 'watchdog_ext_start', port: PORT, interval: INTERVAL, threshold: THRESHOLD, maxRestarts: MAX_RESTARTS, log: LOG });

for (;;) {
  const r = await probe();
  if (r.ok) {
    if (fails > 0) say({ event: 'recovered', afterFails: fails, llm: r.llm });
    fails = 0;
  } else {
    fails += 1;
    say({ event: 'probe_failed', fails, why: r.why });
    if (fails >= THRESHOLD) {
      if (Date.now() - windowStart > 3600000) { windowStart = Date.now(); restarts = 0; }
      if (restarts >= MAX_RESTARTS) {
        say({ event: 'restart_budget_exhausted', restarts, windowStart });
      } else {
        restarts += 1;
        say({ event: 'restart_attempt', attempt: restarts });
        const res = await restart();
        say({ event: 'restart_result', attempt: restarts, code: res.code, tail: res.out });
        await new Promise((r2) => setTimeout(r2, 5000));
        const again = await probe();
        if (again.ok) { say({ event: 'restart_ok', attempt: restarts }); fails = 0; }
      }
    }
  }
  await new Promise((r2) => setTimeout(r2, INTERVAL));
}