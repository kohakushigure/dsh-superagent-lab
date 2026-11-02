# 06 事实核查与对抗评审（文档侧）

> 核查人：qa-verifier（独立于 T1 溯源作者与 T2 部署作者）
> 核查时间：2026-11-02 18:42–19:10 +08:00
> 上游基线：`deepseek-ai/dsh-superagent-prototype` @ `6337fc823ce20251c8de8085948165c81aaa701e`（2026-10-31 20:05:39 +0800，提交 feat: add the dsh-superagent research prototype）
> 本机：Windows 11 26200 / 28 逻辑核 / node v24.19.0 / npm 11.17.0 / git 2.47.1.windows.2 / python 3.12.3 / gh 2.103.3 / docker 27.5.1 / corepack 0.35.0 / dsh 0.2.1-rc.4 / pnpm 未安装 / github.com 可达
> 写入范围：本文件（`docs/06-`）。未修改 T1/T2 任何文件。临时取证文件全部落在 `%TEMP%\\dsh-factcheck*`，不污染仓库。

---

## 0. 结论速览（8 条必须先吸收的硬结论）

| # | 结论 | 影响 |
|---|---|---|
| 1 | **官方“五模块”与共享事实的“五模块”不是同一套划分。** 官方按文章章节 2–6 编号：①双层架构 ②事件驱动 ③**全双工多渠道交互** ④存算分离 ⑤Watchdog。而“订阅直通”“上下文当缓存”是②之下的子机制，“异步 start()/stop()”属于③而非⑤。 | T1 必须按官方编号写，或显式标注 [重构] 并给映射表；否则属臆断 |
| 2 | **原型的主 Session（Router）是带 shell 的。** `docs/007-architecture.md:507` 原文：The main Session also has DeepSeek Harness's skill, bash, read … "Avoiding code reads is a prompt rule, not a tool restriction." | “Router 不配 Bash”只是**文章设计**，不是原型实现；不能写成“原型如此” |
| 3 | **官方安装第 4 条命令在本机复现失败**：`dsh superagent --from-default-profile web --dump-config` → `error: unknown option '--from-default-profile'`。可用形式为 `dsh --profile superagent --from-default-profile web --dump-config`（已实测输出配置树）。 | T2 runbook 若照抄官方文档必失败，必须改写并标注实测形式 |
| 4 | **`stateDir` 的 schema 是 `/^\//`（POSIX 绝对路径）**，`G:\...` 与 `C:/...` 均被 schemastery 直接拒绝。 | 官方原型在原生 Windows 上**无法用 Windows 盘符路径做 stateDir**；A 方案的硬阻断 |
| 5 | **`scripts/dsh-superagent` 在 Windows 不可运行**：Python3 脚本 + `import fcntl` + 硬依赖 tmux。本机实测 `import fcntl` → ModuleNotFoundError，tmux NOT FOUND。 | “start 已实测通过”类表述不成立；A 方案止步于此 |
| 6 | **星数严重漂移**：本机 2026-11-02T18:45:11+08:00 采样 = **10,887 星 / 1,124 fork**；explainx.ai（11-01）记 ~5,400 星。写 2800 或 5400 都错。 | 易漂移数据必须带采样时间 |
| 7 | **上游仓库关闭了 Issues / Discussions / PR 入口**（API：`has_issues=false`, `has_discussions=false`, `has_pull_requests=false`, `open_issues_count=0`）。 | “在官方仓库开 Issue @ 机器人”的演示剧本不成立，须改用自有仓库 |
| 8 | **机器限制默认值 T2 注释写错**：实际 `promptMaxChars=100000`、`admissionContextMaxPages=10`、`admissionContextTimeoutMs=15000`（`src/deployment.ts:17,19,22`），T2 文件注释写 200000 / 3 / 20000。 | 属“无出处数值”，须按源码改正 |

### 判定口径（严格三类）

- **成立**：有一手证据（源码行 / 本机实测 / 官方 API / 可复现输出）。
- **不成立**：与一手证据或可复现结果冲突。
- **未证实**：只能追到二手报道，或仓库无对应实现；不得作为结论使用。
- 附加标记 **（须限定）**：方向对，但缺限定词就变成错话（缺“默认”“设计上”“近似”等）。

### 证据等级

`[实测·本机]` 本次亲自执行 · `[源码]` 上游仓库 文件:行 · `[API]` GitHub REST 采样 · `[二手源]` 报道/分析文章 · `[推断]` 我的推理，非事实

---


## A. 事件、文章与四特征

| 声明 | 出处 | 判定 | 修正建议 |
|---|---|---|---|
| 文章标题《Super-agent 设计探索：迈向更自主的 Agent 系统》，2026-10-31 21:36 发布 | IT之家 https://m.ithome.com/html/1020615.htm（页面时间戳 2026-10-31 21:36，作者 问舟）`[二手源]` | 成立 | 引用时必须说明出处为**二手报道**；见下一行 |
| 一手原文可从 DeepSeek 官网拿到 URL | 上游 README 全文只外链 `https://www.deepseek.com/en/harness/`（README:7）；该页 0 处提及 super-agent；`deepseek.com/blog` → 404；全仓库 grep 无文章链接 `[实测·本机]` | **未证实** | 统一写“原文标题据 IT之家 2026-10-31 报道转述；一手 URL 未定位”。禁止编造 deepseek.com 文章链接 |
| 英文标题 "Exploring Super-agent Design: Towards a More Autonomous Agent System" | README.md:5（斜体书名引用）`[源码]` | 成立 | 可放心引用；这是仓库对文章的唯一自证引用 |
| 四特征＝连续、高效、主动、持久 | IT之家原文；explainx.ai 对应 Continuous / Productive / Proactive / Persistent | 成立 | — |
| 观察：一个人通常只能同时跟进 3–5 个活跃 Session | IT之家引文章；explainx 直译 | 成立（须限定） | 必须写“团队观察，未给样本量与量测方法”，不可包装成研究结论 |
| 原型是“DeepSeek 正式产品 / 生产可用” | README.md:3 “Research prototype for reference only, not an official DeepSeek product … Treat it as research code, not production-ready software” `[源码]` | **不成立** | 一律写“研究原型，非正式产品，不宜生产” |
| 原型实现了文章讨论的全部设计 | README.md:5 “Some designs discussed in the article are directions for future development and are not implemented in this prototype.” `[源码]` | **不成立** | 五模块逐条对照必须用三态标注：文章设计 / 原型已实现 / 两者有差距；禁止一句“五模块全部落地” |

