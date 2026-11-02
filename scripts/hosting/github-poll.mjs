#!/usr/bin/env node
/**
 * GitHub source adapter (edge process, NOT part of local-superagent/src).
 *
 *   poll GitHub issues/PRs + comments -> POST /api/triggers (source=github)
 *
 * Design notes (see docs/04 §14):
 *  - kept outside src/ so the core stays untouched; it is just another trigger producer
 *  - tokens only ever live in memory (env GITHUB_TOKEN), never logged, never persisted
 *  - thread = <owner>/<repo>#<number> so one issue/PR maps to one thread (subscription passthrough works)
 *  - dedupeKey = gh:<owner>/<repo>#<number>:<commentId>, plus a per-issue watermark in .cache/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MENTION_RE = /@dsh-superagent-lab|@superagent/i;
export const API = 'https://api.github.com';

export function isBotLogin(login, opts) {
  const o = opts || {};
  if (!login) return true;
  const l = String(login).toLowerCase();
  if (o.self && l === String(o.self).toLowerCase()) return true;
  if (l.endsWith('[bot]')) return true;
  const skip = (o.skipBots || []).map((s) => String(s).toLowerCase());
  return skip.includes(l);
}

/**
 * Pure: pick the comments that should become triggers.
 * comments: [{ id, body, user:{login}, issueNumber, kind:'issue'|'review', createdAt, htmlUrl }]
 * opts: { self, skipBots, sinceTs, watermarkFor(number) -> id, max }
 */
export function extractMentions(comments, opts) {
  const o = opts || {};
  const out = [];
  const seen = new Set();
  for (const c of comments || []) {
    if (!c || c.id == null) continue;
    if (seen.has(c.id)) continue;
    const body = String(c.body || '');
    if (!body) continue;
    if (isBotLogin(c.user && c.user.login, o)) continue;
    if (o.sinceTs && c.createdAt && Date.parse(c.createdAt) < o.sinceTs) continue;
    const wm = typeof o.watermarkFor === 'function' ? o.watermarkFor(c.issueNumber) : 0;
    if (wm && c.id <= wm) continue;
    if (!MENTION_RE.test(body)) continue;
    seen.add(c.id);
    out.push(c);
    if (o.max && out.length >= o.max) break;
  }
  return out;
}

/** Pure: comment -> trigger body for POST /api/triggers. */
export function toTrigger(comment, repo) {
  const owner = repo.owner;
  const name = repo.name;
  const number = comment.issueNumber;
  return {
    text: String(comment.body || ''),
    source: 'github',
    thread: owner + '/' + name + '#' + number,
    author: (comment.user && comment.user.login) || 'unknown',
    key: 'gh:' + owner + '/' + name + '#' + number + ':' + comment.id
  };
}

/** Pure: fold the polled comments into the watermark state (no mutation). */
export function nextWatermark(state, comments, now) {
  const prev = state || {};
  const issues = Object.assign({}, prev.issues || {});
  for (const c of comments || []) {
    if (c.id == null || c.issueNumber == null) continue;
    const cur = Number(issues[c.issueNumber] || 0);
    if (c.id > cur) issues[c.issueNumber] = c.id;
  }
  return Object.assign({}, prev, { issues, lastPolledAt: now || Date.now() });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt && !nxt.startsWith('--')) { out[k] = nxt; i += 1; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export function parseRepo(spec) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(spec || '').trim());
  if (!m) throw new Error('--repo must look like owner/name');
  return { owner: m[1], name: m[2] };
}

export function makeLogger(stream) {
  const w = stream || process.stdout;
  return (rec) => {
    const line = Object.assign({ ts: new Date().toISOString() }, rec);
    w.write(JSON.stringify(line) + '\n');
  };
}

export function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { issues: {}, etags: {} }; }
}
export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient(opts) {
  const o = opts || {};
  const token = process.env.GITHUB_TOKEN || '';
  const log = o.log || (() => {});
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const state = o.state || { etags: {} };
  let rate = { remaining: null, reset: null };

  async function call(url, extraHeaders) {
    const headers = Object.assign({
      accept: 'application/vnd.github+json',
      'user-agent': 'local-superagent-github-poll',
      'x-github-api-version': '2022-11-28'
    }, extraHeaders || {});
    if (token) headers.authorization = 'Bearer ' + token;
    const etag = state.etags && state.etags[url];
    if (etag) headers['if-none-match'] = etag;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const res = await fetchImpl(url, { headers });
        const remaining = res.headers.get('x-ratelimit-remaining');
        const reset = res.headers.get('x-ratelimit-reset');
        rate = { remaining: remaining == null ? null : Number(remaining), reset: reset == null ? null : Number(reset) };
        if (res.status === 304) return { notModified: true, rate };
        if (res.status === 403 || res.status === 429) {
          if (attempt > 3) return { error: 'HTTP ' + res.status + ' after ' + attempt + ' attempts', rate };
          const backoff = Math.min(30000, 1000 * Math.pow(2, attempt));
          log({ event: 'backoff', url, status: res.status, waitMs: backoff, attempt });
          await sleep(backoff);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { error: 'HTTP ' + res.status + ' ' + String(text).slice(0, 200), rate };
        }
        const newTag = res.headers.get('etag');
        if (newTag) {
          state.etags = state.etags || {};
          state.etags[url] = newTag;
        }
        return { body: await res.json(), rate };
      } catch (err) {
        if (attempt > 3) return { error: 'network: ' + String(err && err.message), rate };
        const backoff = 500 * attempt;
        log({ event: 'retry', url, waitMs: backoff, attempt, error: String(err && err.message) });
        await sleep(backoff);
      }
    }
  }

  return { call, getRate: () => rate, hasToken: Boolean(token) };
}

