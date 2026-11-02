# 01 · Super-agent 架构深度拆解

> 本文回答一个问题：**Super-agent 到底靠什么机制做到"连续、高效、主动、持久"**，以及**官方原型 dsh-superagent-prototype 实现了其中多少**。
> 一手依据：原型仓库全部文档与源码（本地逐字副本 `research/sources/`）；文章侧只有二手转述，一手 URL 未定位（§10）。

## 0. 读法约定（先看这段，否则容易读错）

### 0.1 三态标注（强制）

官方技术文章的设计与原型实现**不等价**——这不是我的判断，是官方自己写的：

> `README.md:5`：*"Some designs discussed in the article are **directions for future development and are not implemented in this prototype**."*

所以每条机制都必须落到三态之一：

| 标注 | 含义 |
| --- | --- |
| **[文章设计]** | 文章里的设计；原型可能有、可能没有 |
| **[原型已实现]** | 能在本仓库找到代码/文档证据（给 `文件:行`） |
| **[两者差距]** | 文章有、原型没有；或原型做了但不一样（给出差异点） |

辅助标注：**[官方]** 原文逐字；**[推断]** 我的推理；**[未验证]** 有线索未核实；**[实测]** 本机跑出来的。

**禁止**出现"五模块已全部落地"这类话——它同时违反 §0.1 与 §10。

### 0.2 五模块的编号（按官方文章章节 2–6）

| # | 模块 | 一句话 |
| --- | --- | --- |
| M1 | 双层架构：主 Session 评判 + Executor Session 执行 | Router/Worker 分离 |
| M2 | 事件驱动 Trigger | 外部事件进来，过滤器决定要不要唤醒 |
| M3 | 全双工多渠道交互 | 人/机器随时插话，agent 异步 start()/stop() |
| M4 | 计算 / 状态 / 环境分离（存算分离 + BYOM） | 进程可换机器、状态外置、模型可换 |
| M5 | Watchdog | 外部巡检、判活、重启 |

出处：二手源（IT之家 2026-10-31 / explainx 2026-11-01 转述），一手文章 URL **未定位**（§10）。

### 0.3 [重构] 映射表（给工程实现用，不替代官方编号）

我们最初那套"①双层 ②事件+两级过滤 ③订阅直通 ④上下文当缓存 ⑤持久在线"是**媒体二手归纳**，其中 ③④ 其实是 M2 下的**机制**，⑤ 与 M4/M5 混在一起。为便于和 T3 的自建实现对照，保留一张映射表：

| [重构] 叫法 | 实际归属 | 性质 |
| --- | --- | --- |
| ① 双层 Router/Worker | **M1** | 模块 |
| ② 事件驱动 + 两级过滤 | **M2** | 模块（两级过滤是 M2 的内部结构） |
| ③ 订阅直通 | **M2 下的机制** | 机制，不是模块 |
| ④ 上下文当缓存（Inline&Spill / 链式召回） | **M2/M3 的支撑机制** | 机制，不是模块 |
| ⑤ 持久在线 | 拆成 **M4**（存算分离）+ **M5**（Watchdog） | 两个模块 |
| ⑥ 异步 start()/stop() | **M3** | 工具协议，不是"持久"的一部分 |
| ⑦ 投机执行（speculative execution） | **M2** | 我们的旧归纳漏了它；原型无对应证据 → [两者差距] |

---

## 1. 一张图看懂数据流

