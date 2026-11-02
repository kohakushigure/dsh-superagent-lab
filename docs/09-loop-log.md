# 09 Loop 运行日志

> 从 2026-11-02 23:07 起，这个仓库进入「loop 模式」：由 loop 自己找缺口、自己补、自己验证。
> 本文件按轮次记录，不美化失败。

## 第 2 轮（23:07–00:05）

### 这一轮补的缺口

| 缺口 | 做法 | 证据 |
| --- | --- | --- |
| 没有真实事件源 | `scripts/hosting/github-poll.mjs`：轮询 issue/PR 评论 → `POST /api/triggers`；thread=`owner/repo#n`、ETag/watermark 去重、限流退避、token 只在内存 | `--dry` 实测：`remaining=4979`（带 token），7 个离线用例 |
| 没有真实大脑 | `config.mjs` 自动加载 `local-superagent/.env.local`（gitignored）；`start-all.ps1` 也加载它 | `/api/health` → `llm=openai`；`metrics.llm.mockCalls=0` |
| 入站无鉴权 | `server.mjs`：设 `SUPERAGENT_AUTH_TOKEN` 后所有 `POST /api/*` 需 `x-auth-token` 或 Bearer | 新增 3 例治理测试（401/200/Bearer/读接口不拦） |
| 数据无保留策略 | `db.mjs#pruneBefore` + `server.mjs` 每小时清理；只删已终结触发器与日志表，任务/会话/订阅不动 | 保留测试：老 trigger/event 被删、live trigger 与 tasks 保留 |
| Watchdog 在进程内 | `scripts/hosting/watchdog-ext.mjs`：进程外探活 → 连续 3 次失败 → 调 `start-all.ps1` 重启，每小时上限 3 次 | 起停实测，日志 `evidence/hosting/watchdog-ext-*.jsonl` |
| 启动入口分散 | `scripts/hosting/start-all.ps1`：一条命令拉起 loop + 自检巡检 + 外部看门狗，幂等、`-Status`/`-Stop` | `start-all -Status` 显示三个 pid |
| 面板并发/端口脆弱 | `engine.mjs#startPanel` 支持 `listen(0)`；测试改用内核分配端口 | 29/29 连续两次通过，不再偶发 `EADDRINUSE` |

### 真实模型跑出来的第一个 bug（值得单独记）

第一次用真模型（`deepseek-v4-pro`）跑「读 docs/07 写摘要」的任务，失败：`watchdog gave up: loop`。

翻事件与消息表看到过程：模型连续 4 次调用 `fs.read` 读同一个文件，工具结果都成功，但它一直在重复——
进程内 watchdog 把「3 次相同 tool 调用」判成死循环，直接放弃任务。

**mock 大脑永远不会这样**（它每步按脚本换动作），所以这个坑只有接真模型才会暴露。

三处修：

1. `WORKER_SYSTEM` 增加硬规则：不得用相同参数重复调用同一工具；一次读取足够；有 step 预算；工具连续报错要换方法。
2. 引擎层加**重复调用闸门**：同一 `(tool,args)` 第二次直接返回“duplicate call blocked”，不执行，并记 `tool_duplicate` 事件。
3. prompt 里加 `ALREADY DONE THIS RUN`：把本轮已做的调用摘要（最近 8 条）塞进上下文，模型失忆也不会原地打转。

修完重跑：任务 `done`，产出真实中文摘要（161 B / 243 B 两份），并且有一个任务在工具能力不足时**自己报告**「列出 46 个目录，删除在当前工具集下不可行」——这是真判断，不是模板。

### 这一轮的数字

| 项 | 值 |
| --- | --- |
| 真实模型调用 | 47 次（`mockCalls=0`） |
| 工单 | 17 个（16 done / 1 failed 是上面那次死循环，已修） |
| 单测 | 29/29（新增治理 3 例、GitHub 源 7 例） |
| CI | `6ee2f64` 上 4 个 job 全绿（ubuntu/windows × test/smoke） |
| 常驻进程 | loop + selfcheck + watchdog-ext 三个，RSS 分别约 60/51/45 MB |

