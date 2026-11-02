# 08 自 loop 托管实跑记录：让这个 loop 管这个项目

> 2026-11-02 22:58–23:0x，本机。目标：不演示玩具，直接让这套 loop 盯着**它自己的仓库**跑一轮，
> 看它能不能把"项目状态"变成工单、把工单变成产物，并在需要人时停下来问。

## 1. 怎么接的（三个环境变量 + 一个自检源）

```powershell
$env:PROJECTS        = "self/=G:\Agent-workspace\dsh-superagent"   # thread 前缀 self/ 绑定到本仓库
$env:MAX_CONCURRENCY = "2"
$env:SUPERAGENT_STATE_DIR = "local-superagent\evidence\hosting\selfloop-state"
node bin/superagent.mjs start --port 3082
```

事件来源是 `scripts/hosting/selfcheck.mjs`：**只读**地采集项目真实状态（docs 清单与行数、内部链接完整性、`.work` 残留目录、`verify-out` 副本占用、`node --test` 结果、git 工作区），把每条发现变成一条 `@superagent` 事件投给常驻 loop。它自己不写仓库任何文件。

## 2. 这一轮采集到的真实事实

| 事实 | 值 |
| --- | --- |
| docs 文档数 / 总大小 | 8 篇 / 233.2 KB（行数 169–629） |
| 内部链接 | **0 处损坏**（所以没有生成"修链接"工单） |
| 测试 | `node --test` **26 / 26 通过**（exit 0） |
| `.work` 残留任务目录 | **47** 个 |
| `verify-out/clean-*` 副本占用 | 19.9 MB（低于 50 MB 阈值，本轮不生成清理工单） |
| 缺 `docs/08-selfloop.md` | 是（本轮由人补，见 §5） |

## 3. 投递 → 分诊 → 工单（4 进 4 出）

| # | thread | 文本摘要 | 判定 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | `self/hygiene` | 清理 `.work` 下 47 个残留目录，先列出再删 | **dispatch** | 工单 `task_dwo6s7a0c2da3` → `agent-out/task_dwo6s7a0c2da3.md` |
| 2 | `self/docs` | 生成 `docs/08-selfloop.md`，记录自 loop 过程 | **dispatch** | 工单 `task_dwo6vec1c4af3` → `agent-out/task_dwo6vec1c4af3.md` |
| 3 | `self/chatter` | "收到，谢谢" | **ignore** | 不建工单，不打扰人 |
| 4 | `self/policy` | "删除生产库并轮换密钥（policy 探针）" | **need_human** | 进面板待办，等人决定 |

计数：`received=4  decisions=4  dispatched=2  ignored=1  needHuman=1  inflight=0  queued=0`。
四个不同 thread 各自成单——**没有任何跨 thread 合批**（这正是上一轮修掉的串台 bug）。

## 4. 产物落在哪

项目模式下每个工单的交付物是 `agent-out/<taskId>.md`（不是共用一个 `deliverable.md`），所以两个工单同时跑也不会互相覆盖：

```text
agent-out/
  task_dwo6s7a0c2da3.md   571 B   （.work 清理提案）
  task_dwo6vec1c4af3.md   549 B   （docs/08 写作提案）
```

文件是合法 UTF-8（首字节 `23 20 E6 B8 85` = `# 清`）。注意：PowerShell 5.1 用 `Get-Content` 直接看会显示乱码，那是控制台编码问题，不是文件坏了——用 `[System.Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($f))` 看。

## 5. 人在环里做了什么（这才是"托管"的正确姿势）

1. **风险工单：驳回**。`POST /api/decisions/4/resolve {"resolution":"rejected"}` → `resolved=1`，面板待办清零。
2. **清理提案：照做**。作为操作员手工执行 loop 提出的清理——`.work` 从 **47 → 0** 个目录。
3. **文档提案：由人写**。就是这篇 `docs/08-selfloop.md`。

这三步说明这套东西当前的定位：**它提案、你审阅、你执行**。它不是"你说一句它自己改完主干"的东西。

## 6. 必须说清的一点：这一轮的大脑是 mock

本机没有 `OPENAI_API_KEY`，所以 worker 用的是离线 mock 大脑：它会真的接收工单、真的在项目目录里建 `agent-out/<taskId>.md`、真的读写校验、真的回报，但**产出的内容是模板**（"我打算这么做"），不是真的代码改动。

所以这一轮的"自 loop"是**编排层的自托管**：事件采集、分诊、项目绑定、工单隔离、并发闸门、人工待办、面板、恢复——这些都是真的；**内容生成**是桩。

要让内容也真起来，只差一步：

```powershell
$env:OPENAI_BASE_URL = "https://api.deepseek.com/v1"   # 或任何 OpenAI 兼容网关
$env:OPENAI_API_KEY  = "sk-..."
$env:MODEL_ROUTER    = "deepseek-chat"       # 分诊用便宜模型
$env:MODEL_WORKER    = "deepseek-reasoner"   # 干活用强模型
```

适配器路径已经用本地 OpenAI 兼容桩验过（`llm.mode=openai`、24 次调用、`mockCalls=0`，见 [07](07-loop-hosting-feasibility.md) §2.1），换真实网关不需要改代码。

## 7. 当前状态：两个进程，一静一动

| 进程 | 作用 | 实测 |
| --- | --- | --- |
| `superagent start --port 3082` | 常驻 loop：分诊 + 工单 + 面板 | pid 53584，RSS 60.7 MB |
| `selfcheck.mjs --interval 300` | 每 5 分钟只读巡检本项目，只投真实发现 | pid 39372，RSS 51.3 MB |

第二轮巡检（修完之后）**没有发出任何事件**——`.work` 已清空、`docs/08` 已存在、链接 0 损坏、测试 26/26。
这是正确行为：健康状态下它保持沉默（对应官方设计里"健康状态不占空间"那条）。它不说话，说明没事；有事才开口。

停止：

```powershell
node local-superagent/bin/superagent.mjs stop --port 3082   # 停 loop
Stop-Process -Id <watch pid>                               # 停巡检
scripts/hosting/install-autostart.ps1 -Remove               # 清自启（若装过）
```


## 8. 下一轮该补的（自 loop 还缺什么）

1. **真源**：现在只有 `http`/`cli` 两个 source。要它盯 CI、盯 issue，得接 GitHub source（官方原型有，自建这版还没有）。
2. **提案 → 落地**：现在产物是 `agent-out/*.md`，需要人手动应用。可以加一步"把提案 diff 成 patch 并等审批"。
3. **定时自检**：`selfcheck.mjs` 目前手动跑；接一个定时器（或登录自启 + 内部 cron）才叫真正的常驻巡检。
4. **成本控制**：mock 下 0 成本；接真模型后每轮自检的 token 账要单独记（`llm.calls` 已经在 `/api/state` 里）。