```mermaid
flowchart TD
    subgraph 外部
        GH[GitHub<br/>Issue / PR / comment / CI]
        FS[Feishu<br/>群 / 私聊]
        HU[人：@ 或 DM]
    end

    subgraph S1["① 事件准入（确定性，不花 token）"]
        SRC[Source 适配器<br/>github-* / feishu-*]
        POL{Policy：<br/>监听范围？<br/>机器人名单？<br/>admission 表？}
        STR[强度：explicit / inferred / not admitted]
    end

    subgraph S2["② Router（主 Session，ROUTER_PRESET）"]
        EVAL[Eval：一个 Thread 一批 Trigger<br/>orchestrator_eval → eval_read → eval_decide]
        DEC{Decision<br/>accept / attach / stop / ignore}
    end

    subgraph S3["③ Worker（Executor Session，WORKER_PRESET）"]
        T[Ticket + Mandate + worktree]
        EX[执行：读写/跑命令/开 PR]
        REP[orchestrator_ack / report / handback]
    end

    subgraph S4["④ 状态与巡检"]
        KV[(stateDir<br/>KV / 锁 / shim / ticket 目录)]
        HL[health 项 + 退出码 0/1/2/3]
    end

    GH --> SRC
    FS --> SRC
    HU --> SRC
    SRC --> POL --> STR
    STR -->|inferred 且 mode≠off| EVAL
    STR -->|explicit| EVAL
    STR -->|订阅 Thread 的消息| T
    EVAL --> DEC
    DEC -->|accept| T
    DEC -->|attach| T
    T --> EX --> REP
    REP -->|report / 交付| GH
    REP -->|handback：越界| EVAL
    T <--> KV
    S2 <--> KV
    HL -.定时巡检.-> KV
```

要点（按图上的箭头顺序）：

1. **确定性过滤在前，语义判断在后**——[文章设计] 的两级过滤；原型里死在 §3。
2. **订阅的消息绕过 Router**（`STR --> T` 这条边）；Router 此时只收到**通知**（`docs/002-authorization.md:26`）。
3. **只有 accept 才产生 Ticket + Mandate**；Ticket 是唯一能携带权限往前走的东西。
4. **handback 是回边**：Executor 越界 → 消息退回 → 重新 Eval（`docs/002-authorization.md:30-32`）。

---

## 2. M1 双层架构：Router / Worker 的职责边界

### 2.1 文章设计 vs 原型

| 设计要点 | 文章 | 原型 | 证据 |
| --- | --- | --- | --- |
| Router 常驻、只分派 | [文章设计] | **[原型已实现]** 主 Session 常驻，工具面只有 14 个 `orchestrator_*` | `docs/007-architecture.md:495-501` |
| Router 维护全局上下文 | [文章设计] | **[两者差距]** 原型 Router 不持有 Worker 的上下文，只持有卡片 + 可读 Thread 上下文 | `docs/007:213` |
| **Router 可不配 Bash、用轻量模型** | [文章设计] | **[两者差距]** 原型主 Session **带** bash/pwsh，只是 `tool-fs` 只读 | `cordis.patch.yml:139-167`；`docs/007:507` |
| Worker 上下文隔离 | [文章设计] | **[原型已实现]** 每个 Ticket 一个 DSH Session + 一个目录 | `README.md:7`；`docs/007:201` |
| Worker 用最强模型 | [文章设计] | **[原型已实现]** 角色各自绑模型（`Sessions.ensure` 按角色取模型） | `docs/007:235`；`package.json` 无硬编码 |
| Worker 不直接对外说话 | [文章设计] | **[两者差距]** Worker 通过 `orchestrator_report` 交付，但 PR 评论由它自己发（Source 通道） | `docs/007:525`、`docs/003-execution.md` |

### 2.2 Router 的真实工具面（14 个，一手）

按用途分六组（`docs/007-architecture.md:495-501`）：

| 组 | 工具 |
| --- | --- |
| 读与路由 | `orchestrator_read`、`orchestrator_route` |
| 管 Ticket | `orchestrator_ticket_retry`、`orchestrator_ticket_request_status`、`orchestrator_ticket_note` |
| 重新评估 | `orchestrator_trigger_requeue` |
| 评估主动工作 | `orchestrator_eval`、`orchestrator_eval_read`、`orchestrator_eval_decide` |
| 沟通与退订 | `orchestrator_reply`、`orchestrator_thread_unsubscribe` |
| 改配置 | `orchestrator_settings_save`、`orchestrator_policy_sync`、`orchestrator_prompts_save` |

关键约束：

