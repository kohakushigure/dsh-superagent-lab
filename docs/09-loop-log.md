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
