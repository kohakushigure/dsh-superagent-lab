import { execFile } from 'node:child_process';

/**
 * Channel：把工单结论写回来源对话（目前只实现 GitHub issue/PR 评论）。
 * 对应官方领域模型里的 Channel 概念——Router/Worker 只产出结论，回写由独立的通道层负责，
 * 这样 Worker 不需要任何对外说话的权限。
 */
export function parseThread(threadId) {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(String(threadId || ''));
  return m ? { repo: m[1], number: m[2] } : null;
}

export function formatReport(task, report) {
  const r = report || {};
  const lines = [];
  lines.push('## worker 交付（' + task.id + '）');
  if (r.summary) lines.push('', String(r.summary).slice(0, 1500));
  const block = (title, arr) => {
    if (!arr || !arr.length) return;
    lines.push('', '### ' + title);
    for (const x of arr.slice(0, 20)) lines.push('- ' + String(x).slice(0, 300));
  };
  block('改动', r.changes);
  block('关联', r.refs);
  block('实际运行', r.ran);
  block('未运行（NOT RUN）', r.notRun);
  block('阻碍', r.blockers);
  if (task.deliverable) lines.push('', 'deliverable: `' + task.deliverable + '`');
  lines.push('', '---', '_由 local-superagent 的 Channel 层回写；不合并、不发版。_');
  return lines.join('\n').slice(0, 6000);
}

export async function postIssueComment(opts) {
  const o = opts || {};
  if (o.dryRun) return { ok: true, dryRun: true, output: 'dry-run: would comment on ' + o.repo + '#' + o.number };
  const args = ['issue', 'comment', String(o.number), '--repo', String(o.repo), '--body', String(o.body || '')];
  return await new Promise((resolve) => {
    execFile(o.ghBin || 'gh', args, { timeout: 60000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const out = String(stdout || '') + (stderr ? String(stderr) : '');
      resolve({ ok: !err, output: out.trim().slice(0, 500), code: err ? 1 : 0 });
    });
  });
}
/** PR 描述：只写公开可核验的东西（改动/关联/实跑/NOT RUN/阻碍），并以 Closes #N 关联 issue。 */
export function formatPrBody(task, report, issueNumber) {
  const r = report || {};
  const lines = [];
  lines.push('## 变更', '', r.summary ? String(r.summary).slice(0, 1500) : '(worker 未给出摘要)');
  const block = (title, arr) => {
    if (!arr || !arr.length) return;
    lines.push('', '### ' + title);
    for (const x of arr.slice(0, 20)) lines.push('- ' + String(x).slice(0, 300));
  };
  block('改动文件', r.changes);
  block('实际运行', r.ran);
  block('未运行（NOT RUN）', r.notRun);
  block('阻碍', r.blockers);
  if (issueNumber) lines.push('', 'Closes #' + issueNumber);
  lines.push('', '---', '_由 local-superagent 生成；合并需人工审批。_');
  return lines.join('\n').slice(0, 8000);
}

/** 开 PR（Draft 默认开启；合并永远不在这里做）。 */
export async function createPullRequest(opts) {
  const o = opts || {};
  if (o.dryRun) return { ok: true, dryRun: true, output: 'dry-run: would open ' + o.head + ' -> ' + (o.base || 'main') };
  const args = ['pr', 'create', '--repo', String(o.repo), '--head', String(o.head), '--base', String(o.base || 'main'),
    '--title', String(o.title || 'agent: changes'), '--body', String(o.body || '')];
  if (o.draft !== false) args.push('--draft');
  return await new Promise((resolve) => {
    execFile(o.ghBin || 'gh', args, { timeout: 90000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const out = String(stdout || '') + (stderr ? String(stderr) : '');
      resolve({ ok: !err, output: out.trim().slice(0, 800), code: err ? 1 : 0 });
    });
  });
}
