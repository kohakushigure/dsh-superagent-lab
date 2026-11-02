# 02 · 官方原型速读（dsh-superagent-prototype 一手材料摘要）

> 本文只做一件事：把 GitHub 仓库 `deepseek-ai/dsh-superagent-prototype` 的一手文件讲清楚——它**自称是什么、由哪些文件构成、配置字段怎么填、授权模型怎么判、它自己承认的缺陷是什么**。
> 机制层深度拆解见 [01-architecture-deep-dive.md](01-architecture-deep-dive.md)。

## 0. 阅读约定

### 0.1 标注体系（全文强制）

| 标注 | 含义 |
| --- | --- |
| **[官方]** | 官方文件里逐字写着的，给 `文件:行` |
| **[文章设计]** | 出自官方技术文章的设计描述，**原型不一定实现** |
| **[原型已实现]** | 本仓库代码/文档中有实现证据 |
| **[两者差距]** | 文章设计与原型不一致，或原型明确未实现 |
| **[实测]** | 本机（Windows 11）实际跑出来的结果，给命令与输出 |
| **[推断]** | 我的推理，官方没写 |
| **[未验证]** | 有线索未验证，禁止当结论 |

**禁止**单独使用"已实现"三个字——必须落到 [原型已实现] 或 [两者差距]。

### 0.2 行号基准

所有 `文件:行` 指**上游仓库原文行号**。本地逐字副本在 `research/sources/`，文件名把 `/` 换成 `__`，且**顶部多 7 行抓取头部**（source_url / fetched_at / sha256 / bytes / note）。即引用 `docs/006-deployment.md:19` 时，本地对应 `research/sources/docs__006-deployment.md:26`。

### 0.3 采样时间（易漂移数据必须带时间）

| 项 | 值 | 采样方 / 时间 |
| --- | --- | --- |
| stars | **10,875** | 我（source-analyst），GitHub API，2026-11-02T10:4xZ ≈ 18:4x+08:00 |
| stars | **10,887** | qa-verifier，2026-11-02T18:45:11+08:00 |
| forks | 1,123（我）/ 1,124（qa） | 同上 |
| `pushed_at` | 2026-10-31T12:05:51Z | GitHub API |
| `created_at` | 2026-10-31T09:32:46Z | GitHub API |

媒体转述的"2,800 星"与实测差一个量级，**不可引用**（§7.4）。

---

## 1. 仓库是什么

### 1.1 元信息 [官方]

| 字段 | 值 | 出处 |
| --- | --- | --- |
| full_name | `deepseek-ai/dsh-superagent-prototype` | GitHub API |
| description | `Towards a More Autonomous Agent System` | GitHub API |
| license | MIT | `LICENSE` / API `license.spdx_id` |
| language | TypeScript | GitHub API |
| default_branch | `main` | GitHub API |
| version | `0.1.0`，`"private": true` | `package.json:5-6` |
| 文件总数 | 216 个 blob（tree API 未截断） | `git/trees/main?recursive=1` |
| 体积 | 775 KB | GitHub API `size` |

### 1.2 一句话定位 [官方]

`README.md:7`：

> dsh-superagent is a proactive coding agent for **one GitHub repository**, packaged as a bundle for DeepSeek Harness. It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a **work item**, works on it in its **own agent session and directory**, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

三条硬边界：

1. **一个仓库**——不是通用平台（`README.md:7`）。
2. **DSH bundle**——不是独立程序，必须挂到 DSH 的一个 profile（`package.json:30-46` 的 `dsh.bundle`）。
3. **反应式**——"acts only when asked or when a rule the team wrote allows it"（`README.md:9`）。

### 1.3 "别当产品用"的原话 [官方]

`README.md:3`（逐字）：

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as **research code, not production-ready software**. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.

`README.md:5`（逐字，最关键）：

> We have adapted it for publication, so it is **not identical to our internal version or the implementation described in** *Exploring Super-agent Design: Towards a More Autonomous Agent System*. **Some designs discussed in the article are directions for future development and are not implemented in this prototype.**

→ **禁止**写"原型实现了文章的五模块"。官方在此明确否认等价性（§7.1）。

---

## 2. 仓库结构树 [官方]

216 个文件，按职责分 7 层：