---

## B. 五模块与机制（最高优先级）

| 声明 | 出处 | 判定 | 修正建议 |
|---|---|---|---|
| 官方“五模块”＝①Router/Worker 双层 ②事件驱动 Trigger＋两级过滤 ③订阅直通 ④上下文当缓存 ⑤持久在线（存算分离＋Watchdog＋异步工具） | explainx.ai 明确：“The whole design is five modules, numbered in the overview diagram … Numbers match the article's sections 2 to 6”，即 2 双层架构 / 3 事件驱动 / 4 全双工多渠道交互 / 5 存算分离 / 6 Watchdog | **不成立**（作为“官方五模块”） | 二选一：①按官方编号写五个；②保留现划分但开头标注**“本文为便于工程对照的重构，官方编号为 2–6，映射见下表”**并补映射行 |
| 文章第 3 模块含 4 个机制：程序/语义两级过滤 → Thread 订阅直通 → Inline&Spill＋Chain of Recall → 投机执行 | explainx 该节依次给出 "1. Filter first, with code before the model / 2. Route follow-ups by Thread / 3. Treat the context window as a cache / 4. Act ahead: speculative execution" | 成立 | 现划分把 ②③④ 拆成三个并列模块，**漏掉投机执行**；应补回并注明它属第 3 模块 |
| 异步 `start()`/`stop()` 属于“持久在线”模块 | 文章将其放在第 4 模块“全双工多渠道交互”；IT之家原文：“这项异步任务机制已经在 DeepSeek Harness 中实现，但尚未默认开启” | **不成立**（归属错） | 把异步工具移到“全双工交互”；⑤只保留存算分离＋Watchdog |
| 原型实现了存算分离 / BYOM / 云端 loop＋本地 daemon | 原型是单一 `dsh --profile superagent` 进程（006-deployment.md:7 “serves its panel on 127.0.0.1”），由 tmux 托管（scripts/dsh-superagent:166-181），状态在本地 `stateDir`（006:95）`[源码]` | **不成立** | 必须写“存算分离与 BYOM 是文章设计，原型未实现；原型是单机常驻进程” |
| 原型实现了“用模型判断 Worker 是否取得实质进展”的 Watchdog | 原型只有：外部定时检查（006:133-141，跑在**另一个** profile 里的 schedule，带 `--respect-stop`）＋健康项与 4 个退出码（006:113-124、006:181-191）＋`src/app/retry-health.ts`（模型预算重试）。全仓库无 progress-judge 实现 `[源码]` | **不成立** | 拆两句：“外部巡检＋重启＝原型已实现（脚本/退出码/健康项）；模型级进展判断＝文章设计、原型未实现” |
| 原型有 Inline&Spill 与 Chain of Recall 的**同名**实现 | 原型对应物：`textPage`/分页资源、`orchestrator_eval_read` 按 id 展开、`cards.ts` 卡片、context 跟随、tool-result-pruner(8192/4096/1024)、compaction（cordis.patch.yml:79-95、007:540-547）`[源码]` | **未证实**（同名实现） | 写“机制同源、命名与实现不同”，并逐项列对应物；不得直接说“实现了 Inline & Spill” |
| 原型有投机执行（提前开工） | 原型有 Policy rules＋observe/auto（002-authorization.md:97-101），但默认 observe 只记录不执行；无“提前开工”通路 `[源码]` | **未证实** | 写“原型的主动能力＝规则评估后接单，默认只记录（observe）；投机执行未实现” |
| Router“只分派、不执行” | 文章设计：explainx 引原文 "does not execute tasks"、"can run without a Bash tool at all" | 成立（**须限定为设计**） | 加“（文章设计）”；紧接一句“原型主 Session 仍带 shell 与只读文件工具，见 007:507” |
| 原型的主 Session 无 Bash | 007-architecture.md:507 “The main Session also has DeepSeek Harness's skill, bash, read, read_image, job_output, job_list and job_kill. Avoiding code reads is a prompt rule, not a tool restriction.”；cordis.patch.yml:139-162 主 Session preset 含 bash/pwsh，仅 `tool-fs: write:false/edit:false` `[源码]` | **不成立** | 改写为“原型主 Session 保留 shell 与只读 FS，靠提示词约束不去读代码” |
| Worker 不直接对外说话 | 007:532 明确 worker preset 不含“asking or presenting to a person / starting or messaging other Sessions”工具；006:19 Worker 从订阅 Thread 读消息 | 成立 | 保留；可补 6 个应用工具清单（007:517-528） |
| Worker 有“完整工具集” | 007:532 与 cordis.patch.yml:13-19：Worker 保留 file/search/shell/job/web(search, `fetch:false`)/skill/todo/subagent，**排除** web fetch、forked subagent、presenting、questions、plan、plugin manager、scheduling、goals、workflows | 成立（须限定） | 改成“执行所需工具集”，并注明 web fetch 与 forked subagent 被排除，避免“完整”被读成“全部” |
| Router 用轻量模型、Worker 用最强模型 | 文章设计（explainx 引 "a lighter model can usually provide both speed and quality" / "usually need the most capable models"）；原型把模型交给 `eval.model`/`executor.model` 与 profile 默认（006:26） | 成立（设计）／未证实（默认值） | 写“设计意图”；原型侧只能写“模型由 Eval/Execution 设置指定，缺省用 profile 默认模型” |
| 两级过滤：程序层（来源/群组/白名单）后接语义层（LLM 按 policy） | 002-authorization.md:11-16＋admission 表（:58-71）；007:213 `orchestrator_eval`；`prompts/admission.md` | 成立 | 可补精确语义：来源级三态（respond only to explicit requests / treat as candidate / ignore）对应原型 admission cell 三值 `explicit / inferred / ignore` |
| 订阅直通＝后续事件绕过 Router 直达 Worker，多对多 | 002:18-22（"Two paths for a Trigger" 的 Subscriptions 路径）＋007:68-70 事件表＋`thread.subscribed`/`thread.unsubscribed`（007:107） | 成立 | — |
| 订阅直通“绕过授权/等于提权” | 002:20 原文 "This delivery bypasses the gate and grants no new authority. Each Ticket remains limited by its Mandate." | **不成立** | 必须写成“绕过 gate 与新决策，**但不授予任何新权限**；范围仍由 Mandate 限定” |
| 一个 Thread 可挂多个 Worker、一个 Worker 可跟多个 Thread | 002:18-24＋007:66；`markUnrelated`/`followForContext`（007:89-90） | 成立 | — |

