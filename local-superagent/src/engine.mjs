import fs from 'node:fs';
import { loadConfig, acceptRegex } from './config.mjs';
import { openDb, Repo } from './db.mjs';
import { createLogger } from './log.mjs';
import { LLMClient } from './llm.mjs';
import { ContextStore } from './context.mjs';
import { FilterPipeline } from './filter.mjs';
import { Worker } from './worker.mjs';
import { Router } from './router.mjs';
import { Watchdog } from './watchdog.mjs';
import { createPanel } from './server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Composition root. One Engine owns one SQLite file, one router session, one worker pool,
 * one watchdog and (optionally) the HTTP panel.
 */
export class Engine {
  constructor(opts) {
    const o = opts || {};
    this.cfg = o.cfg || loadConfig(o.env, o.overrides);
    this.logger = o.logger || createLogger({ file: this.cfg.logFile, level: this.cfg.logLevel, echo: o.echo !== false });
    this.clock = o.clock || (() => Date.now());
    this.dbPath = o.dbPath || this.cfg.dbPath;
    this.db = o.db || openDb(this.dbPath);
    this.repo = o.repo || new Repo(this.db);
    this.llm = o.llm || new LLMClient({ cfg: this.cfg.llm, logger: this.logger, clock: this.clock, fetchImpl: o.fetchImpl });
    this.ctx = new ContextStore({ repo: this.repo, cfg: this.cfg, logger: this.logger, clock: this.clock });
    this.filter = new FilterPipeline({ repo: this.repo, cfg: this.cfg, logger: this.logger, clock: this.clock, regex: acceptRegex(this.cfg) });
    this.worker = new Worker({ repo: this.repo, cfg: this.cfg, llm: this.llm, ctx: this.ctx, logger: this.logger, clock: this.clock });
    this.router = new Router({ repo: this.repo, cfg: this.cfg, llm: this.llm, filter: this.filter, ctx: this.ctx, worker: this.worker, logger: this.logger, clock: this.clock });
    this.watchdog = new Watchdog({ repo: this.repo, cfg: this.cfg, router: this.router, logger: this.logger, clock: this.clock });
    this.shouldRecover = o.recover !== false;
    this.recovered = [];
    this.running = false;
    this.panel = null;
    this.loop = null;
  }

  static async create(opts) {
    const engine = new Engine(opts);
    await engine.init();
    return engine;
  }

  dirs() {
    for (const d of [this.cfg.stateDir, this.cfg.workRoot, this.cfg.evidenceDir, this.cfg.spillDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  async init() {
    this.dirs();
    this.repo.delControl('stop_requested');
    await this.router.init();
    if (this.shouldRecover) this.recover();
    this.logger.info('engine.init', {
      db: this.dbPath,
      llm: this.llm.mode,
      routerSession: this.router.routerSessionId,
      recovered: this.recovered,
      passthrough: this.cfg.passthrough.enabled
    });
    return this;
  }

  /** In-flight work at startup is re-queued, not restarted from zero: the worker session persists. */
  recover() {
    const inflight = this.repo.inFlightTasks();
    this.recovered = [];
    for (const t of inflight) {
      this.repo.updateTask(t.id, { status: 'queued', attempt: t.attempt + 1, progress_at: this.clock(), error: null });
      this.repo.event({
        kind: 'recovered',
        actor: 'engine',
        taskId: t.id,
        threadId: t.thread_id,
        detail: { from: t.status, attempt: t.attempt + 1, sessionId: t.session_id }
      });
      this.recovered.push(t.id);
    }
    return this.recovered;
  }

  resume() {
    const ids = this.recovered.slice();
    this.recovered = [];
    for (const id of ids) this.router.schedule(id);
    return ids;
  }

  async submit(ev) {
    return this.router.ingest(ev);
  }

  async tick(opts) {
    return this.router.tick(opts);
  }

  async drain() {
    this.resume();
    await this.router.drain();
  }

  startPanel(port) {
    if (port) this.cfg.panel.port = port;
    this.panel = createPanel({ engine: this });
    return this.panel.start();
  }

  async start(opts) {
    const o = opts || {};
    if (this.running) return this;
    this.running = true;
    const url = o.panel === false ? null : await this.startPanel(o.port);
    this.watchdog.start();
    this.loop = (async () => {
      this.resume();
      while (this.running) {
        if (this.repo.getControl('stop_requested')) {
          this.logger.info('engine.stop_requested');
          break;
        }
        try {
          const res = await this.tick();
          if (!res.batches) await sleep(this.cfg.router.tickIdleMs);
        } catch (err) {
          this.logger.error('engine.tick_failed', { error: String(err && err.message) });
          await sleep(200);
        }
      }
      this.running = false;
    })();
    this.logger.info('engine.started', { panel: url, watchdog: this.cfg.watchdog.intervalMs });
    return { url };
  }

  async stop() {
    this.running = false;
    this.watchdog.stop();
    if (this.panel) await this.panel.stop();
    this.panel = null;
    if (this.loop) await this.loop.catch(() => {});
    this.repo.delControl('stop_requested');
    return true;
  }

  async close() {
    await this.stop();
    await this.router.drain();
    this.repo.close();
    await this.logger.close();
  }

  metrics() {
    return {
      llm: this.llm.stats(),
      router: this.router.stats(),
      filter: this.filter.stats(),
      context: this.ctx.stats(),
      worker: { ...this.worker.counters },
      tasks: this.repo.countTasksByStatus(),
      triggers: this.repo.countTriggersByStatus(),
      decisions: this.repo.countDecisions(),
      humanPending: this.repo.pendingHumanDecisions().length,
      passthroughHitsInDb: this.repo.all('SELECT COALESCE(SUM(hits),0) AS n FROM subscriptions')[0].n
    };
  }
}
