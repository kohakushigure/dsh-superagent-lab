import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const MAX_OUT = 4000;

/**
 * Worker tool whitelist. Everything is confined to the task work directory:
 *  - fs.read / fs.write / fs.list: the path is resolved and must stay inside the workdir
 *  - shell: allowlisted command prefixes only, no redirection/pipe/chaining, no `..`,
 *           no absolute drive paths, hard timeout
 *  - git: status / diff / log / rev-parse / branch only
 * A denied call returns {ok:false, denied:true} instead of throwing, and the worker logs
 * it as a tool_denied event so the behaviour is auditable.
 */
export const TOOL_SPEC = [
  { name: 'fs.write', args: { path: 'relative/path.md', content: 'string' }, note: 'write a file inside the task workdir' },
  { name: 'fs.read', args: { path: 'relative/path.md' }, note: 'read a file inside the task workdir' },
  { name: 'fs.list', args: { path: '.' }, note: 'list a directory inside the task workdir' },
  { name: 'shell', args: { command: 'git status --porcelain' }, note: 'allowlisted read-only commands only' },
  { name: 'git', args: { subcommand: 'status' }, note: 'git status|diff|log|rev-parse|branch' },
  { name: 'run', args: { command: 'python -m pytest -q' }, note: 'run one command from the project allowlist (timeout enforced)' },
  { name: 'gh', args: { args: 'issue view 39' }, note: 'gh CLI limited to the project allowlist (read + comment/pr create)' }
];

const SHELL_ALLOW = [
  /^git\s+(status|diff|log|rev-parse|branch|show)(\s+[^;&|>`]*)?$/i,
  /^(node|npm)\s+(--version|-v)$/i,
  /^(echo|dir|ls|pwd|type|cat|Get-ChildItem)(\s+[^;&|>`]*)?$/i
];

const SHELL_FORBIDDEN = [/\.\./, /[;&|><`$]/, /[A-Za-z]:[\\/]/, /(del|rm|rmdir|format|shutdown|net\s+user|curl|wget|Invoke-)/i];
const GIT_ALLOW = new Set(['status', 'diff', 'log', 'rev-parse', 'branch', 'show']);

// Windows 上优先 pwsh 7，没有就用系统自带的 powershell 5.1（本机没有 pwsh，硬编码会 ENOENT）
const shells = {
  cached: null,
  onPath(exe) {
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const exts = [''].concat(String(process.env.PATHEXT || '.EXE').split(';'));
    for (const d of dirs) {
      for (const ext of exts) {
        try { if (fs.existsSync(path.join(d, exe + ext))) return true; } catch { /* ignore */ }
      }
    }
    return false;
  },
  win() {
    if (this.cached) return this.cached;
    this.cached = this.onPath('pwsh') ? 'pwsh.exe' : 'powershell.exe';
    return this.cached;
  }
};

/** 满足其一即视为命中白名单（按前缀匹配，禁止把两条命令用 ; & | 串起来）。 */
function allowedBy(list, command) {
  const c = String(command || '').trim().replace(/\s+/g, ' ');
  if (!c) return false;
  if (/[;&|>`$\n\r]/.test(c)) return false;
  return (list || []).some((prefix) => c === prefix || c.startsWith(prefix + ' '));
}

function inside(root, rel) {
  const target = path.resolve(root, rel == null ? '.' : String(rel));
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) {
    const err = new Error('path escapes worker workdir: ' + rel);
    err.denied = true;
    throw err;
  }
  return target;
}

function run(file, args, opts) {
  return new Promise((resolve) => {
    if (opts.signal && opts.signal.aborted) {
      resolve({ ok: false, output: 'aborted before start', code: 'ABORTED' });
      return;
    }
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeout, windowsHide: true, maxBuffer: 1 << 20, signal: opts.signal }, (err, stdout, stderr) => {
      const out = String(stdout || '') + (stderr ? '\n' + String(stderr) : '');
      resolve({ ok: !err, output: out.trim(), code: err ? (err.code == null ? 1 : err.code) : 0 });
    });
  });
}

export class Toolbox {
  constructor(opts) {
    const o = opts || {};
    this.workdir = path.resolve(o.workdir);
    this.cfg = o.cfg;
    this.shell = o.shell || (process.platform === 'win32' ? shells.win() : '/bin/sh');
    this.rule = o.rule || null;
    this.clock = o.clock || (() => Date.now());
    this.calls = 0;
    this.denied = 0;
  }