---


## C. 实验数值（防篡改区：任何数字改动都必须回到本节）

| 声明 | 出处 | 判定 | 修正建议 |
|---|---|---|---|
| 合成负载 ~300 消息 / ~20 工作请求 / 每方案 5 次 | IT之家；explainx（"about 300 messages … about 20 were work requests … five runs each"） | 成立 | 同时写“coding 由一个只消耗时间的工具模拟，故只衡量调度不衡量编码能力” |
| Super-agent p50 12.4 min / p95 15.7 min | 两源一致（explainx 表格 12.4 / 15.7） | 成立 | — |
| 单 Session＋Subagent p95 29.5 min | 两源一致，但**只属于“中性提示词”那一支** | 成立（**须限定**） | 必须写“中性提示词配置：p50 20.4 / p95 29.5”；另一支是“委派优先提示词：p50 13.8 / p95 29.0”。缺限定会被读成“单 Session 方案 p95=29.5” |
| “5 次均未调用 Subagent” | explainx："With the neutral prompt, the model did not call a subagent in any of the 5 runs"；委派优先配置 4/5 次委派，第 5 次判定“工作太小”自己做，形成长尾 | 成立（**须限定**） | 必须绑定“中性提示词”；否则与“4/5 次委派”直接矛盾 |
| 去掉订阅直通：完成时间不变 | explainx 结论句 "task times did not change"；同一张表给出精确值 12.6 / 15.5 | 成立（**须限定**） | 改写成“无显著变化（p50 12.4→12.6，p95 15.7→15.5）”。只写“不变”会被精确值打脸 |
| 去掉订阅直通：Router 决策数 +30% | explainx "the Router made about 30% more decisions" | 成立 | 加“约”，原文即 "about 30%" |
| 去掉订阅直通：缓存读 Token 2323 万 → 3177 万（+37%） | explainx 表：23.2M → 31.8M；增幅 (3177-2323)/2323 = **+36.8%** | 成立 | 统一一套口径：要么 `23.2M/31.8M`（表格口径），要么 `2323 万/3177 万`（原文精确口径），**不得混用**；增幅写 +37% |
| 单 Session 基线 Token 6.1M / 10.8M（Super-agent 为其 2–4 倍） | explainx 表格与结论 | 成立 | 建议补，用于说明“省时间但费 token”的取舍 |
| Trigger 1/min → 40/min：batch 1.0 → 2.8 | 两源一致 | 成立 | — |
| 单请求耗时 2.5 s → 3.9 s | 两源一致 | 成立 | 可补因果：“合并的 Trigger 在 prefill 阶段并行计算” |
| 单决策分摊推理 6.4 s → 1.6 s | 两源一致（IT之家：“单个决定分摊的推理时间从 6.4 s 降至 1.6 s”） | 成立 | — |
| 由此可推“Super-agent 让编码效率提升 X 倍” | 原文自述 "the results below are indicative only"，且编码被工具模拟 | **不成立**（推断越界） | 禁止把调度实验换算成编码效率；只能写“在合成负载下缩短了从请求到结果的时延” |
| 团队规模下无需分片 Router | explainx 引原文 "no need to shard the Router at the cost of global context continuity" | 成立 | 引用时保留 "at its team size" 前提 |

---

## D. 版本、命令与部署（逐条实测）

### D-1 先决条件与版本