```
dsh-superagent-prototype/
├─ README.md                      # 定位、边界、"research prototype" 免责声明
├─ SETUP.md                       # 给"编码 agent 读"的交互式安装脚本
├─ LICENSE                        # MIT
├─ package.json                   # bundle 声明 + engines + peerDeps
├─ cordis.patch.yml               # ★ bundle 层：插入插件 + 定义两个 agent preset
├─ pnpm-lock.yaml
├─ tsconfig.json / tsdown.config.ts / vitest.config.ts
├─ examples/
│  └─ profile.cordis.patch.yml    # ★ 用户 profile 层模板（只填 stateDir / 端口）
├─ docs/                          # 9 篇，编号即阅读顺序
│  ├─ 000-philosophy.md           #   "少占用人的注意力"
│  ├─ 001-domain.md               # ★ 领域模型：Trigger/Ticket/Mandate/Thread/Executor
│  ├─ 002-authorization.md        # ★ 授权：强度、admission 表、accept 模式、复检
│  ├─ 003-execution.md            #   执行：worktree、交付、报告
│  ├─ 004-prompts.md              #   prompt 分层
│  ├─ 005-panel.md                # ★ 面板信息架构（什么算"需要人"）
│  ├─ 006-deployment.md           # ★ 部署、账号、权限、升级、排错
│  ├─ 007-architecture.md         # ★ 70 KB 实现架构
│  └─ 008-cookbook.md             #   如何新增一个 Source
├─ prompts/            (13)       # orchestrator / dispatch / worker / replies / shared /
│                                 #   admission / subscriptions / handoff* / cli / team/*
├─ skills/             (2)        # dsh-superagent-github|feishu 的 SKILL.md
├─ locale/             (2)        # en.json / zh.json
├─ scripts/
│  └─ dsh-superagent              # ★ 服务脚本 start/stop/status/logs（python3+fcntl+tmux）
├─ src/                (100)      # 见 §2.1
├─ tests/              (52)       # vitest；含 docs.spec.ts（校验文档一致性）、service-script.spec.ts
└─ .gitignore
```

### 2.1 `src/` 分层 [官方]

| 目录 | 文件数 | 职责 |
| --- | --- | --- |
| `src/core/` | 15 | 纯领域逻辑：`model.ts` 类型、`engine.ts` 状态机、`evals.ts` 判定、`tickets.ts`、`intake.ts` 收口、`assignments.ts` 归属、`memory.ts`、`part.ts` 消息片段、`reasons.ts`、`stage.ts` 阶段、`ports.ts` 端口接口 |
| `src/app/` | 29 | 编排层：`runtime.ts` 主运行时、`sessions.ts`（★ `WORKER_PRESET`/`ROUTER_PRESET`）、`assessment.ts`、`delivery.ts`、`outbox.ts`、`cache.ts`、`context.ts`、`passes.ts`、`notices.ts`、`tools/{main,executor}.ts`（★ 两侧工具面）、`views/*` 面板视图、`store*.ts` 持久化 |
| `src/sources/` | 15 | 事件源适配：GitHub（`github-*.ts`）与飞书（`feishu-*.ts`）双实现，`registry.ts` 注册表、`poll.ts` 轮询、`admission-context.ts` 入站上下文 |
| `src/client/` | 24 | 面板前端（React `.tsx`），`eval.tsx`/`ticket.tsx`/`trigger.tsx` 对应领域对象 |
| `src/executor/` | 2 | `dsh.ts` 起 DSH Session、`background.ts` 后台任务 |
| `src/infra/` | 5 | `health.ts`（★ 健康项）、`paths.ts`、`environment.ts`、`commands.ts`、`text.ts` |
| `src/` 根 | 8 | `policy.ts`（★ 19 KB，Policy schema+校验）、`admission.ts`、`deployment.ts`（★ 机器限制默认值）、`limits.ts`、`kv.ts`、`navigation.ts`、`setup.ts`、`index.ts` |

## 3. 关键文件职责表

| 文件 | 读它为了知道什么 | 关键行 |
| --- | --- | --- |
| `README.md` | 定位、三条硬边界、免责声明 | 3、5、7、9 |
| `package.json` | bundle 声明、`engines`、peer 依赖面、`dsh.client.inject` | 5-6、30-46、53-57、62-86 |
| `cordis.patch.yml` | **两个 preset 的完整工具面**（Router 与 Worker 差在哪） | 4-12、20-120、125-193 |
| `examples/profile.cordis.patch.yml` | 用户侧只需改什么 | 1-12 |
| `docs/001-domain.md` | Trigger/Ticket/Mandate/Executor/Subscription 精确语义 | 全文 |
| `docs/002-authorization.md` | **谁能提需求**、强度、admission 表、accept 模式 | 5、11-22、46-101、129-141 |
| `docs/006-deployment.md` | 账号、权限、`danger-full-access`、升级、排错 | 7、15、19、23-27 |
| `docs/007-architecture.md` | 实现层机制（70 KB，机制细节主源） | 507 等 |
| `scripts/dsh-superagent` | 服务脚本真实依赖（python3/fcntl/tmux） | 全文 |
| `src/deployment.ts` | 机器限制默认值 | 17、19、22 |
| `src/app/sessions.ts` | `WORKER_PRESET`/`ROUTER_PRESET` 常量 | — |

