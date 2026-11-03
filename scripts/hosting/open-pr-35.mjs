import { execFileSync } from 'node:child_process';
import { formatPrBody, createPullRequest, postIssueComment } from '../../local-superagent/src/channel.mjs';
const CLONE = 'G:\\Agent-workspace\\dsh-superagent\\dist\\live\\patent';
const REPO = 'kohakushigure/llm-patent-batch-generator';
const files = execFileSync('git', ['diff', '--name-only', 'develop..HEAD'], { cwd: CLONE, encoding: 'utf8' }).trim().split(/\r?\n/);
const body = formatPrBody({ id: 'task_issue35', title: 'test(ota): derive versions from APP_VERSION' }, {
  summary: 'Fixes the blocking item A of #35: the root-level OTA acceptance suite hardcoded 1.0.0.27/1.0.0.28, so a version bump turned 9 assertions red. Now CURRENT_TEXT comes from backend.app.version.APP_VERSION and TARGET_TEXT is the next patch, so future bumps cannot drift again.',
  changes: files,
  refs: ['#35'],
  ran: ['cd patent-tool && python -m pytest tests/test_ota_acceptance.py -q -p no:cacheprovider -> 96 passed, 1 skipped'],
  notRun: ['full root-level tests suite', 'backend/tests/unit and E2E (untouched)', 'build and release'],
  blockers: []
}, '35');
const pr = await createPullRequest({ repo: REPO, head: 'agent/issue-35-ota-version', base: 'develop', title: 'test(ota): derive current/target version from APP_VERSION (refs #35)', body, draft: true });
console.log('pr:', JSON.stringify(pr));
const note = ['## loop 交付（#35 失败项 A）', '', '- draft PR: ' + String(pr.output || '').trim(), '- 分支: agent/issue-35-ota-version -> develop', '- 改动: patent-tool/tests/test_ota_acceptance.py', '- 实跑: python -m pytest tests/test_ota_acceptance.py -q -> 96 passed, 1 skipped', '- NOT RUN: 完整根级 tests 全套、E2E、构建', '', '版本改为从 APP_VERSION 推导，下次 bump 不再漂移。'].join('\n');
const cm = await postIssueComment({ repo: REPO, number: '35', body: note });
console.log('comment:', JSON.stringify(cm));