| 声明 | 出处 | 判定 | 修正建议 |
|---|---|---|---|
| Node 22.19+ 或 24+，pnpm，git 2.32+，tmux，Python 3.8+，gh 2.48+ | SETUP.md:27；package.json:53-56 `engines.node = "^22.19.0 \|\| >=24.0.0"` | 成立 | 补一句：**tmux 与 POSIX shell 是这套件在 Windows 上的实际门槛**（见 D-2） |
| 本机 node v24.19.0 / npm 11.17.0 / git 2.47.1 / python 3.12.3 / gh 2.103.3 / docker 27.5.1 / dsh 0.2.1-rc.4 / 28 核 / Win11 26200 | `[实测·本机]` 一次探测 | 成立 | — |
| pnpm 未安装 | `pnpm -v` 空输出 `[实测·本机]` | 成立 | 补齐方式已实测：corepack 0.35.0 存在；隔离 `COREPACK_HOME` 下 `corepack pnpm --version` 输出 **11.7.0**，正好等于 package.json:57 的 `packageManager` |
| 原型版本 ~0.1.0 | package.json:5 `"version": "0.1.0"`，`:6` `private: true` | 成立 | 不要写“v0.1.0 发布”；它是 private 包，未发布到 npm |
| 原型 MIT 许可 | package.json:4、LICENSE、API `license.spdx_id=MIT` | 成立 | — |

### D-2 安装命令（`docs/006-deployment.md:75-81` 逐条）

> **⚠ 先把 `--from-default-profile` 说准，别从一个错跳到另一个错**
> 它**存在**（`dsh --help` 原文：`--from-default-profile <name>  replace a custom profile with a fresh copy of a shipped profile template`）。
> 失败的是**官方那行的参数位置**，不是这个标志。三种形态我各实测过：
> | 形态 | 结果 |
> |---|---|
> | `dsh superagent --from-default-profile web --dump-config`（官方原文位置） | ✗ `error: unknown option '--from-default-profile'`（`<name>` 之后的参数被当 app 参数转发；T2 的 `deploy/logs/dump-config.err.txt` 同一报错） |
> | `dsh --profile <name> --from-default-profile <template> --dump-config` | ✓ 打印完整配置树，并**创建** `profiles/<name>`（隔离 `DSH_HOME` 下复现：生成 cordis.patch.yml 217 / cordis.yml 223 / package.json 213 / pnpm-workspace.yaml 61 字节） |
> | `dsh --profile web --from-default-profile web` | ✗ `profile "web" names shipped profile "web" and cannot be a custom profile target; omit --from-default-profile to use it` |
> 结论：正确写法是 `dsh --profile superagent --from-default-profile web --dump-config`；且 `<template>` 只能落到**自定义** profile 上（`web`、`desktop` 等 shipped 名字不行）。

