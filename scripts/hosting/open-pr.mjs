import { execFileSync } from 'node:child_process';
import { formatPrBody, createPullRequest } from '../../local-superagent/src/channel.mjs';
const REPO = 'kohakushigure/llm-patent-batch-generator';
const CLONE = 'G:\\Agent-workspace\\dsh-superagent\\dist\\live\\patent';
const log = execFileSync('git', ['log', 'develop..HEAD', '--pretty=%s'], { cwd: CLONE, encoding: 'utf8' }).trim().split(/\r?\n/);
const files = execFileSync('git', ['diff', '--name-only', 'develop..HEAD'], { cwd: CLONE, encoding: 'utf8' }).trim().split(/\r?\n/);
const body = formatPrBody({ id: 'task_loop_trial', title: 'docs(records): loop trial record' }, {
  summary: 'loop 托管试运行：由 local-superagent 在独立分支上生成 docs/records/loop-trial 记录，未改动任何源码/测试/spec。',
  changes: files,
  refs: ['#44'],
  ran: ['python -m pytest --collect-only -q（1119 tests collected, exit 0）'],
  notRun: ['完整 pytest（按规程只跑 collect-only）', '构建与发版'],
  blockers: []
}, '44');
const res = await createPullRequest({ repo: REPO, head: 'agent/loop-record', base: 'develop', title: 'docs(records): loop 托管试运行记录', body, draft: true });
console.log(JSON.stringify({ commits: log, files, res }, null, 1));
