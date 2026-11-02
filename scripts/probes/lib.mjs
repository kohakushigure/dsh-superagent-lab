import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Absolute path of the clean copy under test (arg 1). */
export function cleanDir() {
  const d = process.argv[2];
  if (!d) throw new Error('usage: node <probe>.mjs <clean-copy-dir>');
  return path.resolve(d);
}

/** Import the modules FROM THE CLEAN COPY, never from the original tree. */
export async function loadCopy(dir) {
  const u = (p) => pathToFileURL(path.join(dir, p)).href;
  const engineMod = await import(u('src/engine.mjs'));
  const configMod = await import(u('src/config.mjs'));
  const dbMod = await import(u('src/db.mjs'));
  const llmMod = await import(u('src/llm.mjs'));
  const mockMod = await import(u('src/mock.mjs'));
  return {
    Engine: engineMod.Engine,
    loadConfig: configMod.loadConfig,
    Repo: dbMod.Repo,
    openDb: dbMod.openDb,
    LLMClient: llmMod.LLMClient,
    LLMError: llmMod.LLMError,
    mock: mockMod
  };
}

export function deepMerge(a, b) {
  for (const k of Object.keys(b || {})) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) a[k] = deepMerge(a[k] && typeof a[k] === 'object' ? a[k] : {}, v);
    else a[k] = v;
  }
  return a;
}

/** Per-case tmp state living inside the clean copy, so nothing leaks to the original tree. */
export function tmpState(dir, name) {
  const p = path.join(dir, 'verify-tmp', name);
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** Config for a probe: no env leakage, no real LLM, fast batch window, watchdog parked by default. */
export function probeCfg(ctx, stateDir, overrides) {
  const base = {
    stateDir,
    workRoot: path.join(stateDir, 'work'),
    evidenceDir: path.join(stateDir, 'evidence'),
    spillDir: path.join(stateDir, 'spill'),
    logFile: path.join(stateDir, 'run.jsonl'),
    filter: { batchWindowMs: 0, ratePerMin: 5000, allowlist: [], groups: [] },
    worker: { shellProbe: false },
    watchdog: { intervalMs: 3600000, stallMs: 15000, autoRestart: true },
    logLevel: 'error'
  };
  return ctx.loadConfig({}, deepMerge(base, overrides || {}));
}

export async function makeEngine(ctx, dir, name, overrides, engineOpts) {
  const stateDir = tmpState(dir, name);
  const cfg = probeCfg(ctx, stateDir, overrides);
  const engine = await ctx.Engine.create(Object.assign({ cfg, echo: false }, engineOpts || {}));
  return { engine, cfg, stateDir };
}

export function checker(caseId, label) {
  const checks = [];
  const api = {
    check(name, ok, detail) {
      checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
      process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + name + (detail === undefined ? '' : '  ::  ' + JSON.stringify(detail)) + '\n');
      return Boolean(ok);
    },
    eq(name, actual, expected, extra) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      return api.check(name, ok, ok ? { actual } : { actual, expected, ...(extra || {}) });
    },
    finish() {
      const passed = checks.filter((c) => c.ok).length;
      const failed = checks.length - passed;
      const rec = { case: caseId, label, checks: checks.length, passed, failed, detail: checks };
      process.stdout.write('PROBE_RESULT ' + JSON.stringify(rec) + '\n');
      process.exitCode = failed === 0 ? 0 : 1;
      return rec;
    }
  };
  return api;
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