| 声明 | 出处 | 判定 | 修正建议 |
|---|---|---|---|
| `npm install -g @deepseek-ai/dsh@0.2.1-rc.3` | 006:76；006:83 "The pinned version above is public; other versions must satisfy `engines.dsh` in package.json" | 成立 | 该版本确实存在于 registry。**必须**补：npm `latest`/`next` 已前进到 **0.2.1-rc.5**，另有 `alpha`=0.2.2-alpha.2，本机装的是 rc.4。写清“钉版本是官方有意为之”，别写成“最新版” |
| `git clone <this repository> dsh-superagent && cd dsh-superagent` | 006:77 | 成立（**占位符**） | 文档必须替换成真实 URL 或明确标注占位符；照抄 `<this repository>` 会 clone 失败 |
| `pnpm install && pnpm build` | 006:78 | 成立 `[实测·本机]` | 证据：`deploy/logs/pnpm-install.log` 尾部 "Done in 9.6s using pnpm v11.7.0" 与 `### PNPM_INSTALL_EXIT=0`；`deploy/logs/pnpm-build.log` 尾部两次 "Build complete"、`### PNPM_BUILD_EXIT=0`、产物 `lib/index.js 450.26 kB`。该日志由 T2 产生，我核对了日志原文 |
| `dsh superagent --from-default-profile web --dump-config > /dev/null` | 006:79 | **不成立**（本机 dsh 0.2.1-rc.4） | 实测 `error: unknown option '--from-default-profile'`（exit 1）。原因：`dsh <name> [options]` 把 `<name>` 之后的参数当 app 参数转发，启动器标志须出现在 `--profile` 之后。**可用形式（已实测，输出完整配置树）**：`dsh --profile superagent --from-default-profile web --dump-config`。T2 runbook 必须改成这条，并保留“该命令会**替换**已有 profile 及其 cordis.patch.yml”的警告（006:87 与 `dsh --help` 的 "replace a custom profile with a fresh copy of a shipped profile template" 双重印证） |
| `dsh plugin --profile superagent add "link:$PWD"` | 006:80；`dsh --help` 的 `dsh plugin --profile <name> <pnpm-args...>` | 成立 `[实测·本机]` | 落地证据：`deploy/dsh-home/profiles/superagent/package.json:5` = `"dsh-superagent": "link:G:/.../dsh-superagent-prototype"`；`:9-13` 的 `bundles` 已含 `dsh-superagent`。注意这依赖 pnpm 可用（`dsh plugin` 实为 pnpm 代理） |
| 设 `DSH_HOME` 可把 `~/.dsh` 迁到项目内 | 006:85 "Set `DSH_HOME` to relocate the default `~/.dsh` directory." | **不成立**（本机形态） | 本机 PATH 上的 `dsh` 是桌面版生成的 `%USERPROFILE%\.dsh\bin\dsh.cmd`，**第 5 行硬编码** `set "DSH_HOME=%USERPROFILE%\.dsh"`，环境变量被覆盖。已实测可用路径：项目内包装器 `deploy/bin/dsh-local.cmd` 固定 `DSH_HOME` 到 `deploy/dsh-home`，`--profile web --dump-config` 与 `--profile superagent --dump-config` 均正常输出。文档须写“迁移只能靠包装器／直接调 `desktop-cli.js`，改环境变量无效” |
| `scripts/dsh-superagent start / status` | 006:102-105；SETUP.md:74 | **不成立**（原生 Windows） | `scripts/dsh-superagent:1` = `#!/usr/bin/env python3`；`:10` `import fcntl`；`:166-167` `if not dsh or not shutil.which('tmux'): raise RuntimeError('Both dsh and tmux must be on PATH.')`；`:229` `fcntl.flock(...)`。本机实测 `python -c "import fcntl"` → ModuleNotFoundError（exit 1）；`tmux` NOT FOUND。→ A 方案在 Windows 原生环境**止步于此**，需 WSL2/容器。T2 若写“已实测通过/已启动”，与本条冲突，须改为“未通过＋原因＋替代路径” |
| 面板 `127.0.0.1:3082` | examples/profile.cordis.patch.yml:3-6；006:7；deploy/profile.cordis.patch.yml:27-30 | 成立 | 3082 与桌面版 13399 不冲突（T2 注释属实） |
| 仅单个 github.com 仓库；不支持 GitHub Enterprise Server | 006:25 "A repository on github.com; GitHub Enterprise Server is not supported" | 成立 | — |
| 必须有专属 agent GitHub 账号；GitHub App 不能当 agent | 006:31-33 原文 "A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications." | 成立 | — |
| 授权模型：Host 强制白名单/规则/Mandate；消息、评论、引用文档只能作决策输入，**不能改变权限** | 002-authorization.md:5 "The host enforces allowed lists, rules and Mandates. Messages, comments and quoted documents are inputs to a decision; they cannot change those permissions." | 成立 | 引用保留 "The host enforces" 这一主体，别写成“模型自行判断不放宽” |
| accept 默认 `observe` | 002:97-99 三档表 `off / observe (default) / auto`；SETUP.md:58 | 成立 | 写“三档，默认 observe”；只说“默认 observe”不提三档，会让读者以为只有两档 |
| Executor 持有消息时，主 Session 只能“按人的要求停”；accept/attach/ignore/requeue 会被拒 | 002:26 原文 | 成立 | 这是很好的“边界感”细节，建议 T1 直接引用原文 |
| 每 Ticket 独立 Session＋独立目录（git worktree） | README:7；006:25、006:149-154（prepare 用 worktree）、006:95（`stateDir/work`） | 成立 | 补变量名：`$DSH_SUPERAGENT_GITHUB_REPOSITORY`、`$DSH_SUPERAGENT_GITHUB_PR_HEAD`、`$DSH_SUPERAGENT_TICKET`、`$DSH_SUPERAGENT_NAME`、`$DSH_SUPERAGENT_DIR`（006:152-153） |
| Router 与 Worker 两套 preset 都跑 `danger-full-access`，以操作者 OS 用户身份运行 | 006:19 "Both presets run with `danger-full-access` as the operator's OS user … A worker can execute programs by path and read the operator's home directory." | 成立 | 必须同时给官方缓解：用**专用 OS 账号**，账号内只放 agent 凭据（006:19 同句） |
| 状态就是一个 SQLite 文件（升级前备份 `orchestrator.sqlite`） | 006:236 | 成立 | — |
| 服务 4 个退出码：0 正常 / 1 未运行或重复或报错 / 2 运行但某部件报错 / 3 等待 setup | 006:113-124 表 | 成立 | 这是“外部巡检”能落地的前提，T1/T2 都建议保留 |
| Management API 需 `x-orchestrator-request: 1` 且 Host 必须是 `127.0.0.1:<port>`/`localhost:<port>`，否则 403 | 006:163 | 成立 | 写进任何 curl 示例，否则读者必吃 403 |

---


## E. 字段名与机器限制（T2 配置文件专项）

| 声明 | 出处 | 判定 | 修正建议 |
|---|---|---|---|
| profile 补丁顶层结构：`- id: webserver` / `config: {host, port}`；`- id: dsh-superagent` / `config: {stateDir}`；可选 `- id: dsh-superagent-feishu` / `disabled: false` | examples/profile.cordis.patch.yml 全 12 行；deploy/profile.cordis.patch.yml:27-45 与之一致 | 成立 | 字段名无偏差，可放心沿用 |
| 必填只有 `stateDir`；可选 `promptMaxChars`、`admissionContextMaxPages`、`admissionContextTimeoutMs` | 006:93-96 表；src/deployment.ts:15-23 | 成立 | — |
| `stateDir` 必须是绝对路径 | 006:95；examples:9 注释 `<absolute path, for example /home/me/.dsh/state/superagent>` | 成立（**须限定为 POSIX 风格**） | 见下条，这是 A 方案的硬阻断 |
| `stateDir` 可填 Windows 盘符路径（如 `G:\Agent-workspace\...`） | src/deployment.ts:13 `absolute()` = `s.string().pattern(/^\//)`，`:16` 对 stateDir 用它；dsh 自生成 schema（`--dump-config-schema`）在 `properties.stateDir` 下给出 `"pattern": "^\\/"` | **不成立** `[实测·本机]` | 实测 schemastery 直接拒绝：`G:\Agent-workspace\dsh-superagent\deploy\state` → `ValidationError $.stateDir expect string to match regexp /^\//`；`C:/Users/x` 同样被拒；`/home/me/state` 通过。→ **A 方案在原生 Windows 上必须改走 WSL2/容器**。“把盘符换成 / 开头借当前盘根解析”属未验证取巧，不得写进 runbook 当结论 |
| 机器限制默认值 `promptMaxChars=200000`、`admissionContextMaxPages=3`、`admissionContextTimeoutMs=20000`（T2 配置注释现状） | src/deployment.ts:17 `.default(100000)`、:19 `.default(10)`、:22 `.default(15000)`；范围见 src/limits.ts:8-10（1000–1,000,000 / 1–100 / 1–90,000） | **不成立** | 按源码改成 `100000 / 10 / 15000`，或删掉“默认值”字样只留注释示例。三个数字现在都错，属“无出处数值” |
| 未知配置键会阻止启动并指出键名 | 006:98；src/deployment.ts:39-40 抛 `dsh-superagent configuration has keys it does not use: ...` | 成立 | — |
| `stateDir` 之后不能在面板改 | 006:98 末句 | 成立 | — |