  async call(name, args, opts) {
    this.calls += 1;
    const signal = opts && opts.signal;
    try {
      if (name === 'fs.write') return await this.write(args || {});
      if (name === 'fs.read') return await this.read(args || {});
      if (name === 'fs.list') return await this.list(args || {});
      if (name === 'shell') return await this.shellCall(args || {}, signal);
      if (name === 'git') return await this.git(args || {});
      if (name === 'run') return await this.runCommand(args || {}, opts);
      if (name === 'gh') return await this.gh(args || {}, opts);
      this.denied += 1;
      return { ok: false, denied: true, output: 'tool not in whitelist: ' + name };
    } catch (err) {
      if (err && err.denied) {
        this.denied += 1;
        return { ok: false, denied: true, output: String(err.message) };
      }
      return { ok: false, denied: false, output: 'tool error: ' + String(err && err.message) };
    }
  }

  async write(args) {
    const target = inside(this.workdir, args.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = args.content == null ? '' : String(args.content);
    fs.writeFileSync(target, content, 'utf8');
    const rel = path.relative(this.workdir, target) || '.';
    return { ok: true, output: 'wrote ' + rel + ' (' + Buffer.byteLength(content, 'utf8') + ' bytes)' };
  }

  async read(args) {
    const target = inside(this.workdir, args.path);
    const content = fs.readFileSync(target, 'utf8');
    const rel = path.relative(this.workdir, target) || '.';
    return { ok: true, output: 'read ' + rel + ' (' + content.length + ' chars):\n' + content.slice(0, MAX_OUT) };
  }

  async list(args) {
    const target = inside(this.workdir, args.path == null ? '.' : args.path);
    const entries = fs.readdirSync(target, { withFileTypes: true });
    return { ok: true, output: entries.map((e) => (e.isDirectory() ? '[dir] ' : '[file] ') + e.name).join('\n') };
  }

  async shellCall(args, signal) {
    const command = String(args.command || '').trim();
    if (!command) return { ok: false, denied: true, output: 'empty command' };
    const banned = SHELL_FORBIDDEN.find((re) => re.test(command));
    const allowed = SHELL_ALLOW.some((re) => re.test(command));
    if (banned || !allowed) {
      this.denied += 1;
      return {
        ok: false,
        denied: true,
        output: 'command rejected by whitelist' + (banned ? ' (forbidden pattern ' + banned + ')' : '') + ': ' + command
      };
    }
    const res = await run(this.shell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: this.workdir,
      timeout: this.cfg.worker.shellTimeoutMs,
      signal
    });
    return { ok: res.ok, output: 'exit=' + res.code + '\n' + res.output.slice(0, MAX_OUT) };
  }

  async git(args) {
    const sub = String(args.subcommand || 'status').toLowerCase();
    if (!GIT_ALLOW.has(sub)) {
      this.denied += 1;
      return { ok: false, denied: true, output: 'git subcommand not allowed: ' + sub };
    }
    const extra = Array.isArray(args.args) ? args.args.map(String) : [];
    const res = await run('git', ['--no-pager', sub].concat(extra).concat(sub === 'status' ? ['--porcelain'] : []), {
      cwd: this.workdir,
      timeout: this.cfg.worker.shellTimeoutMs
    });
    return { ok: res.ok, output: 'git ' + sub + ' exit=' + res.code + '\n' + res.output.slice(0, MAX_OUT) };
  }

  /** 跑一条项目白名单里的命令（工作目录 = workdir，带超时与输出截断）。 */
  async runCommand(args, opts) {
    const signal = opts && opts.signal;
    const command = String(args.command || '').trim();
    const allow = (this.rule && this.rule.run) || [];
    if (!allowedBy(allow, command)) {
      this.denied += 1;
      return { ok: false, denied: true, output: 'command not in project allowlist: ' + command };
    }
    const res = await run(this.shell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: this.workdir,
      timeout: (this.cfg.worker && this.cfg.worker.runTimeoutMs) || 120000,
      signal
    });
    // run 的输出截到 1800 字符，只保留尾部——pytest 列表类输出头部没有信息量
    const text = String(res.output);
    const tail = text.length > 1800 ? '…' + text.slice(-1800) : text;
    return { ok: res.ok, output: 'exit=' + res.code + '\n' + tail };
  }

  /** 受限于项目白名单的 gh 调用（只读 + 评论/开 PR；合并与发版不在白名单里）。 */
  async gh(args, opts) {
    const signal = opts && opts.signal;
    const raw = String(args.args || '').trim();
    const allow = (this.rule && this.rule.gh) || [];
    if (!allowedBy(allow, raw)) {
      this.denied += 1;
      return { ok: false, denied: true, output: 'gh call not in project allowlist: ' + raw };
    }
    const argv = raw.split(/\s+/).filter(Boolean);
    const res = await run('gh', argv, { cwd: this.workdir, timeout: 60000, signal });
    return { ok: res.ok, output: 'exit=' + res.code + '\n' + String(res.output).slice(0, MAX_OUT) };
  }

  stats() {
    return { calls: this.calls, denied: this.denied };
  }
}