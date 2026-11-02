import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root: <repo>/local-superagent */
export const BASE_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 读取 local-superagent/.env.local（KEY=VALUE，已 gitignore）并注入 process.env。
 * 目的：不管进程是被 start-all、外部 watchdog 还是手动拉起的，模型配置都不会丢；
 * 已存在的环境变量优先，文件只补空缺。
 */
function loadEnvFile(dir) {
  const file = path.join(dir, '.env.local');
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!k || process.env[k]) continue; // 空字符串也当作未设置，避免被上层空环境变量挡住
    process.env[k] = v;
    n += 1;
  }
  return n;
}

loadEnvFile(BASE_DIR);

function int(v, d) {
  const n = Number.parseInt(v == null ? '' : v, 10);
  return Number.isFinite(n) ? n : d;
}
function bool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function list(v, d) {
  if (v === undefined || v === null || v === '') return d || [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

const DEFAULT_ACCEPT_REGEX = '@superagent|/agent|@agent|@dsh-superagent|请处理|帮我处理|please handle';

/** PROJECTS: 'proj/=G:\\path\\a;blog/=G:\\path\\b' or a JSON object { 'proj/': 'G:\\path\\a' } */
function parseProjects(v) {
  const out = {};
  if (!v) return out;
  const s = String(v).trim();
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      for (const k of Object.keys(obj)) out[String(k)] = String(obj[k]);
    } catch { /* fall through to the ; form */ }
    return out;
  }
  for (const part of s.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Longest thread-prefix match wins; returns null when no project claims the thread. */
export function projectForThread(projects, threadId) {
  if (!projects || !threadId) return null;
  let best = null;
  for (const prefix of Object.keys(projects)) {
    if (threadId.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, dir: projects[prefix] };
    }
  }
  return best;
}

/**
 * Every path is resolved inside the project, so nothing leaks into ~/.dsh or the OS temp dir.
 * Each field can be overridden by env (SUPERAGENT_*, OPENAI_*, MODEL_*) or by the explicit
 * `overrides` object used by tests and experiments.
 */
export function loadConfig(env, overrides) {
  const e = env || process.env;
  const o = overrides || {};
  const baseDir = o.baseDir || BASE_DIR;
  const stateDir = o.stateDir || e.SUPERAGENT_STATE_DIR || path.join(baseDir, 'state');
  const cfg = {
    baseDir,
    stateDir,
    dbPath: path.join(stateDir, 'superagent.sqlite'),
    workRoot: path.join(baseDir, '.work'),
    evidenceDir: path.join(baseDir, 'evidence'),
    spillDir: path.join(stateDir, 'spill'),
    logFile: path.join(baseDir, 'evidence', 'run.jsonl'),
    botId: e.SUPERAGENT_BOT_ID || 'superagent',
    llm: {
      baseURL: e.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: e.OPENAI_API_KEY || '',
      routerModel: e.MODEL_ROUTER || 'deepseek-chat',
      workerModel: e.MODEL_WORKER || 'deepseek-chat',
      timeoutMs: int(e.LLM_TIMEOUT_MS, 60000),
      maxRetries: int(e.LLM_MAX_RETRIES, 1),
      temperature: 0
    },
    filter: {
      sources: list(e.FAST_SOURCES, ['cli', 'http', 'github', 'slack', 'email']),
      groups: list(e.FAST_GROUPS, []),
      allowlist: list(e.FAST_ALLOWLIST, []),
      acceptRegexSource: e.FAST_REGEX || DEFAULT_ACCEPT_REGEX,
      dedupeTtlMs: int(e.FAST_DEDUPE_TTL_MS, 300000),
      ratePerMin: int(e.FAST_RATE_PER_MIN, 240),
      batchWindowMs: int(e.BATCH_WINDOW_MS, 800),
      batchMax: int(e.BATCH_MAX, 8),
      policy: e.SLOW_PATH_POLICY || ''
    },
    context: {
      spillThreshold: int(e.CONTEXT_SPILL_THRESHOLD, 1200),
      previewHead: int(e.CONTEXT_PREVIEW_HEAD, 240),
      previewTail: int(e.CONTEXT_PREVIEW_TAIL, 120),
      windowMessages: int(e.CONTEXT_WINDOW_MESSAGES, 24)
    },
    projects: parseProjects(e.PROJECTS),
    worker: {
      maxConcurrency: int(e.MAX_CONCURRENCY, 3),
      maxSteps: int(e.WORKER_MAX_STEPS, 6),
      shellProbe: bool(e.WORKER_SHELL_PROBE, true),
      shellTimeoutMs: int(e.WORKER_SHELL_TIMEOUT_MS, 15000),
      maxAttempts: int(e.WORKER_MAX_ATTEMPTS, 2)
    },
    router: {
      tickIdleMs: int(e.ROUTER_TICK_IDLE_MS, 120)
    },
    watchdog: {
      intervalMs: int(e.WATCHDOG_INTERVAL_MS, 1500),
      stallMs: int(e.WATCHDOG_STALL_MS, 120000),   // 真模型一次推理可能 10–30s，15s 的旧默认会误杀
      loopThreshold: int(e.WATCHDOG_LOOP_THRESHOLD, 3),
      errorThreshold: int(e.WATCHDOG_ERROR_THRESHOLD, 2),
      autoRestart: bool(e.WATCHDOG_AUTO_RESTART, true)
    },
    panel: {
      host: e.PANEL_HOST || '127.0.0.1',
      port: int(e.PANEL_PORT, 3082),
      // 设置后，所有写操作（POST /api/*）必须带 x-auth-token 或 Authorization: Bearer；不设则沿用“仅本机可写”的默认
      authToken: e.SUPERAGENT_AUTH_TOKEN || ''
    },
    retention: {
      // 事件/消息/跳转/outbox 的保留天数；0 = 不清理。任务与会话永不删除。
      days: int(e.RETENTION_DAYS, 14),
      intervalMs: int(e.RETENTION_INTERVAL_MS, 3600000)
    },
    passthrough: { enabled: bool(e.PASSTHROUGH_ENABLED, true) },
    logLevel: e.LOG_LEVEL || 'info'
  };
  return deepMerge(cfg, o);
}

function deepMerge(a, b) {
  if (!b) return a;
  for (const k of Object.keys(b)) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      a[k] = deepMerge(a[k] && typeof a[k] === 'object' ? a[k] : {}, v);
    } else {
      a[k] = v;
    }
  }
  return a;
}

export function acceptRegex(cfg) {
  return new RegExp(cfg.filter.acceptRegexSource, 'i');
}