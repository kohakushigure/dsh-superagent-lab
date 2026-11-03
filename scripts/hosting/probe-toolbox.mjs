/** probe-toolbox.mjs - 用 local-superagent 的工具箱实测「哪些命令真的被拒」，用来验证 docs/13 的判断。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Toolbox } from '../../local-superagent/src/tools.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-probe-'));
const tb = new Toolbox({ workdir: dir, cfg: { worker: { shellTimeoutMs: 5000 } } });
const cases = [
  ['shell', { command: 'python --version' }],
  ['shell', { command: 'python -m pytest -q' }],
  ['shell', { command: 'npm --prefix frontend run build' }],
  ['shell', { command: 'git status --porcelain' }],
  ['shell', { command: 'git commit -m x' }],
  ['shell', { command: 'git push origin main' }],
  ['git', { subcommand: 'commit' }],
  ['git', { subcommand: 'status' }],
  ['fs.read', { path: '../../backend/requirements.txt' }],
  ['fs.write', { path: 'agent-out/t.md', content: 'x' }]
];
for (const [tool, args] of cases) {
  const out = await tb.call(tool, args);
  console.log((out.ok ? 'OK   ' : 'DENY ') + tool + ' ' + JSON.stringify(args).slice(0, 60) + ' -> ' + String(out.output).replace(/\s+/g, ' ').slice(0, 90));
}
fs.rmSync(dir, { recursive: true, force: true });