---

## 4. 配置：两个 yml 的字段逐个说明

两层配置，别混：

- **bundle 层** `cordis.patch.yml`（仓库根）：随包发布，**用户不改**。
- **profile 层** `$DSH_HOME/profiles/<profile>/cordis.patch.yml`：从 `examples/profile.cordis.patch.yml` 复制后填。

### 4.1 profile 层（12 行，全文可背）[官方]

```
- id: webserver           # ① 面板 Web 服务
  config:
    host: 127.0.0.1        #   只听回环
    port: 3082             #   默认端口
- id: dsh-superagent      # ② 主插件
  config:
    stateDir: <absolute path>   # ③ 状态目录，必填
# - id: dsh-superagent-feishu   # ④ 飞书 Source（可选，默认注释掉）
#   disabled: false
```

| 字段 | 类型/取值 | 必填 | 说明 | 出处 |
| --- | --- | --- | --- | --- |
| `webserver.host` | string，示例 `127.0.0.1` | 否 | 面板绑定地址 | `examples:5` |
| `webserver.port` | number，示例 `3082` | 否 | 面板端口 | `examples:6` |
| `dsh-superagent.stateDir` | **绝对路径** | **是** | 插件"没有 stateDir 就拒绝启动" | `cordis.patch.yml:2-3`、`examples:9` |
| `dsh-superagent-feishu.disabled` | bool，默认 `false` | 否 | 取消注释即启用飞书 Source，之后还要配 bot CLI | `examples:10-12`、`cordis.patch.yml:9-12` |

**`stateDir` 必须是 POSIX 绝对路径**：校验是 `/^\//`，Windows 盘符路径（`G:\...`）会被 schemastery 拒绝。
[实测]（deploy-runner 与 qa-verifier 在 Windows 11 验证）→ 原生 Windows 起步即被这条挡住。

### 4.2 bundle 层 `cordis.patch.yml`（193 行）

顶层是**一个** `- insert:` 数组，插入 5 个条目：

| 条目 | id | name | 说明 | 行 |
| --- | --- | --- | --- | --- |
| 1 | `dsh-superagent` | `dsh-superagent` | 主体插件；`stateDir` 由 profile 提供 | 5-6 |
| 2 | `dsh-superagent-github` | `dsh-superagent/github-watch` | GitHub Source（默认启用） | 7-8 |
| 3 | `dsh-superagent-feishu` | `dsh-superagent/feishu-watch` | 飞书 Source，`disabled: true` | 10-12 |
| 4 | `dsh-superagent-worker-preset` | `@deepseek-ai/dsh-agent-preset` | **Worker 的 agent preset** | 20-120 |
| 5 | `dsh-superagent-router-preset` | `@deepseek-ai/dsh-agent-preset` | **Router（主 Session）的 agent preset** | 125-193 |

> 注释指认 `WORKER_PRESET`/`ROUTER_PRESET` 定义在 `src/app/sessions.ts`（`cordis.patch.yml:13`、`:121`）。

#### 4.2.1 Worker preset（`id: dsh-superagent-worker`，`order: 90`）

`name`: `dsh-superagent 执行器`；`description` 明确写"不供手动选择"（`:24-25`）。