- `orchestrator_route` 一次接受 **1–20** 条决策，**逐条独立执行**——一条被拒不阻断其余（`docs/007:503`；与 `docs/002:85` 一致）。
- `orchestrator_ticket_note` 送的是**事实/上下文，不是权限**（`docs/007:503`）→ 这是"评论不能扩权"的工具级落实。

### 2.3 Worker 的真实工具面（6 个，一手）

`docs/007-architecture.md:519-528`：

| 工具 | 作用 |
| --- | --- |
| `orchestrator_read` | 读本 Ticket 可读资源 |
| `orchestrator_ack` | 确认收到 |
| `orchestrator_report` | 报进度/结果；按 PR 规则绑定 pull request |
| `orchestrator_thread_unrelated` | 丢掉不相关的附加 Thread，交回其拥有的 follow-up 并说明理由 |
| `orchestrator_thread_follow` | 订阅相关 Thread 作上下文并告知主 Session |
| `orchestrator_trigger_handback` | 把一条消息交回一次，附理由供候选使用 |

Worker **拿不到**的工具（`docs/007:532`）：向人提问、presenting、改 profile、在 worker slot 之外排期、起/发其他 Session、编辑外部文档。**Ticket 结束后的工具调用一律被拒**（`docs/007:532`）。

### 2.4 两个 preset 的工具面差异（一手，最硬的边界证据）

| 能力 | Worker（`order:90`） | Router（`order:91`） |
| --- | --- | --- |
| persona | ✅「You are a coding agent…」 | ❌（注释：主 Session 的 prompt 已完整） |
| bash / pwsh | ✅（5s 转后台） | ✅（5s 转后台） |
| 文件写/改 | ✅ | ❌ `write:false, edit:false` |
| 文件搜索 | ✅ | ❌ |
| todo | ✅ | ❌ |
| web | 只搜不抓 | ❌ 完全没有 |
| subagent 委派 | ✅（`agentPreset: standard`） | ❌ |
| compaction 三件套 | ✅ | ✅ |
| skill | ✅ | ✅ |

来源：`cordis.patch.yml:20-120`（Worker）、`:125-193`（Router）。**这是"职责边界"唯一不需要推理的证据。**

### 2.5 上下文管理：谁记得什么

| 谁 | 记得什么 | 证据 |
| --- | --- | --- |
| Router | 卡片（Trigger/Ticket/Thread/Decision 的紧凑视图）+ 按需读的 Thread 上下文（**有页数上限**） | `docs/007:340`、`:213` |
| Worker | 自己 Ticket 的完整会话；可 read / 可跑命令 | `docs/007:201` |
| 两者之间 | 只有 `orchestrator_*` 的结构化消息（ack/report/handback/note），**不共享对话历史** | `docs/007:519-528` |
| 持久层 | `stateDir`（DB、锁、worker shim、git 配置、ticket 目录） | `src/deployment.ts:16` |

**一句话**：Router 看"卡片"，Worker 看"代码"，交接面是结构化工具调用。这就是上下文隔离的真实含义——不是"上下文更短"，而是"**另一套上下文，且彼此不可见**"。

---

## 3. M2 事件驱动 + 两级过滤

### 3.1 两级过滤的判定接口

| 层 | 文章 | 原型对应 | 三态 |
| --- | --- | --- | --- |
| **Fast Path**（程序层，确定性） | 来源 / 群组 / 白名单硬过滤 | Source 是否监听该范围 → Policy 的 admission 表 → 强度三档（explicit/inferred/not admitted） | **[原型已实现]**，但形态是"表 + 强度"，不是"正则/关键词" |
| **Slow Path**（语义层，小模型） | 小模型按 policy 判定 | `MasterAssessor`：主 Session 调 `orchestrator_eval` → `orchestrator_eval_read`（读上下文）→ `orchestrator_eval_decide`（提交结论） | **[原型已实现]**，但**用的是主 Session 本身**，不是独立小模型 |
| **投机执行** | 文章提到（二手转述） | 无对应实现，仓库内 grep `speculat` 0 命中 | **[两者差距]** / [未验证] |

