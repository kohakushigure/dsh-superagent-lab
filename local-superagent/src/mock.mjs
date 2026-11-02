/**
 * Deterministic offline brain. Used whenever OPENAI_API_KEY is absent (the default),
 * and by the test suite, so every module is exercisable with no network and no key.
 * The rules intentionally mirror the policy a real router model would be given;
 * they are not a stand-in for model quality.
 */

const RISKY = /(删除生产|生产库|drop\s+table|rm\s+-rf|密钥|password|secret|轮换|force[- ]push|生产环境|清空)/i;
const CHATTER = /(天气|吃了吗|哈哈|闲聊|随便聊聊|thanks|thank you|收到|好的)/i;
const WORK = /(实现|写|生成|修|fix|改|加|补|deploy|重构|review|整理|聚合|分析|文档|测试|排查)/i;

export function cleanTitle(texts) {
  const first = String((texts && texts[0]) || '(no text)');
  const stripped = first.replace(/@superagent|@agent|\/agent/gi, '').replace(/\s+/g, ' ').trim();
  const base = stripped || first.trim();
  return base.length > 72 ? base.slice(0, 72) + '…' : base;
}

export function mockRouteDecision(input) {
  const triggers = input.triggers || [];
  const joined = triggers.map((t) => t.text).join('\n');
  const title = cleanTitle(triggers.map((t) => t.text));
  if (RISKY.test(joined)) {
    return {
      action: 'need_human',
      confidence: 0.93,
      reason: 'policy: risky/irreversible operation needs an explicit human decision',
      title
    };
  }
  if (CHATTER.test(joined) && !WORK.test(joined)) {
    return { action: 'ignore', confidence: 0.88, reason: 'policy: social chatter, no actionable request', title };
  }
  return {
    action: 'dispatch',
    confidence: triggers.length > 1 ? 0.9 : 0.82,
    reason: 'policy: actionable work request (' + triggers.length + ' event(s) merged)',
    title,
    intent: joined.slice(0, 400)
  };
}

export function mockWorkerStep(input) {
  const task = input.task;
  const step = input.step;
  const md = [
    '# ' + task.title,
    '',
    '- task id: ' + task.id,
    '- origin: ' + (task.origin || 'router'),
    '- brain: mock (no OPENAI_API_KEY set)',
    '',
    '## Request',
    '',
    String(task.intent || task.title || '').slice(0, 600),
    '',
    '## Plan executed by the worker',
    '',
    '1. fs.write the deliverable into the isolated worker directory',
    '2. fs.read it back to verify the bytes landed',
    '3. shell `git status --porcelain` (failure tolerated, not a git repo)',
    '4. shell a forbidden command to prove the whitelist holds',
    '',
    '## Status',
    '',
    'done'
  ].join('\n');

  const rel = input.deliverableRel || 'deliverable.md';
  if (step === 0) {
    return { thought: 'draft the deliverable', tool: 'fs.write', args: { path: rel, content: md } };
  }
  if (step === 1) {
    return { thought: 'verify the file is readable', tool: 'fs.read', args: { path: rel } };
  }
  if (input.shellProbe === false) {
    return {
      final: {
        summary: 'deliverable.md written and verified for: ' + (task.title || task.id),
        deliverable: 'deliverable.md'
      }
    };
  }
  if (step === 2) {
    return { thought: 'inspect repository state', tool: 'shell', args: { command: 'git status --porcelain' } };
  }
  if (step === 3) {
    return { thought: 'attempt a command outside the whitelist', tool: 'shell', args: { command: 'Remove-Item -Recurse -Force C:/Windows' } };
  }
  return {
    final: {
      summary: (input.deliverableRel || 'deliverable.md') + ' written and verified for: ' + (task.title || task.id),
      deliverable: input.deliverableRel || 'deliverable.md'
    }
  };
}