| 子插件 | 关键 config | 为什么 | 行 |
| --- | --- | --- | --- |
| `persona` | `prefix: You are a coding agent powered by the {{model}} model.` | Worker 有 persona，Router 没有 | 28-31 |
| `agent-instructions` | `maxBytes: 65536` | 注入仓库级指令 | 32-35 |
| `time-context` | — | 时间上下文 | 36-37 |
| `shell`（group） | 见下 | 分平台 | 39-62 |
| ↳ `bash-sandbox`/`pwsh-sandbox` | `timeoutMs: 5000`, `maxTimeoutMs: 5000` | **前台命令 5 秒转后台**，不阻塞人的消息 | 45-56 |
| ↳ `tool-bash`/`tool-pwsh` | `disabled: !!js process.platform …` | 按平台只启一个 | 57-62 |
| `tool-fs` | 无（可写） | Worker 要改代码 | 63-64 |
| `tool-fs-search` | `sampleOverCapGlobResults: false` | glob 超限不采样 | 65-68 |
| `tool-jobs` | `waitTimeoutMs: 5000` | 等后台任务也是 5 秒 | 70-74 |
| `skill-filesystem`/`tool-skill` | — | 技能加载 | 75-78 |
| `compaction`（group） | `compaction-basic`/`command-compact`/`tool-result-pruner` | **上下文压缩三件套** | 79-95 |
| ↳ `tool-result-pruner` | `thresholdChars: 8192`, `headChars: 4096`, `tailChars: 1024` | 工具结果超 8192 字符即"留头留尾" | 90-95 |
| `delegation`（group） | `tool-subagent`: `provider: spawn`, `agentPreset: standard`, `modelSelection/modelDiscovery: true` | Worker 可再派 subagent | 96-111 |
| `tool-todo` | `allowParallelInProgress: true` | 并行 todo | 112-115 |
| `tool-web` | `fetch: false`, `searchTimeoutMs: 60000` | 只搜不抓 | 116-120 |

注释点名的"故意不给"（`:16-19`）：向人提问、presenting、plan mode、插件管理与市场、调度、goals、workflows、web fetch、forked subagent。

#### 4.2.2 Router preset（`id: dsh-superagent-router`，`order: 91`）

`name`: `dsh-superagent 主 Session`。

| 子插件 | 关键 config | 与 Worker 的差异 | 行 |
| --- | --- | --- | --- |
| `agent-instructions` | `maxBytes: 65536` | 同 | 133-136 |
| `time-context` | — | 同 | 137-138 |
| `shell`（group） | `timeoutMs: 5000`，bash/pwsh 双分支 | **存在**（§7.1） | 139-162 |
| `tool-fs` | **`write: false`, `edit: false`** | 只能读，不能写/改 | 163-167 |
| `tool-jobs` | `waitTimeoutMs: 5000` | 同 | 168-172 |
| `skill-filesystem`/`tool-skill` | — | 同 | 173-176 |
| `compaction`（group） | 同三件套，`thresholdChars: 8192` | 同 | 177-193 |
| **无** `persona` | — | "the main Session's prompt is complete, so it has no other section"（`:123-124`） | — |
| **无** `tool-todo`/`tool-web`/`delegation`/`tool-fs-search` | — | "only what the main Session uses: no subagents, web, file search or writes, todo list…"（`:121-124`） | — |

**这张表是 Router/Worker 职责边界的唯一一手依据**，比任何二手描述都准。

---

## 5. 授权模型 [官方，主源 `docs/002-authorization.md`]

### 5.1 核心不变量

`docs/002-authorization.md:5`（逐字）：

> The host enforces allowed lists, rules and Mandates. **Messages, comments and quoted documents are inputs to a decision; they cannot change those permissions.**

这正面回答了"评论/引用文档不能扩权"：消息与引用文档只是**判定输入**，永远改不了白名单、规则或 Mandate。

### 5.2 谁能提需求：两条路径

| 路径 | 谁 | 效果 | 出处 |
| --- | --- | --- | --- |
| **Eval** | 名单内的人 @ / DM 机器人 | explicit 请求，进 Router 判定 | `:11-16` |
| **Eval** | 名单内的人在有 Ticket 的 Thread 里追问 | follow-up 强度 | `:14` |
| **Eval** | 名单外的其他人 | 走 admission 表，多为 inferred 或忽略 | `:15`、`:63-71` |
| **Eval** | bot 名单内的 bot | 只能产生 **inferred candidate**，**永不能**变 explicit | `:16`、`:79` |
| **订阅** | 订阅 Thread 上的一切消息（含 bot/CI） | 作为**上下文**送达，**绕过 gate，不授予任何新权限** | `:20` |

### 5.3 强度三档

| 强度 | 典型情形 | 出处 |
| --- | --- | --- |
| `explicit` | 名单内的人 @；或已有 Ticket 的 Thread 里追问；或 admission 单元格设 explicit | `:50` |
| `inferred` | 名单外的人在有 Ticket 的 Thread 追问；admission 设 inferred；bot 名单内 bot @ 或全量接收 | `:51` |
| `not admitted` | 其他 bot；admission 忽略的一切；`off` 模式下所有 inferred | `:52` |

### 5.4 admission 表（每个 Source 一张）