---

## F. 平台适配（Windows 专项，A/B 方案分界依据）

| 声明 | 出处 | 判定 | 修正建议 |
|---|---|---|---|
| 原型整体不支持 Windows | cordis.patch.yml:51-62、151-162 **显式为 win32 切到 `pwsh-sandbox`/`tool-pwsh`**，并用 `disabled: !!js process.platform === 'win32'` 关掉 bash 侧 `[源码]` | **不成立** | 精确表述：**插件本体有 Windows 分支**；不可运行的是 `scripts/dsh-superagent`（Python+fcntl+tmux）与 `stateDir` 的 POSIX 路径约束 |
| SETUP.md 的探测段可直接在 PowerShell 跑 | SETUP.md:21 是一条 POSIX 一行流（`;` 串联、`command -v`、`grep -l -E`、`${DSH_HOME:-$HOME/.dsh}`） | **不成立** | 文档要给 pwsh 等价版（逐项 `Get-Command`/`Test-Path`/`Select-String`），并标注原始行为 POSIX |
| 上游仓库可用于“Issue @ 触发”演示 | API：`has_issues=false`、`has_pull_requests=false`、`has_discussions=false`、`open_issues_count=0`（采样 2026-11-02T18:45:11+08:00）`[API]` | **不成立** | 演示必须用**自己的仓库**（或 fork），runbook 里写明“上游关闭 Issue/PR，演示请在自有仓库进行” |
| 星标数 2,800 | 本机采样 **10,887**（`stargazers_count`，2026-11-02T18:45:11+08:00）；`forks 1,124`、`watchers 59`；explainx.ai（11-01）记 ~5,400 | **不成立** | 写“截至 2026-11-02 18:45 (+08:00) 约 1.09 万星 / 1,124 fork”，或干脆不写星数。任何星数必须带采样时间与采样方 |
| 仓库创建/推送时间 | API：`created_at 2026-10-31T09:32:46Z`、`pushed_at 2026-10-31T12:05:51Z`、`size 775 KB`、`language TypeScript`、`default_branch main` | 成立 | 可用于时间线陈述（2026-10-31 17:32 +08:00 建库 → 20:05 首次提交 → 21:36 文章发布） |

---

## G. 必须改写 / 禁止出现的写法（对抗评审结论）

1. **禁止**“原型实现了文章全部五模块” → README:5 自证相反。改：逐模块三态（设计 / 已实现 / 未实现）。
2. **禁止**把“Router 没有 Bash / Router 不能执行”写成原型事实 → 007:507 自证相反。改：设计意图 + 原型现状两句。
3. **禁止**把 29.5 min 当作“单 Session 方案”的 p95 → 必须指明“中性提示词配置”，并给另一支 13.8/29.0。
4. **禁止**“去掉直通后时间完全不变” → 给精确值 12.6/15.5，写“无显著变化”。
5. **禁止**“订阅直通可绕过授权” → 002:20 明写 bypasses the gate and grants no new authority。
6. **禁止**照抄 006:79 的 `dsh superagent --from-default-profile ...` → 本机实测失败，须写 `dsh --profile superagent --from-default-profile ...` 并附“会替换现有 profile”警告。
7. **禁止**在 Windows 上写“已实测通过 `scripts/dsh-superagent start`” → Python/fcntl/tmux 三处硬阻断，须写失败原文与替代方案。
8. **禁止**把 `G:\...` 当作可用 `stateDir` → schema `/^\//` 会拒。
9. **禁止**出现未标采样时间的星数/浏览量（如“82,700 浏览、1,600 点赞”仅来自 explainx 单方转述，属 `[未证实]`）。
10. **禁止**把“合成负载 + 时间模拟工具”的调度实验换算成“编码效率提升 N 倍”。
11. **禁止**把 0.2.1-rc.3 说成“最新版” → npm `latest` 已是 0.2.1-rc.5。
12. **建议**术语分层：文章层用 Router/Worker；原型层用 main Session/Executor（只有 preset id 叫 `dsh-superagent-router`/`-worker`），首次出现处给映射表。
13. **禁止**写“`--from-default-profile` 不存在／已被移除” → 该标志在 `dsh --help` 里明列，且在正确位置可用（见 D-2 前三种形态）。准确说法只有一种：**位置依赖**——`dsh <name> [options]` 会把 `<name>` 之后的参数当 app 参数转发。
14. **全队统一标记（Lead 定，2026-11-02）**：凡涉及“能不能跑”的结论只允许三档——**[已实测通过] / [已实测失败+原因] / [未实测]**。本报告的 `[实测·本机]` 等价于前两档（成功即“已实测通过”，报错即“已实测失败+原因”并附原文），`[源码]` 与 `[二手源]` 均**不得**单独支撑“能跑”的结论。

---

## H. 待 T1/T2 落盘后的逐条对照（2026-11-02 19:05 检查：两份文档均未落盘）