判定接口的形状（原型，一手）：

```
Trigger（入站消息）
  → Source 判：这个范围我在监听吗？
  → admission 表判：这个发送者 × 是否 @ → explicit | inferred | ignore
  → 若 explicit            → 直接给 Router，进 Eval
  → 若 inferred 且 mode=off → 丢弃，连候选都不是
  → 若 inferred 且 mode=observe → 评估但只记"would accept"
  → 若 inferred 且 mode=auto    → 评估为真才 accept
  → 已在订阅 Thread 上（且被某 Ticket 拥有）→ 绕过上面全部，直接给 Executor
```

### 3.2 batch 是怎么形成的（一手）

`docs/007-architecture.md:93`：`evaluateDue()` 对**每个 Thread** 起一个 Eval，把期间排队的 Trigger **合成一个 batch**。

→ 这就是"事件驱动 + 批处理"的落地形式：**不是按消息触发，而是按 Thread 聚合**。
→ 直接后果（§9.2）：Trigger 频率 1/min → 40/min 时，平均 batch 1.0 → 2.8，单请求延迟 2.5s → 3.9s，但单决策的分摊推理 6.4s → 1.6s。**用延迟换吞吐**。

### 3.3 事件源

| Source | 实现 | 状态 |
| --- | --- | --- |
| GitHub | `src/sources/github-*.ts`（trigger/watch/read/pull/channel） | **[原型已实现]** |
| Feishu | `src/sources/feishu-*.ts`（含图片、loop 防护） | **[原型已实现]**，默认 `disabled: true`（`cordis.patch.yml:12`） |
| 新增 Source | `docs/008-cookbook.md` + `src/sources/kind.ts` 契约 | **[原型已实现]** |

---

## 4. 订阅直通（M2 的机制，不是模块）

### 4.1 原型怎么做的（一手）

| 规则 | 出处 |
| --- | --- |
| 订阅 Thread 上的**每条**消息都作为上下文送达其 Ticket，**包括 bot 与 CI** | `docs/002:20` |
| 这条投递**绕过 gate，且不授予任何新权限** | `docs/002:20` |
| 人可以主动 `unsubscribe(thread)`，该 Thread 上所有订阅一起失效 | `docs/007:81` |
| Worker 可 `thread_follow` 订阅相关 Thread 作**纯上下文**（不产生权限、不复活已结束 Ticket） | `docs/002:42`、`docs/007:527` |
| Worker 发现 Thread 无关时 `thread_unrelated`：只丢自己的订阅 + 交回它拥有的 follow-up | `docs/007:526` |
| 归属期间主 Session 只能 stop，`accept/attach/ignore/requeue` 全拒 | `docs/002:26` |

### 4.2 路由表设计（把上面的规则画成表）

| 事件类型 | 有 Ticket 拥有？ | 去向 | 是否消耗 Router 决策 |
| --- | --- | --- | --- |
| 订阅 Thread 上的人的消息 | 是 | 直达该 Ticket 的 Executor | **否**（只发 follow-up 通知） |
| 订阅 Thread 上的 bot / CI 消息 | 是 | 直达 Executor 作上下文 | 否 |
| **纯上下文**订阅 Thread 上的人的消息 | 是 | 直达 Executor，**不复活**已结束 Ticket | 否 |
| 人 @ Router | — | Eval（explicit） | 是 |
| 无 Ticket 拥有的 follow-up | 否 | 重新 Eval | 是 |
| 被 `handback` 的消息 | 否 | 重新 Eval，候选里带原因 | 是 |
| 被 stop 的 Ticket 的 stop 消息 | — | **不**再回 Eval（除非别的 Ticket 交回） | 否 |

表格依据：`docs/002-authorization.md:20/22/24/26/30-38/42/44`。

### 4.3 「多对多」到什么程度

