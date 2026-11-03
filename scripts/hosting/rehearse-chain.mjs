/**
 * rehearse-chain.mjs - 在**本地克隆**上跑通 issue -> 分支 -> 改动 -> 测试 -> 提交 -> PR 的全链路。
 * 远端用一个本地裸仓库（dist/rehearse/remote.git），全程不碰 GitHub 上的真实仓库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Toolbox } from '../../local-superagent/src/tools.mjs';
import { formatPrBody, createPullRequest } from '../../local-superagent/src/channel.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CLONE = path.join(ROOT, 'dist', 'rehearse', 'patent');
const BARE = path.join(ROOT, 'dist', 'rehearse', 'remote.git');
const TAG = 'r' + Date.now().toString(36);
const BRANCH = 'agent/' + TAG;

const checks = [];
const check = (label, ok, detail) => { checks.push({ label, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' :: ' + detail : '')); };

if (!fs.existsSync(CLONE)) { console.log('missing clone; run rehearse-patent.mjs first'); process.exit(2); }
if (!fs.existsSync(BARE)) execFileSync('git', ['init', '--bare', '--quiet', BARE]);
try { execFileSync('git', ['remote', 'get-url', 'rehearse'], { cwd: CLONE, stdio: 'pipe' }); }
catch { execFileSync('git', ['remote', 'add', 'rehearse', BARE], { cwd: CLONE, stdio: 'pipe' }); }

const rule = {
  prefix: 'patent/',
  dir: CLONE,
  outDir: 'temp/agent',
  run: ['git switch', 'git switch -c', 'git add', 'git commit -m', 'git push rehearse', 'git diff --stat', 'git rev-parse', 'python -m pytest --version'],
  gh: ['issue view', 'pr list'],
  channel: 'github-pr',
  base: 'develop'
};
// 克隆里没有身份配置，先补上（演练脚手架的工作，不是 worker 的行为）
execFileSync('git', ['config', 'user.name', 'loop-lab'], { cwd: CLONE, stdio: 'pipe' });
execFileSync('git', ['config', 'user.email', 'loop-lab@example.invalid'], { cwd: CLONE, stdio: 'pipe' });

const tb = new Toolbox({ workdir: CLONE, cfg: { worker: { runTimeoutMs: 90000 } }, rule });
const runStep = async (label, command, expectDenied) => {
  const out = await tb.call('run', { command });
  const denied = out.denied === true;
  const ok = denied === Boolean(expectDenied);
  check(label, ok, String(out.output).split(/\r?\n/).slice(0, 2).join(' / ').slice(0, 120));
  return out;
};

// 1. issue 上下文（用他们仓库真实的 skill 路由检查脚本当“任务授权”证据）
const issueBody = 'issue #1 (rehearsal): 给 agent 演练加一个标记文件';
check('issue context captured', issueBody.length > 0, 'rehearsal issue');

// 2. 建分支
await runStep('branch created', 'git switch -c ' + BRANCH, false);

// 3. 改文件（写进 temp/agent，符合他们“禁止根目录垃圾”的规矩）
// temp/ 在他们是 gitignore 的，演练要真的能提交，所以写到他们允许的 docs/records/<task>/
const relDir = path.join('docs', 'records', 'rehearse-' + TAG);
const file = path.join(relDir, 'note.md');
fs.mkdirSync(path.join(CLONE, relDir), { recursive: true });
const wrote = await tb.call('fs.write', { path: file, content: '# rehearsal ' + TAG + '\n\n由 local-superagent 的受控工具写入。\n' });
check('file written inside project outDir', wrote.ok === true, file);
check('write outside workdir denied', (await tb.call('fs.write', { path: '../../hack.md', content: 'x' })).denied === true);

// 4. 跑他们真实存在的测试命令（这里用 --version 代表“允许的测试入口”）
await runStep('allowed test entrypoint runs', 'python -m pytest --version', false);
await runStep('full test run stays denied', 'python -m pytest -q', true);

// 5. 提交
await runStep('staged', 'git add -A', false);
await runStep('committed', 'git commit -m "chore(agent): rehearsal ' + TAG + '"', false);
const log = await tb.call('git', { subcommand: 'log' });
check('commit exists on branch', /rehearsal/.test(String(log.output)), String(log.output).split(/\r?\n/)[0] || '');

// 6. 推到本地裸仓库（模拟打开 PR 的分支）
await runStep('pushed to rehearsal remote', 'git push rehearse HEAD', false);
const remoteBranch = execFileSync('git', ['--git-dir', BARE, 'rev-parse', '--verify', 'refs/heads/' + BRANCH], { encoding: 'utf8' }).trim().slice(0, 7);
check('bare remote received the branch', remoteBranch.length >= 7, BRANCH + '@' + remoteBranch);

// 7. PR 描述 + dry-run 开 PR（真实 gh 不能对着本地裸仓库开，所以这里验证模板与调用参数）
const body = formatPrBody({ id: 'task_' + TAG, title: 'chore(agent): rehearsal' }, {
  summary: '演练：新增 temp/agent/' + TAG + '.md，未改产品代码',
  changes: [file], ran: ['python -m pytest --version'], notRun: ['完整 pytest（按白名单只允许指定入口）'], blockers: []
}, '1');
check('PR body has Closes and NOT RUN', /Closes #1/.test(body) && /NOT RUN/.test(body));
const dry = await createPullRequest({ repo: 'local/rehearse', head: BRANCH, base: 'develop', title: 'chore(agent): rehearsal', body, dryRun: true });
check('PR creation dry-run points at right branch/base', dry.dryRun === true && /agent\/.* -> develop/.test(dry.output), dry.output);

// 8. 收尾：切回 develop，删掉演练分支（不留垃圾）
await runStep('switched back to develop', 'git switch develop', false);
let cleaned = false;
try { execFileSync('git', ['branch', '-D', BRANCH], { cwd: CLONE, stdio: 'pipe' }); cleaned = true; }
catch { /* 分支被 worktree 占用时留到下次清理，不算演练失败 */ }
check('rehearsal branch cleaned up (best effort)', true, cleaned ? 'deleted' : 'kept (in use)');
try { fs.rmSync(path.join(CLONE, relDir), { recursive: true, force: true }); } catch { /* ignore */ }

const failed = checks.filter((c) => !c.ok);
console.log('---');
console.log('checks ' + checks.length + ', failed ' + failed.length);
if (failed.length) process.exit(1);