| 待核对象 | 状态 | 备注 |
|---|---|---|
| docs/01-architecture-deep-dive.md | 未落盘 | 重点核 B 节五模块归属、C 节数值口径 |
| docs/02-official-prototype-digest.md | 未落盘 | 重点核“官方明确不建议生产使用”的原句引用（README:3）与 GHES/账号约束 |
| docs/03-local-deployment-runbook.md | 未落盘 | 重点核 D 节命令与“已实测/未实测”标注是否与日志一致 |
| deploy/env-report.md、deploy/demo-scenario.md | 未落盘（deploy/ 下现仅有 logs/、dsh-home/、profile、bin、backup、upstream、run、state） | 重点核 Windows 阻断项是否如实列出 |
| **已提前核对无误的 T2 产物** | 通过 | `deploy/profile.cordis.patch.yml` 与 `deploy/dsh-home/profiles/superagent/cordis.patch.yml` SHA256 完全一致（`3ABF96FF…D4DF0`），占位符已替换；字段名与 examples 一致；端口 3082 正确；worktree prepare 片段与 006:152-153 一致 |
| **已提前核出问题的 T2 产物** | 需修 | ①三处机器限制默认值写错（E-5）②`stateDir='G:\...'` 与 schema 冲突（E-4）③`deploy/dsh-home` 缺 `desktop` profile 时 `dsh-local.cmd` 报 `profile "desktop" does not exist`（实测；用 `--profile <name>` 形式可正常 dump，故属包装器使用方式问题，非包装器失效）④`deploy/state` 空目录、`deploy/run/*.log` 均 0 字节、`service.pid=15160` → **启动链路尚无一次成功证据** |

---


## I. 复跑附录（任何人可重放上述判定）

```powershell
# 0) 版本面
node -v; npm -v; git --version; python --version; gh --version | Select-Object -First 1
dsh --version; corepack -v; pnpm -v            # pnpm 期望为空

# 1) 隔离的 pnpm（不动全局安装）
$env:COREPACK_HOME = Join-Path $env:TEMP "corepack-home"
cd <prototype-checkout>; corepack pnpm --version   # 期望 11.7.0

# 2) 上游实况（易漂移数据必须此刻采样）
$now = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"; $now
Invoke-RestMethod "https://api.github.com/repos/deepseek-ai/dsh-superagent-prototype" -Headers @{ 'User-Agent'='qa-verifier' } |
  Select-Object stargazers_count, forks_count, has_issues, has_pull_requests, created_at, pushed_at

# 3) 官方第 4 条命令：失败形态 vs 可用形态
dsh superagent --from-default-profile web --dump-config            # 期望: error: unknown option '--from-default-profile'
dsh --profile superagent --from-default-profile web --dump-config  # 期望: 输出 '# == @deepseek-ai/dsh-base' 起的配置树

# 4) stateDir 的 POSIX 约束（schemastery 直接判，脚本见下）
#    s.object({ stateDir: s.string().pattern(/^\//).required() })({ stateDir: 'G:\x' })
#    -> ValidationError $.stateDir expect string to match regexp /^\//

# 5) scripts/dsh-superagent 的 Windows 阻断
python -c "import fcntl"        # 期望: ModuleNotFoundError: No module named 'fcntl'
Get-Command tmux                # 期望: 不存在

# 6) dsh 自生成 schema 里 stateDir 的 pattern
dsh --profile superagent --dump-config-schema > $env:TEMP\schema.json
Select-String -Path $env:TEMP\schema.json -Pattern '"stateDir"' -Context 0,6

# 7) 订阅直通语义（原文）
Select-String -Path <repo>\docs\002-authorization.md -Pattern 'bypasses the gate'
# 期望: This delivery bypasses the gate and grants no new authority.
```

schemastery 判定脚本（Node 24，纯只读）：

```js
const mod = await import('file:///<repo>/node_modules/.pnpm/@deepseek-ai+schemastery@3.18.5-alpha.1/node_modules/@deepseek-ai/schemastery/lib/index.mjs')
const s = mod.default ?? mod
const C = s.object({ stateDir: s.string().pattern(/^\//).required() })
for (const v of ['G:\\Agent-workspace\\x', '/home/me/state', 'C:/Users/x']) {
  try { console.log('ACCEPT', v, C({ stateDir: v }).stateDir) }
  catch (e) { console.log('REJECT', v, e.constructor.name, e.message) }
}
// 实测输出: REJECT G:\... ValidationError ; ACCEPT /home/me/state ; REJECT C:/Users/x ValidationError
```

### 我的取证副产物（均在 %TEMP%，不在仓库内）

- `%TEMP%\dsh-factcheck\up`：`--depth 1` 克隆的上游 @ 6337fc8
- `%TEMP%\dsh-factcheck\pathtest2.mjs`：schemastery pattern 判定脚本
- `%TEMP%\dsh-factcheck\schema.json`：`--dump-config-schema` 输出（1.82 MB）

### 必须披露的边界（不许当成已证实）

1. **一手文章 URL 未定位**：标题/时间/数值靠 IT之家（2026-10-31）与 explainx.ai（11-01）交叉。两源在全部关键数值上一致，但都不是官方原文。引用必须标“二手源”。
2. **npm 0.2.1-rc.3 只核到“存在于 registry”，未安装复跑**。命令形态的失败结论基于本机 rc.4；rc.3 是否同样失败 `[未证实]`。
3. **第 3 条命令验证动到了用户目录**：本机 `dsh.cmd` 硬编码 `DSH_HOME`，我设的临时 `DSH_HOME` 被覆盖，命令实际作用于 `C:\Users\<me>\.dsh`。事后核对：`~/.dsh/profiles/superagent` 下 4 个文件仍为 217/223/214/61 字节、mtime 均为 18:45:32（由部署轨 18:45 创建并已备份到 `deploy/backup/dsh-profiles-superagent/`）、`cordis.patch.yml` 内容仍是原始模板 `[]`，**未见内容变更**；但未做前后哈希对比，故只能说“未见覆盖迹象”，不能说“零写入”。
4. **`dsh-local.cmd` 报 `profile "desktop" does not exist`** 只在 `<name> <launcher-flags>` 形态触发；同一包装器用 `--profile web/superagent` 均工作。归因为“参数形态 + 桌面版 `DSH_DESKTOP_DEFAULT_PROFILE=desktop` 依赖”，此归因是 `[推断]`。
5. **我没跑 `pnpm test`/`pnpm check`**：属 T2 范围。本报告对“测试是否通过”不做任何断言。