行 = **接收范围**：Feishu 是每个已配置群 / 收到 @ 的其他群 / 私聊（`:60`）；GitHub 是新 Issue / 新 PR / comment / 默认分支 CI（`:61`）。

列 = 三个单元格（`:63-71`）：

| 单元格 | 可选值 | 默认 |
| --- | --- | --- |
| 名单内 + 未 @ | inferred / ignore | **inferred** |
| 名单外 + @ | explicit / inferred / ignore | **ignore** |
| 名单外 + 未 @ | inferred / ignore | **ignore** |

三条反直觉但重要：

1. "名单外 + @"默认 **ignore**——"谁能提需求"最终由这张表决定，不是由"能不能 @"决定。
2. 把"名单外 + @"设成 explicit，"lets anyone in that scope request work by mentioning the agent"；官方自己提示只适合专用支持群（`:73`）。
3. CI 结果没有 sender，那行只开第三格（`:71`）。

### 5.5 accept 模式

| 模式 | 效果 | 出处 |
| --- | --- | --- |
| `off` | 任何 inferred 都不成为候选 | `:97` |
| `observe`（**默认**） | 仍评估；正向结论记成"ignore + would accept"，**什么都不接受** | `:98` |
| `auto` | 正向评估才真正 accept | `:99` |

官方建议："Start in `observe` and switch to `auto` after reviewing the recorded Decisions."（`:101`）
硬约束：**explicit 在三种模式下都有效**；一次 proactive accept 至少要命中一条 enabled rule（`:101`）。

### 5.6 归属（ownership）与 Router 让位

`:22`：Ticket 自己 Thread 上的人的消息**归该 Ticket 的 Executor 判**——"it takes no Eval and gets no Decision"。
`:26`：此时主 Session 只能**停**，`accept/attach/ignore/requeue` **一律被拒**。
→ 这就是"订阅直通"在授权层的对应物：**直通不是绕过授权，而是把判定权交给已持 Mandate 的 Executor。**

### 5.7 Mandate 只能被三件事改变

`:129`：accept 创建、人的 stop 撤回、revalidation 失败吊销。别的都不能。

复检（`:133-139`）：Source 仍在监听原 Thread 是前提；再按 Mandate 依据分流——explicit follow-up 直接过；inferred 需 `auto` + 规则仍启用；表单元格授予的要在**今天的表**下仍达原强度（删人于名单会吊销 Mandate）；bot Mandate 要求 bot 仍在 bot 名单。

### 5.8 三个易错边界

| 说法 | 真相 | 出处 |
| --- | --- | --- |
| "worker 说人让我停" | **不成立**。Thread 里人说 stop 是**普通 Trigger**，由 Eval 判；Executor 不能替人宣布 stop；面板 Stop 才是命令 | `:143-144` |
| "等下 N 小时没人认领再动手" | **不成立**。等待条件是 **Source** 的事，Eval 从不等待 | `:145` |
| "评论里贴段文档就能改权限" | **不成立**（§5.1） | `:5` |

### 5.9 Eval 不完结时

`:149-155`：超时从候选到达主 Session 起算；过期重排队；**连续两次重试后第三次过期记 `unavailable`**；`evals` 健康项报最近一小时 unavailable；面板只在"unavailable < 24h 且是该 Thread 最新 Decision 且未 dismiss"时才要人。

---

## 6. 面板（`docs/005-panel.md`）要点 [官方]

- 只回答一个问题："**什么需要人**"（`README.md:7`、`docs/000-philosophy.md`）。
- 默认 `127.0.0.1:3082`，不对外（`examples:5-6`）。
- 人能做的（与授权模型对齐）：stop、把被拥有的 follow-up 送回 Eval、重新评估、dismiss。
- 视图清单见 `docs/005-panel.md` 与 `src/client/*.tsx`：overview / threads / tickets / eval / trigger / execution / settings / sources / deployment。

---

## 7. 已知缺陷与"两者差距"

### 7.1 官方自述：原型 ≠ 文章设计 [官方]

`README.md:5` 已引（§1.3）。据此判定（与 qa-verifier 独立结论一致）：