### 一个卡住的事（如实写）

本地提交 `46c84c1` **没能推上去**：`git push` 与 `gh api` 的写请求都卡在本机 HTTP 代理上（读请求正常，`git ls-remote` 秒回；写请求 401/挂起）。
已经写好 `scripts/hosting/publish.ps1`（走 GitHub Git Data API 发布本地提交），等代理恢复或换网络即可一键补推。

### 下一轮的清单

1. 补推 `46c84c1`，让 CI 跑这一轮的代码。
2. 前端入口：把现在这个服务端渲染的极简面板换成真正的前后端（静态 SPA + `/api/*`），能看到工单时间线、决策、订阅、并发水位。
3. 桌面入口：`SuperAgent.exe` / `.cmd` 一键起（约束：全部产物在本仓库目录内）。
4. 论文沉淀：把 ReAct / Reflexion / Voyager / AutoGen / MetaGPT 这类相邻工作收进 `research/papers/`，写一篇“这套设计站在谁的肩膀上”的综述。
5. 让 GitHub source 真正接管：在本仓库开一个 issue，@ 自己，跑通「评论 → 工单 → 交付物」的完整链路。
## 第 3 轮（00:05–00:20）

### 补的缺口

| 缺口 | 做法 | 验证 |
| --- | --- | --- |
| 面板只是服务端拼字符串 | `local-superagent/ui/` 静态控制台（工单/待人工/订阅/事件/投递五个视图，2s 轮询，token 存 localStorage），旧页保留在 `/legacy` | 新增 UI 用例：`/` 返回含 `app.js`、`/app.js` 返回 JS、`/ui/../src/config.mjs` 不可读；30/30 通过 |
| 静态服务有路径穿越风险 | 白名单后缀（html/js/css/svg）+ 目录边界校验 | 同上用例断言拒绝 |
| 设计来源不清楚 | `research/papers/README.md`：ReAct(2210.03629)、Reflexion(2303.11366)、Voyager(2305.16291)、Toolformer(2302.04761)、Generative Agents(2304.03442)、AutoGen(2308.08155)、MetaGPT(2308.00352)、CoALA(2309.02427)、AgentBench(2308.03688)、CAMEL(2303.17760) 逐条对账，并列出 5 条「非论文、工程逼出来」的设计 | 编号经检索核对，未核对的标题单独标注 |
| **巡检自己制造噪音**（截图里暴露） | `selfcheck.mjs` 加同批发现冷却（sha1 签名 + 6h 窗口，`--force` 可绕过） | 连跑两次：第二次输出 `COOLDOWN same findings ... skipping 3 event(s)` |

### 从截图里看出来的问题（值得记）

控制台第一屏就暴露两件事：

1. **同一批发现被反复投递**：`.work` 清理这条在 5 分钟巡检里反复成单（attempt 1→4），因为自检没有冷却。已修（见上）。
2. **中文标题变问号**：某条工单标题是 `? docs/07-... ? ?0 ? ?1`。不是 loop 的错——是我用 PowerShell `Invoke-RestMethod` 投递时 body 编码被当成了非 UTF-8。控制台的投递表单用 `fetch` + `JSON.stringify`，不会有这个问题。

### 这一轮的数字

| 项 | 值 |
| --- | --- |
| 单测 | 30/30（新增 UI 用例） |
| 控制台 | `/` 2418 B、`/app.js` 5537 B、`/styles.css` 3208 B，浏览器渲染截图见 `docs/10` |
| 真实模型 | 仍在跑，`llm=openai`，`mockCalls=0` |
| 待推送 | 3 个本地提交（`46c84c1`、`5e2ad2d`、`a5c11a6`），`git push` 仍被本机代理挡着 |

### 下一轮

1. 补推 3 个提交（换网络或等代理恢复），让 CI 验证这一轮代码。
2. 桌面入口：`SuperAgent.cmd` / 打包 exe（约束：产物全部留在本仓库目录）。
3. GitHub source 端到端：在本仓库开 issue → @ 自己 → 工单 → 交付物，跑通整链。
