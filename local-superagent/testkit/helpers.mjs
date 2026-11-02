import fs from 'node:fs';
import path from 'node:path';
import { BASE_DIR, loadConfig } from '../src/config.mjs';
import { Engine } from '../src/engine.mjs';

const TMP_ROOT = path.join(BASE_DIR, 'state-test', '.tmp');

export function tmpDir(name) {
  const dir = path.join(TMP_ROOT, name + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 7));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function testCfg(dir, overrides) {
  const base = {
    stateDir: dir,
    workRoot: path.join(dir, 'work'),
    logFile: path.join(dir, 'run.jsonl'),
    filter: { batchWindowMs: 0, ratePerMin: 100, allowlist: [] },
    worker: { shellProbe: false },
    watchdog: { intervalMs: 3600000, stallMs: 15000, autoRestart: true },
    logLevel: 'error'
  };
  return loadConfig({}, deepMerge(base, overrides || {}));
}

export function deepMerge(a, b) {
  for (const k of Object.keys(b)) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) a[k] = deepMerge(a[k] && typeof a[k] === 'object' ? a[k] : {}, v);
    else a[k] = v;
  }
  return a;
}

export async function makeEngine(name, overrides) {
  const dir = tmpDir(name);
  const cfg = testCfg(dir, overrides);
  const engine = await Engine.create({ cfg, echo: false });
  return { engine, cfg, dir };
}

export function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}