- 一个 Ticket 可订阅**多个** Thread（含附加 Thread）（`docs/002:42`、`docs/007:526-527`）。
- 一个 Thread 可被**多个** Ticket 订阅；消息到达时"每个订阅 Ticket 都收到"（`docs/002:20`），但**归属只有一份**：谁被指定拥有，谁判（`docs/002:22`）。
- 因此**不是**"多对多广播 + 各自判断"，而是"**多对多投递 + 单一归属判定**"。这个区别在实现时很关键：否则同一条消息会被两个 Worker 各答一遍。

---

## 5. 上下文当缓存：Inline & Spill 与链式召回

### 5.1 文章设计

- **Inline & Spill**：上下文里只放摘要/前缀，超阈值的内容"溢出"到外部，**保留续读入口**。
- **链式召回**：每个对象内联**下一跳的 ID**，形成 消息 → Thread → Worker Session 的指针链。

出处：二手转述；一手 URL 未定位（§10）。→ **[文章设计]**

### 5.2 原型里的同源对应物（一手，但**不是同名机制**）

| 文章机制 | 原型对应物 | 证据 | 三态 |
| --- | --- | --- | --- |
| Inline & Spill（截断留续读入口） | `textPage` 分页对象：卡片只带摘要，正文按页取 | `docs/007:340` | **[两者差距]**（同源，不同名） |
| 同上 | `orchestrator_eval_read`：按 id 展开某个对象的完整内容 | `docs/007:213`、`:499` | 同上 |
| 同上 | `tool-result-pruner`：>8192 字符留头 4096 + 尾 1024 | `cordis.patch.yml:90-95` | 同上 |
| 同上 | `compaction-basic` / `command-compact` | `cordis.patch.yml:86-89` | 同上 |
| 同上 | 评估期上下文硬上限：10 页 / 15 秒 / prompt 10 万字符 | `src/deployment.ts:17-22` | 同上 |
| 链式召回（内联下一跳 ID） | `links.ts`：`sourceLink`、消息所在页、`candidateCard` | `docs/007:339` | **[两者差距]** |
| 同上 | `workerSessionId(ticket.id)` 由 Ticket id 推出 Session id | `docs/007:201` | 同上 |
| 同上 | 面板 `openKnownSession` 按 Session id 打开 | `src/navigation.ts:14-23` | 同上 |

### 5.3 机制规则（可实现的版本）

把上面的证据反推成规则，供 T3 自建实现对照：

1. **写上下文时只写"指针 + 摘要"**：对象正文存 KV，上下文内联 `id` + 前 N 字符 + 长度。
2. **阈值分层**：单工具结果 8192 字符（头 4096 / 尾 1024）；单次评估 10 页；单次读 15 秒；prompt 100k 字符。四个阈值互相独立，别用一个数管全部。
3. **每次"展开"都是一次显式调用**（`*_read`），不是隐式拼接——这样 token 消耗可计量、可预算。
4. **链式召回的锚点是稳定 ID**：Ticket id ↔ Session id 可推导；Thread ↔ Ticket 由订阅表反查；消息 → 所在页由 `sourceLink` 给。
5. **召回必须幂等**：同一 id 读 N 次得到同一结果（否则恢复后行为漂移）。

---

## 6. M3 全双工多渠道 + 异步 start()/stop()

### 6.1 文章设计

人在任意时刻插话，agent 以工具形式**异步启停**工作（start/stop 返回句柄而非结果），完成后回推。

→ **[文章设计]**；原型用另一套形状实现（下表）。

### 6.2 原型协议（一手）

| 文章概念 | 原型机制 | 证据 |
| --- | --- | --- |
| 异步 start() | `orchestrator_route(accept)` 只**创建** Ticket + 启动 Assignment，不等结果 | `docs/007:73` |
| 异步查询 | `orchestrator_ticket_request_status`、`orchestrator_ticket_retry` | `docs/007:497` |
| 异步 stop() | 人的 stop（Thread 里说 = 普通 Trigger；面板 = 命令） | `docs/002:143-144` |
| 完成回推 | `orchestrator_report` → Report 事件 → 主 Session 收通知 | `docs/007:525`、`:237` |
| 双向插话 | `orchestrator_reply` / `orchestrator_ticket_note` | `docs/007:500/503` |
| 不阻塞 | **`noWait` 守卫**：主 Session 的 shell 禁止 `sleep`；shell `timeoutMs` >30s 被拒；`job_output` 等待 >5s 被拒 | `docs/007:513` |
| 交互节流 | 前台命令 5 秒转后台（两个 preset 都是），job 等待 5 秒 | `cordis.patch.yml:45-56/70-74`、`docs/007:511` |
| 容量 | `WorkerSlots`：启动/唤醒前先占位；人工消息可**超额一个**；唤醒优先于启动 | `docs/007:203` |

