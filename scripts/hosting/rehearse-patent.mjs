/**
 * rehearse-patent.mjs - 在**本地克隆**上演练：用项目规则跑他们仓库里真实存在的命令，
 * 证明「受控执行面 + 项目规则」这套改造对真实项目可用，同时不碰原仓库。
 *
 *   node scripts/hosting/rehearse-patent.mjs [--src <原仓库路径>] [--dir <克隆目录>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Toolbox } from '../../local-superagent/src/tools.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) { const k = cur.slice(2); const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true; acc.push([k, v]); }
  return acc;
}, []));

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = args.src || 'G:\\Agent-workspace\\专利批量化生成工具';
const DIR = args.dir || path.join(ROOT, 'dist', 'rehearse', 'patent');

if (!fs.existsSync(DIR)) {
  fs.mkdirSync(path.dirname(DIR), { recursive: true });
  execFileSync('git', ['clone', '--depth', '1', '--branch', 'develop', '--quiet', SRC, DIR], { stdio: 'inherit' });
  console.log('cloned -> ' + DIR);
} else {
  console.log('reusing clone -> ' + DIR);
}

// 项目规则：只用他们仓库里真实存在的东西
const rule = {
  prefix: 'patent/',
  dir: DIR,
  outDir: 'temp/agent',
  run: [
    'python -m pytest --version',
    'python .dsh/skills/git-workflow/scripts/check_pr_route.py'
  ],
  gh: ['issue view', 'pr list'],
  channel: 'github-pr',
  base: 'develop'
};

const tb = new Toolbox({ workdir: DIR, cfg: { worker: { runTimeoutMs: 60000 } }, rule });
const rows = [];
const probe = async (label, tool, callArgs, expectDenied) => {
  const out = await tb.call(tool, callArgs);
  const denied = out.denied === true;
  rows.push({ label, tool, denied, ok: denied === expectDenied, head: String(out.output).split(/\r?\n/).slice(0, 2).join(' / ').slice(0, 140) });
};

await probe('allowed: pytest version', 'run', { command: 'python -m pytest --version' }, false);
await probe('allowed: their route checker', 'run', { command: 'python .dsh/skills/git-workflow/scripts/check_pr_route.py' }, false);
await probe('denied: full pytest run', 'run', { command: 'python -m pytest -q' }, true);
await probe('denied: git commit', 'run', { command: 'git commit -m x' }, true);
await probe('denied: gh pr merge', 'gh', { args: 'pr merge 1 --merge' }, true);
await probe('denied: read outside workdir', 'fs.read', { path: '../../etc/passwd' }, true);

const failed = rows.filter((r) => !r.ok);
for (const r of rows) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + ' :: ' + r.head);
console.log('---');
console.log('checks ' + rows.length + ', failed ' + failed.length);
if (failed.length) process.exit(1);