---

## J. 签名

- 核查者：qa-verifier（T4）
- 可复现：本文件 I 节命令 + 各表标注的采样时间即可重放全部判定
- 合规：未修改他人文件；未 `git commit`/`git push`；未写入 `~/.dsh` 配置（边界见 I-3）


## K. 复核记录与共识（含对 Lead 归纳的再校正）

1. **2026-11-02 19:1x，Lead 采纳本报告为事实基准**，明确：官方五模块按文章编号 02–06 写；一律三态标注（文章设计 / 原型已实现 / 两者有差距）；禁止“五模块已全部落地”；易漂移数据必须带采样时间与采样方。→ 与本文件 B 节、F 节、G 节一致，无需回退。
2. **术语对齐（补 Lead 的表述）**：文章层的 Router = 原型的 **Main Session**（preset id `dsh-superagent-router`）；文章层的 Worker = 原型的 **Executor Session**（preset id `dsh-superagent-worker`，官方中文名“dsh-superagent 执行器”）。写文档时建议首次出现就给这张对照，避免“Router 评判”这类含混表述。
3. **对 Lead 第 4 条的再校正（重要）**：Lead 归纳为“`--from-default-profile` 不存在（dsh 0.2.1-rc.4 实测 unknown option）”。**该标志存在**，`dsh --help` 明列，且在正确位置可用（见 D-2 前的三形态表）。准确说法：
   - 失败原因＝**位置**（`<name>` 之后的参数被转发给 app），不是标志缺失；
   - 正确形态＝`dsh --profile superagent --from-default-profile web --dump-config`；
   - 附加约束＝目标 profile 名不能是 shipped 名字（`web`/`desktop`）。
   若 T1/T2 照“标志不存在”写，会把一个已经能跑的命令写成不可用，且无法解释 `SETUP.md`/`006-deployment.md` 为何这么写——属新的错误，须按本表修正。
4. **已发协作文档**：本报告的 D/E/F 节结论已于 19:10 前后分别发给 deploy-runner（4 条可执行修正：命令位置、stateDir POSIX、三个默认值、scripts 的 Windows 阻断）与 source-analyst（3 条：五模块归属、设计与实现三态、数值限定词）。
5. **未改变的范围声明**：本文件仍只写 `docs/06-`；未改 T1/T2 文件；未 `git commit`/`git push`。经 Lead 采纳后，本报告可作为 T5（`docs/05-validation-report.md`）判定“文档是否已按要求修正”的比对基准。

---


## L. Lead 二次更正后的落定（2026-11-02）

1. **Lead 已采纳本报告 K-3 的再校正**：`--from-default-profile` **存在**，失败原因是参数位置；全队不得写“该标志不存在/被移除”。三种形态见 D-2 前的对照表（我实测：官方原样位置失败；`--profile <name> --from-default-profile <template>` 成功并创建 profile；template 不能落到 shipped 名字上）。
2. **Lead 重申并已并入 G 节的两条**：①“Router 不配 Bash”只能写【文章设计】，原型主 Session 带 bash/pwsh、仅 `tool-fs` 只读（007:507 + cordis.patch.yml:139-162）；②机器限制默认值 = `100000 / 10 / 15000`（src/deployment.ts:17,19,22），T2 的 `200000 / 3 / 20000` 必须改。
3. **对 T2 的硬约束（Lead 转达）**：`deploy/state` 空、`deploy/run/*.log` 0 字节、`service.pid` 存在但无成功证据 → docs/03 **严禁**出现“已跑通/已实测通过”，须写“启动链路未成功，卡点 = stateDir 的 POSIX 约束 + `scripts/dsh-superagent` 依赖 fcntl/tmux”。这一条与本报告 D-2、E-4、F 节完全一致。
4. **三标记规范已落地**为 G-14：`[已实测通过]` / `[已实测失败+原因]` / `[未实测]`。本报告所有“能不能跑”的结论已按此归位：

| 结论 | 标记 |
|---|---|
| `pnpm install && pnpm build` | [已实测通过]（T2 日志 `PNPM_INSTALL_EXIT=0` / `PNPM_BUILD_EXIT=0`，我核对了原文） |
| `dsh plugin --profile superagent add "link:$PWD"` | [已实测通过]（profile package.json:5/:9-13 落地） |
| `dsh --profile <name> --from-default-profile web --dump-config` | [已实测通过]（隔离 DSH_HOME 下打印配置树并建 profile） |
| `dsh <name> --from-default-profile ...`（官方原样） | [已实测失败+原因] `unknown option '--from-default-profile'` |
| `scripts/dsh-superagent start`（原生 Windows） | [已实测失败+原因] `import fcntl` → ModuleNotFoundError；tmux NOT FOUND |
| `stateDir='G:\...'` | [已实测失败+原因] `ValidationError $.stateDir expect string to match regexp /^\//` |
| `pnpm test` / `pnpm check` | [未实测]（T2 范围，本报告不断言） |
| 面板 3082 真正渲染出页面 | [未实测]（只核到配置与端口，未启动服务） |

---