**这张表是"异步"在原型里的真实形态**：不是 RPC 句柄，而是"**决策立即返回 + 结果以事件回推 + 一切等待都有 5 秒上限**"。

---

## 7. M4 存算分离 / BYOM

| 设计 | 文章 | 原型 | 三态 |
| --- | --- | --- | --- |
| 计算与状态分离，进程可漂移 | [文章设计] | 单机常驻 dsh 进程 + 本地 `stateDir` + tmux 会话 | **[两者差距]** |
| 环境（沙箱/工作目录）与状态分离 | [文章设计] | 每 Ticket 一个目录 + worktree（`docs/006:25`） | **部分 [原型已实现]** |
| BYOM（自带模型） | [文章设计] | 用 profile 的默认模型；Eval / Execution 设置可另指模型 | **部分 [原型已实现]**（`docs/006:26`） |
| 状态外置存储 | [文章设计] | `stateDir` 里的 DB + 锁（`proper-lockfile`） | **[两者差距]** |

**判定**：原型的"持久"是**单机持久**（重启后恢复），不是**跨机持久**（进程漂移）。
部署形态证据：`docs/006:7`（独立 profile）、`cordis.patch.yml:2-3`（stateDir 必填）、`scripts/dsh-superagent`（tmux + pid 文件）。

### 7.1 恢复语义（一手，这是"持久"的真正含金量）

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 启动时发现被中断的 Assignment | `resume` 报 `assignmentInterrupted`，并把待启动项重新排队，**最老的 Ticket 优先** | `docs/007:207` |
| 临时性 provider/网络失败 | 3 次重试；启动用 effect backoff；失败 turn 在 **15/30/60 秒**后收到续跑消息 | `docs/007:205` |
| 重复控制操作 | 文件锁，第二次直接拒绝 | `scripts/dsh-superagent:231` |
| 优雅停止 | 超时则**不强杀**，提示查 status | `scripts/dsh-superagent:145` |
| 已被停止的 Ticket | 不自动恢复；`--respect-stop` 让巡检器不要拉起 | `scripts/dsh-superagent:220` |

---

## 8. M5 Watchdog

| 设计 | 文章 | 原型 | 三态 |
| --- | --- | --- | --- |
| **模型判断 Worker 是否取得实质进展** | [文章设计] | 无。没有"进展判定"的 LLM 逻辑 | **[两者差距]** |
| 外部定时巡检 | [文章设计] | `scripts/dsh-superagent` 的 start/stop/restart/status + `--respect-stop` + 锁 | **[原型已实现]** |
| 健康项 | [文章设计] | 管理 API 的 `health` 字典（含 `runtime`/`evals` 等），面板展示 | **[原型已实现]**（`scripts:82-104`、`docs/002:153`） |
| 判活 | [文章设计] | pid + `ps -p` 校验"是不是这个 profile 的 dsh 服务" | `scripts:67` |
| 重启 | [文章设计] | `restart` 只修 1 类故障；2/3 类要人 | `scripts:4-6`、`:202` |
| 退出码语义 | [文章设计] | **0 正常 / 1 停止·重复·不可达·运行时错 / 2 有组件报错（重启无效）/ 3 等待 setup（重启无效）** | `scripts:4-6` |
| 预算重试 | [文章设计] | `modelRetry` 暴露模型预算重试状态 | `docs/007:241` |

### 8.1 Watchdog 巡检清单（可实现的版本）