export async function pollOnce(ctx) {
  const { repo, client, state, opts, log } = ctx;
  const sinceTs = opts.sinceMinutes ? Date.now() - opts.sinceMinutes * 60000 : 0;
  const sinceIso = sinceTs ? new Date(sinceTs).toISOString() : null;
  const base = API + '/repos/' + repo.owner + '/' + repo.name;
  const issuesUrl = base + '/issues?state=all&per_page=100&sort=updated&direction=desc' + (sinceIso ? '&since=' + encodeURIComponent(sinceIso) : '');
  const issuesRes = await client.call(issuesUrl);
  const summary = { polls: 1, found: 0, emitted: 0, skipped: 0, ratelimit: issuesRes.rate, error: null, issues: 0, notModified: Boolean(issuesRes.notModified) };
  if (issuesRes.error) { summary.error = issuesRes.error; return summary; }
  if (issuesRes.notModified) return summary;

  const issues = Array.isArray(issuesRes.body) ? issuesRes.body : [];
  summary.issues = issues.length;
  const comments = [];
  const budget = opts.maxComments || 200;

  for (const issue of issues) {
    if (comments.length >= budget) break;
    const number = issue.number;
    const kind = issue.pull_request ? 'review-or-issue' : 'issue';
    const cUrl = base + '/issues/' + number + '/comments?per_page=100' + (sinceIso ? '&since=' + encodeURIComponent(sinceIso) : '');
    const r = await client.call(cUrl);
    if (r.error) { summary.error = r.error; continue; }
    for (const c of (Array.isArray(r.body) ? r.body : [])) {
      comments.push({ id: c.id, body: c.body, user: c.user, issueNumber: number, kind, createdAt: c.created_at, htmlUrl: c.html_url });
    }
    if (opts.reviewComments && issue.pull_request) {
      const prUrl = base + '/pulls/' + number + '/comments?per_page=100' + (sinceIso ? '&since=' + encodeURIComponent(sinceIso) : '');
      const pr = await client.call(prUrl);
      if (pr.error) { summary.reviewCommentsError = pr.error; }
      else for (const c of (Array.isArray(pr.body) ? pr.body : [])) {
        comments.push({ id: c.id, body: c.body, user: c.user, issueNumber: number, kind: 'review', createdAt: c.created_at, htmlUrl: c.html_url });
      }
    }
  }

  summary.found = comments.length;
  const picked = extractMentions(comments, {
    self: opts.self,
    skipBots: opts.skipBots,
    sinceTs,
    max: budget,
    watermarkFor: (n) => (state.issues || {})[n] || 0
  });
  summary.skipped = comments.length - picked.length;

  for (const c of picked) {
    const trigger = toTrigger(c, repo);
    if (opts.dry) { summary.emitted += 1; continue; }
    try {
      const res = await fetch('http://127.0.0.1:' + opts.port + '/api/triggers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(process.env.SUPERAGENT_AUTH_TOKEN ? { 'x-auth-token': process.env.SUPERAGENT_AUTH_TOKEN } : {}) },
        body: JSON.stringify(trigger)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      summary.emitted += 1;
      log({ event: 'emitted', repo: repo.owner + '/' + repo.name, thread: trigger.thread, key: trigger.key });
    } catch (err) {
      summary.error = 'post: ' + String(err && err.message);
    }
  }
  return summary;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const repo = parseRepo(args.repo || process.env.GITHUB_REPO || '');
  const opts = {
    port: Number(args.port || 3082),
    interval: Math.max(10, Number(args.interval || 60)),
    once: Boolean(args.once),
    dry: Boolean(args.dry),
    sinceMinutes: Number(args['since-minutes'] || 60),
    maxComments: Number(args['max-comments'] || 200),
    self: args.self || process.env.GITHUB_SELF || '',
    skipBots: String(args['skip-bots'] || 'github-actions[bot],dependabot[bot]').split(',').map((s) => s.trim()).filter(Boolean),
    reviewComments: Boolean(args['review-comments'])
  };
  const statePath = args.state || path.join(process.cwd(), '.cache', 'github-poll-state.json');
  const log = makeLogger();
  const client = createClient({ log, state: loadState(statePath) });
  const state = loadState(statePath);
  Object.assign(client, { _state: state });

  if (!client.hasToken) log({ event: 'warn', msg: 'GITHUB_TOKEN missing: unauthenticated 60 req/h, expect rate limiting' });
  log({ event: 'start', repo: repo.owner + '/' + repo.name, port: opts.port, interval: opts.interval, dry: opts.dry, sinceMinutes: opts.sinceMinutes });

  let polls = 0;
  for (;;) {
    polls += 1;
    const summary = await pollOnce({ repo, client, state: client._state, opts, log });
    const rate = client.getRate();
    log({
      event: 'poll',
      repo: repo.owner + '/' + repo.name,
      polls,
      issues: summary.issues,
      found: summary.found,
      emitted: summary.emitted,
      skipped: summary.skipped,
      notModified: summary.notModified,
      ratelimit: rate,
      error: summary.error
    });
    if (summary.error) process.exitCode = 1;
    client._state = nextWatermark(client._state, [], Date.now());
    saveState(statePath, client._state);
    if (Number(rate.remaining) === 0 && rate.reset) {
      const waitMs = Math.max(1000, rate.reset * 1000 - Date.now());
      log({ event: 'rate-wait', waitMs });
      await sleep(Math.min(waitMs, 15 * 60000));
    }
    if (opts.once || opts.dry) return summary;
    await sleep(opts.interval * 1000);
  }
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write('github-poll failed: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
}