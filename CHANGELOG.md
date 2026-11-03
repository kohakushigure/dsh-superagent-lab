# Changelog

本仓库的版本只描述**本仓库自己的产出**（研究文档 + `local-superagent/`），
与上游 DeepSeek 的 `dsh-superagent-prototype` 版本无关。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- Loop console: static SPA (`local-superagent/ui/`) with tasks / pending decisions / subscriptions / events / ingest views; legacy page kept at `/legacy`.
- `POST /api/*` ingest authentication via `SUPERAGENT_AUTH_TOKEN` (header `x-auth-token` or Bearer).
- Retention: hourly prune of terminal triggers and log tables (`RETENTION_DAYS`, default 14).
- `scripts/hosting/watchdog-ext.mjs`: out-of-process watchdog with restart budget.
- `scripts/hosting/start-all.ps1`: one-command stack (loop + selfcheck + watchdog), `-Status` / `-Stop`.
- `scripts/hosting/github-poll.mjs`: GitHub issue/PR comment source with ETag + watermark dedupe and rate-limit backoff.
- `research/papers/README.md`: related-work mapping (ReAct, Reflexion, Voyager, Toolformer, Generative Agents, AutoGen, MetaGPT, CoALA, AgentBench, CAMEL).


### loop-lab round 2
- `skillsBlock()` now loads `references/*.md` too, bounded by `WORKER_SKILL_BUDGET` (default 6000) with an explicit truncation marker.
- `channel.mjs`: `formatPrBody()` + `createPullRequest()` (draft by default, never merges); router supports `channel: "github-pr"` with `report.branch`.
- `router.drain()` now waits for Channel deliveries before closing, fixing an engine-close race.
- demo forces the offline brain in the ablation phase (`.env.local` no longer leaks the real model into K) and passes 30/30 again.
- `scripts/hosting/rehearse-patent.mjs`: rehearsal against a local clone of the patent repo (6/6 checks).

### Changed
- Worker prompt + duplicate-call gate: identical `(tool,args)` calls are blocked and reported, fixing a real-model loop that the in-process watchdog used to kill.
- Env file `local-superagent/.env.local` is auto-loaded, so a restart (by watchdog or shell) keeps the model configuration.
- Panel honours `listen(0)` for tests; tests no longer pick random high ports.

### Fixed
- Cross-thread batching merged unrelated projects into one ticket; batching is now per thread.
- `-Remove` of autostart now clears all three tiers (scheduled task, Startup folder, HKCU Run).
- selfcheck re-emitted identical findings every cycle; added a 6h signature cooldown.


### 计划
- 把 `local-superagent` 的 governance（panel token / retention）收尾，让 29 个用例全绿（见下「已知问题」）。

## [0.1.0] - 2026-11-02

首个公开版本：一份关于 DeepSeek Super-agent（2026-10-31）的独立研究，
外加一个**不依赖 DeepSeek Harness、本机可直接跑**的最小 Super-agent 实现。

### 研究文档（`docs/`）
- `00-overview.md` 领域模型与五模块对照、决策矩阵、红线
- `01-architecture-deep-dive.md` 机制深读（两级过滤、订阅直通、Inline & Spill、链式召回、watchdog）
- `02-official-prototype-digest.md` 上游仓库逐文件档案与 `cordis.patch.yml` 字段
- `03-local-deployment-runbook.md` 官方原型部署手册，含 **Windows 11 实测结论**：
  `stateDir` 的 `/^\//` 校验与 setup 的 `env` 包装是两道 POSIX 硬墙，「原生 Windows 跑不通」有源码行为证
- `04-local-implementation.md` 自建实现的模块图、表结构、状态机与逐条差异对照
- `05-validation-report.md` 独立验收记录（干净副本复跑）
- `06-fact-check.md` 事实核查表（每条声明 → 出处 → 判定）
- `07-loop-hosting-feasibility.md` 本机常驻托管可行性
- `08-selfloop.md` 让这个 loop 管这个仓库的实跑记录

### 自建实现（`local-superagent/`）
- Router/Worker 双层：Router 常驻只分派、Worker 每工单独立上下文 + 独立工作目录
- 两级过滤：Fast Path（身份/来源/群组/白名单/提及/去重/令牌桶）+ Slow Path（模型按 policy 判定，带批次合并）
- 订阅直通：thread → worker session 多对多订阅，命中即绕过批次与 slow path
- 上下文缓存：Inline & Spill（超阈值落盘，只留摘要 + 续读 ID）+ 链式召回（message → thread → session → task）
- 持久化与恢复：SQLite（Node 24 内置 `node:sqlite`）记录 triggers/tasks/sessions/subscriptions/messages/events/hops/decisions；重启后 in-flight 任务回收重跑
- Watchdog：定时巡检无进展/死循环/接口报错，能 abort 并重启 worker
- 接口：CLI（`submit/status/logs/watch/stop/unsubscribe/demo`）+ HTTP 面板（默认 3082，待人工决策项可见可决议）
- 零第三方运行时依赖；无 `OPENAI_API_KEY` 时自动走确定性 mock 大脑，**无 Key 也能跑全链路**

### 部署与实测（`deploy/`、`scripts/hosting/`）
- `deploy/` Windows 版官方原型部署脚本：`start.ps1` / `stop.ps1` / `status.ps1` / `bin/dsh-local.cmd`（绕开 `dsh.cmd` 硬编码的 `DSH_HOME`）、`profile.cordis.patch.yml`、研究用补丁 `patches/windows-absolute-path.patch`
- `scripts/hosting/fake-llm.mjs` 零依赖 OpenAI 兼容桩（固定延迟/抖动/失败率），用于在**真实适配器路径**上测并发
- `scripts/hosting/measure-latency.ps1` 实测 `MAX_CONCURRENCY` 与吞吐：1.5 s 延迟下 cap=1 峰值排队 4、总耗时 25.96 s；cap=2 与 cap=4 都是 15.3 s（差异 0.6%，即 cap≥2 无增益——瓶颈是 Router 的串行 slow path）

### CI
- `.github/workflows/ci.yml`：ubuntu-latest + windows-latest 双平台，Node 24
  - `test` job：`node --test` + `node bin/demo.mjs`（30 条断言），失败时上传输出
  - `smoke` job：起服务 → POST 一条 `@superagent` 事件（端口 18082）→ 断言 tasks ≥ 1 → 停服务

### 已知问题
- `test/governance.test.mjs` 有 1 例在干净环境也失败：`table events has no column named created_at`（该用例与 `src/db.mjs` 的 schema 尚不一致，governance 收尾中）。另 2 例 auth 用例在本机失败是因为面板端口 3082 被本仓库自己的常驻 loop 占用（`EADDRINUSE`），CI 上不受影响。

[Unreleased]: https://github.com/kohakushigure/dsh-superagent-lab/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kohakushigure/dsh-superagent-lab/releases/tag/v0.1.0