从原型的一手证据反推，一个够用的巡检器每轮只查这 6 项：

1. **进程**：pid 活着，且**确实是本 profile 的 dsh**（别被 pid 复用骗）。
2. **健康字典**：`runtime` 是否 `ready`/`paused`；`evals` 是否报最近一小时 unavailable。
3. **控制锁**：是否有别的控制操作在跑（有就退出，别并发重启）。
4. **意图**：上次是不是"人主动 stop"（是就别拉起来 → `--respect-stop`）。
5. **setup**：是否还在等配置（是则退出码 3，重启无用）。
6. **组件错**：Source 报错（则退出码 2，重启无用，要人）。

**结论**：原型的 Watchdog 是**运维级**（进程/健康/退出码），不是**认知级**（模型判断有没有进展）。两者不能用同一套话说。

---

## 9. 状态机与实验

### 9.1 Ticket 状态机（一手）

```
[消息 Trigger]
   │ admission 表
   ▼
[强度] ──not admitted──► 丢弃
   │explicit / inferred
   ▼
[Eval] ──超时×2──► unavailable（第三次过期）
   │ decide
   ├── ignore ──────────► 记录（observe 模式记 would accept）
   ├── attach ──────────► 挂到已有 Ticket
   ├── stop ────────────► 结束
   └── accept ──────────► [Ticket + Mandate + Subscription + Assignment]
                              │
                              ▼
                         [Executor 执行] ──report──► 交付（PR/回复）
                              │
                              ├── handback（越界）──► 回 Eval（若无人拥有）
                              └── 结束 ──revalidation──► 失败则吊销 Mandate
[人 stop] ──► 永久结束，除新 accept 否则不再收任何东西
```

来源：`docs/002:129-141`、`docs/007:58/73`、`src/core/stage.ts`。

三个反直觉点：
- **ended 的 Ticket 仍持 Mandate**（`docs/002:127`）——所以"结束"不等于"权限失效"。
- **resume 不需要新 Eval/Decision**，只要人在这条 Thread 上说句话（`docs/002:127`）。
- **改 Policy 不会立刻吊销 live Ticket**（`docs/002:117`），但**改 admission 表会在 revalidation 时生效**（`docs/002:75`）。

### 9.2 实验数据（按 qa-verifier 校准后的口径）

实验设定：合成负载，**约 300 条消息 / 20 个工作请求**，每个方案 **5 次**。编码工作由一个**只消耗时间**的工具模拟。

| 指标 | Super-agent | 单 Session + Subagent（中性提示词） | 单 Session + Subagent（委派优先提示词） |
| --- | --- | --- | --- |
| p50 完成时间 | **12.4 min** | 20.4 min | 13.8 min |
| p95 完成时间 | **15.7 min** | 29.5 min | 29.0 min |
| 实际调用 Subagent 的次数 | — | **5/5 均未调用** | 4/5 次调用（第 5 次判"太小"自己做 → 长尾） |

**两条基线必须分开写**：29.5 min 的 p95 只属于"中性提示词"那一支；"5 次均未调用 Subagent"也只属于那一支。混着写就是错话。

直通消融（去掉订阅直通）：

| 指标 | 有直通 | 无直通 | 结论 |
| --- | --- | --- | --- |
| p50 / p95 | 12.4 / 15.7 min | 12.6 / 15.5 min | **无显著变化** |
| Router 决策数 | 基准 | **+30%** | 直通省的是 Router 的活 |
| 读缓存 token | 23.2M（2323 万） | 31.8M（3177 万） | **+37%** |

Token 两个口径别混用：**23.2M→31.8M** 是表格口径，**2323 万→3177 万** 是精确口径。

Trigger 压测（1/min → 40/min）：

| 指标 | 1/min | 40/min |
| --- | --- | --- |
| 平均 batch | 1.0 | **2.8** |
| 单请求延迟 | 2.5 s | **3.9 s** |
| 单决策分摊推理 | 6.4 s | **1.6 s** |