| 文章设计 | 原型状态 | 证据 |
| --- | --- | --- |
| 计算/状态/环境分离（存算分离）、BYOM | **[两者差距]**：单机常驻 dsh 进程 + 本地 `stateDir` + tmux | `cordis.patch.yml:2-3`、`docs/006:7`、`scripts/dsh-superagent` |
| Watchdog 用模型判断"Worker 是否取得实质进展" | **[两者差距]**：只有外部定时巡检 + 健康项 + 退出码 + 预算重试 | `src/infra/health.ts`、`scripts/dsh-superagent` |
| Inline&Spill / 链式召回（同名机制） | **[两者差距]**：只有机制同源对应物（`textPage` 分页、按 id 展开、`tool-result-pruner`、compaction） | `cordis.patch.yml:90-95`、`docs/007` |
| Router 不配 Bash、只做分派 | **[两者差距]**：原型主 Session **带** bash/pwsh，只是 `tool-fs` 只读 | `cordis.patch.yml:139-167`、`docs/007-architecture.md:507` |

`docs/007-architecture.md:507` 原话（qa-verifier 定位）：主 Session 也有 DSH 的 skill、bash、read 等——"**Avoiding code reads is a prompt rule, not a tool restriction.**"

### 7.2 安全姿态：`danger-full-access` [官方]

`docs/006-deployment.md:19`（逐字）：

> Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; **they do not isolate the process**. A worker can execute programs by path and read the operator's home directory. **For isolation, use a dedicated OS account containing only the agent's credentials.**

→ 官方唯一隔离建议是**独立系统账号**，不是容器、不是沙箱。

另（`docs/006:7`）：profile 要**独立**——"the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades"。

### 7.3 工程约束 [官方]

| 约束 | 出处 |
| --- | --- |
| 只支持 github.com，**不支持 GHES** | `docs/006:25` |
| 需 Node 22.19+/24+、pnpm、git 2.32+、**Python 3.8+**、**tmux**、gh 2.48+ | `docs/006:23-24` |
| 一个仓库一套部署；每 Ticket 用 worktree 隔离 | `README.md:7`、`docs/006:25` |
| `engines` 锁 `dsh: ^0.2.1-alpha.2`，与 0.2.1-rc.x 的兼容性官方未声明 | `package.json:53-56` **[未验证]** |
| 服务脚本依赖 python3 + `fcntl` + tmux | 脚本全文；**[实测]** 原生 Windows 跑不了（ImportError: No module named fcntl / 无 tmux） |

### 7.4 上游仓库的制度性限制

- `has_issues = false`、`has_pull_requests = false`、`has_discussions = false`（qa-verifier 核实）→ **"在官方仓库开 Issue @ 机器人"的演示剧本不成立**，必须用自有/fork 仓库。这直接影响 T2 demo 剧本与 T3 验收场景。
- 媒体转述"2,800 星"与实测（10,875 / 10,887，§0.3）差一个量级，**不可引用**。

### 7.5 一手文章 URL：未定位 [未验证]

- README 只外链 `https://www.deepseek.com/en/harness/`（`README.md:7`），该页对 super-agent **0 处提及**（qa-verifier 核实）。
- `deepseek.com/blog` 404。
- 结论：**本文件不引一手文章 URL，也不编造任何 deepseek.com 文章链接**。文章侧表述一律标"二手源（IT之家 2026-10-31 / explainx 2026-11-01 转述）"，并在 [01-architecture-deep-dive.md](01-architecture-deep-dive.md) 逐条标 [文章设计]。

---

## 8. 一句话总结

原型的真实形态：**挂在 DSH 一个 profile 上的单机常驻服务，监听一个 GitHub 仓库（可选飞书），用一张 admission 表 + 三档强度 + 三种 accept 模式决定"谁能让它干活"，用 Router/Worker 两个 preset 把"判"和"干"分开，用 Ticket + worktree 做隔离，用 `danger-full-access` + 独立系统账号当安全边界——并且官方明说它是 research code、不是产品。**

它**不是**文章里那个"存算分离 + BYOM + 模型级 Watchdog"的系统。写任何材料先分清这两层。

---

## 9. 引用索引

| 简称 | 完整出处 |
| --- | --- |
| `README.md:N` | https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/README.md |
| `SETUP.md:N` | 同上 `/SETUP.md` |
| `cordis.patch.yml:N` | 同上 `/cordis.patch.yml` |
| `examples/profile.cordis.patch.yml:N` | 同上 `/examples/profile.cordis.patch.yml` |
| `package.json:N` | 同上 `/package.json` |
| `docs/00X-*.md:N` | 同上 `/docs/00X-*.md` |
| `src/**`、`scripts/**` | 同上仓库对应路径 |
| 本地逐字副本 | `research/sources/`（行号 = 上流行号 + 7） |
| 仓库树 | https://api.github.com/repos/deepseek-ai/dsh-superagent-prototype/git/trees/main?recursive=1 |
