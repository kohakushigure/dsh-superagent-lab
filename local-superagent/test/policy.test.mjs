import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Toolbox } from '../src/tools.mjs';
import { Worker } from '../src/worker.mjs';
import { makeEngine, cleanup, tmpDir } from '../testkit/helpers.mjs';
import { parseThread, formatReport, formatPrBody, createPullRequest } from '../src/channel.mjs';
import { projectRule } from '../src/config.mjs';

const rule = { prefix: 'patent/', dir: '.', outDir: 'temp/agent', run: ['python -m pytest'], gh: ['issue view', 'issue comment'], channel: 'github' };

test('run tool: only project allowlisted commands execute, others are denied', async () => {
  const dir = tmpDir('run-tool');
  const tb = new Toolbox({ workdir: dir, cfg: { worker: { runTimeoutMs: 15000 } }, rule });
  try {
    const bad = await tb.call('run', { command: 'python -c print(1)' });
    assert.equal(bad.denied, true);
    const chained = await tb.call('run', { command: 'python -m pytest & del x' });
    assert.equal(chained.denied, true);
    const ok = await tb.call('run', { command: 'python -m pytest --version' });
    assert.notEqual(ok.denied, true, 'allowlisted command must not be denied by the whitelist');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gh tool: read/comment allowed, merge and other subcommands denied', async () => {
  const dir = tmpDir('gh-tool');
  const tb = new Toolbox({ workdir: dir, cfg: { worker: {} }, rule });
  try {
    assert.equal((await tb.call('gh', { args: 'pr merge 1 --merge' })).denied, true);
    assert.equal((await tb.call('gh', { args: 'repo delete x' })).denied, true);
    const view = await tb.call('gh', { args: 'issue view 1' });
    assert.notEqual(view.denied, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('project rule: outDir changes the deliverable path, and skills are injected', async () => {
  const { engine, dir } = await makeEngine('policy-project', {
    projects: { 'patent/': { dir: path.join('__WORK__'), outDir: 'temp/agent' } },
    retention: { days: 0 }
  });
  try {
    const workdir = tmpDir('policy-work');
    fs.mkdirSync(path.join(workdir, '.dsh', 'skills', 'git-workflow'), { recursive: true });
    fs.writeFileSync(path.join(workdir, '.dsh', 'skills', 'git-workflow', 'SKILL.md'), '# git-workflow\n必须一 Issue 一分支。');
    engine.cfg.projects = { 'patent/': { dir: workdir, outDir: 'temp/agent' } };
    const w = engine.worker;
    const rel = w.deliverableRel({ id: 'task_x', project: 'patent/', thread_id: 'patent/1' });
    assert.equal(rel.replace(/\\/g, '/'), 'temp/agent/task_x.md');
    const skills = w.skillsBlock(workdir);
    assert.match(skills, /git-workflow/);
    assert.match(skills, /一 Issue 一分支/);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});

test('channel: thread parsing, report formatting and dry-run posting', async () => {
  assert.deepEqual(parseThread('acme/repo#42'), { repo: 'acme/repo', number: '42' });
  assert.equal(parseThread('not-a-thread'), null);
  const body = formatReport({ id: 'task_1', deliverable: 'temp/agent/task_1.md' }, {
    summary: '做了 A', changes: ['x.js'], refs: ['#42'], ran: ['pytest 12 passed'], notRun: ['E2E'], blockers: []
  });
  assert.match(body, /task_1/);
  assert.match(body, /NOT RUN/);
  assert.match(body, /pytest 12 passed/);
  const { engine, dir } = await makeEngine('channel', {
    projects: { 'acme/repo#': { dir: '__W__', channel: 'github' } },
    channel: { dryRun: true },
    retention: { days: 0 }
  });
  try {
    const res = await engine.router.deliver('missing-task', {});
    assert.equal(res, null);
  } finally {
    await engine.close();
    cleanup(dir);
  }
});
test('skills: references are loaded after SKILL.md and the budget truncates with a marker', async () => {
  const { engine, dir } = await makeEngine('skills-budget', { retention: { days: 0 } });
  try {
    const workdir = tmpDir('skills-ref');
    const base = path.join(workdir, '.dsh', 'skills', 'git-workflow');
    fs.mkdirSync(path.join(base, 'references'), { recursive: true });
    fs.writeFileSync(path.join(base, 'SKILL.md'), '# SKILL\n先读 references。');
    fs.writeFileSync(path.join(base, 'references', 'a-limits.md'), '# LIMITS\n禁止垃圾目录。');
    fs.writeFileSync(path.join(base, 'references', 'b-testing.md'), '# TESTING\n' + 'x'.repeat(20000));
    const block = engine.worker.skillsBlock(workdir);
    assert.match(block, /SKILL: git-workflow/);
    assert.match(block, /REF: git-workflow\/a-limits\.md/);
    assert.match(block, /禁止垃圾目录/);
    assert.ok(block.length <= 6000 + 200, 'budget plus separators: ' + block.length);
    assert.match(block, /truncated/);
  } finally { await engine.close(); cleanup(dir); }
});
test('pr: body carries changes, ran/NOT RUN and Closes #N; opening is dry-runnable', async () => {
  const body = formatPrBody({ id: 'task_p', title: 'agent: fix x' }, {
    summary: '修了 x', changes: ['backend/app/a.py'], ran: ['pytest 12 passed'], notRun: ['E2E']
  }, 42);
  assert.match(body, /Closes #42/);
  assert.match(body, /NOT RUN/);
  assert.match(body, /pytest 12 passed/);
  assert.match(body, /合并需人工审批/);
  const dry = await createPullRequest({ repo: 'acme/repo', head: 'agent/x', base: 'develop', title: 't', body, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.match(dry.output, /would open agent\/x -> develop/);
});