→ 机制解释：batch 变大 → 每决策摊薄 → 单请求变慢。**这是吞吐/延迟的权衡曲线，不是"性能提升"。**

### 9.3 局限（必须跟着数字一起写）

1. **不能换算成"编码效率提升 N 倍"**。原文自述 **indicative only**；且"编码"是由只消耗时间的工具模拟的——它测的是**调度开销**，不是**代码质量**。
2. **样本量小**：5 次/方案，p95 在 n=5 时几乎是最大值，不能当分位数用。
3. **合成负载**：300 消息 / 20 请求的分布是构造的，真实团队的消息突发性不同（§9.2 的 40/min 才是压力测试）。
4. **单机单仓**：所有实验都在一个仓库、一台机器上；M4 的跨机假设**未被测过**。
5. **基线受提示词影响极大**：同一基线换个提示词，p50 从 20.4 变 13.8 min（差 32%）。所以"对比"必须绑定提示词版本。
6. **原型 ≠ 文章**：以上数字属于**文章的实验**，不是**这个原型**的实测；原型侧没有公开 benchmark。

---

## 10. 证据等级与未解问题

### 10.1 本文档的证据构成

| 来源 | 覆盖 | 等级 |
| --- | --- | --- |
| 仓库 `docs/001-008`、`README`、`cordis.patch.yml`、`src/*` | M1/M2/M3 的实现细节、授权模型、工具面、恢复语义 | **一手**（本地逐字副本 + 行号） |
| 二手转述（IT之家 2026-10-31 / explainx 2026-11-01） | M1–M5 的编号、四特征表述、实验数值、投机执行 | **二手**，标 [文章设计] |
| 本机实测 | Windows 相关约束、dsh 命令行形态 | **[实测]** |

### 10.2 仍未解决

| 问题 | 状态 |
| --- | --- |
| 官方文章一手 URL | **[未验证]**：README 只链 deepseek.com/en/harness（该页 0 处提及 super-agent），blog 404 |
| "四级过滤"以外的过滤层（是否还有规则引擎） | **[推断]** 原型只有"表 + 强度"，无第三层 |
| 投机执行的具体协议 | **[未验证]**：仅二手提及；仓库 grep `speculat` 0 命中 |
| 原型在真实多仓/多团队下的表现 | **[未验证]**，官方无数据 |
| `engines` 锁 `dsh ^0.2.1-alpha.2` 与 0.2.1-rc.x 的兼容性 | **[未验证]**，需实测（见 docs/03） |

---

## 11. 给实现者的一页清单（T3 可直接照做）

| # | 要做的事 | 依据 |
| --- | --- | --- |
| 1 | 确定性过滤先做：来源 → 范围 → 名单 → 强度，**不花 token** | §3.1 |
| 2 | 语义判定单独一步，输入是"卡片 + 按页读的上下文"，输出是**结构化 Decision** | §2.2、§5 |
| 3 | Decision 支持 4 种：accept / attach / stop / ignore，**逐条独立、一条失败不阻断** | §2.2 |
| 4 | accept 必须同时产 Ticket + Mandate + Subscription + Assignment 四件套 | §9.1 |
| 5 | 订阅投递**绕过过滤但不授予权限**；归属唯一 | §4 |
| 6 | 交接只走结构化工具（ack/report/handback/follow/unrelated），不共享对话历史 | §2.5 |
| 7 | 所有等待设上限（原型是 5s），长任务转后台 | §6.2 |
| 8 | 阈值四件套分开配：8192 字符 / 10 页 / 15 秒 / 100k 字符 | §5.3 |
| 9 | 重启恢复：in-flight 重新排队，最老优先；失败重试 15/30/60s | §7.1 |
| 10 | 巡检只看 6 件事：进程、健康、锁、人的意图、setup、组件错 | §8.1 |
| 11 | 退出码分层：0 正常 / 1 可重启修复 / 2·3 需人 | §8 |
| 12 | **别声称实现了存算分离或模型级 Watchdog**——原型的对应物是单机 + 运维巡检 | §7、§8 |
