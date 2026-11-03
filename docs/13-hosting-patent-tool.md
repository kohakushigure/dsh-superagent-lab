# 13 能不能用这个 loop 自动托管「专利批量化生成工具」

> 对象：`G:\Agent-workspace\专利批量化生成工具`（私有仓库 `kohakushigure/llm-patent-batch-generator`）
> 前提：**没有修改该项目任何文件，也没有修改 local-superagent 的代码**。本文只做可行性判断。
> 所有证据来自只读检查（文件树、AGENTS.md、README、pytest.ini、gh 元数据）。

## 1. 结论先行

| 托管形态 | 现在能不能 | 原因 |
| --- | --- | --- |
| **只读分析**（读代码、答问题、写报告） | 基本可行，但**会违反该项目的目录约定** | worker 只能在自己的 workdir 里写，而我们的实现把产物固定写到 `<workdir>/agent-out/<taskId>.md`；该项目的 AGENTS.md 明确禁止在仓库根散落文件 |
| **执行型托管**（跑 pytest、构建 EXE、提交、开 PR） | **不可行** | 工具白名单里没有 `python`/`pytest`/`npm`/`git commit`；没有 skill 加载；没有回写渠道 |
| **接到渠道上自动响应 issue/PR** | 不可行 | 没有 GitHub channel（只能读，不能评论/开 PR） |
| **只做分诊与记录**（外部 runner 跑命令，把结果喂给 loop） | **可行**（推荐先走这条） | 只需要 `POST /api/triggers`，loop 负责判断"要不要管、归谁管、记什么" |

一句话：**这套 loop 现在适合当"值班员"，不适合当"操作工"。**

## 2. 项目画像（只读检查得到的事实）

| 项 | 值 | 出处 |
| --- | --- | --- |
| 规模 | 6001 个文件 / **1.18 GB**（dist 557 MB、gitee-release 268 MB、temp 296 MB、logs 126 MB） | 目录统计 |
| 技术栈 | Python 3.12 后端 + Node 前端 + pywebview 桌面壳；LangGraph 驱动 | `patent-tool/README.md` |
| 入口 | `python run.py`；无窗口调试 `python run.py --no-window` | 同上 §1 |
| 测试 | pytest，`testpaths=tests`，`pythonpath=.`，`addopts=-q`；含 `run_e2e.py`、`mock_llm_server.py`、`real_online_check.py` | `patent-tool/backend/pytest.ini`、`tests/` |
| 构建 | PyInstaller → `dist/PatentTool/PatentTool.exe`（必须带 `_internal/`） | `patent-tool/README.md` §1 |
| 分支 | `main`（已发布基线，禁直推）/ `develop`（日常集成）/ `test`（QA 侧） | `AGENTS.md` §7 |
| 远端 | 私有 GitHub，**Issues 已开启**，默认分支 `main`，最近推送 2026-10-30 | `gh repo view` |
| 强制规约 | 任何 agent 动手前必须读 `AGENTS.md`，并加载 `.dsh/skills/git-workflow` | `AGENTS.md` 开头 + §7 |
| 敏感物 | `gitee-release/signing/`（发布签名私钥，**禁止删除**）；API Key 存 `%LOCALAPPDATA%\PatentTool\config.json`（不在仓库里） | `AGENTS.md` §6、`patent-tool/README.md` §2 |

本机 `python` 可用：`Python 3.12.3`（`C:\Users\lhz\AppData\Local\Programs\Python\Python312\python.exe`）。

## 3. 四道硬约束（决定"能不能自动托管"的关键）

这些不是配置问题，是 local-superagent 当前实现的能力边界：

### 3.1 工具白名单里没有"跑项目"的能力

`local-superagent/src/tools.mjs` 的 `SHELL_ALLOW` 只放行：

```
git status|diff|log|rev-parse|branch|show
node|npm --version
echo|dir|ls|pwd|type|cat|Get-ChildItem
```

而 `SHELL_FORBIDDEN` 还会拒绝 `[A-Za-z]:[\\/]`（绝对路径）与 `;&|>`$`（串联/重定向）。

**后果**：`python -m pytest`、`npm --prefix frontend run build`、`python run.py --no-window`、`git commit/push/checkout` 全部会被拒绝。也就是说：这个项目的**验证动作与交付动作**，loop 一个都做不了。
**实测（`scripts/hosting/probe-toolbox.mjs`，直接构造 worker 工具箱逐条试）**：

```
DENY shell  python --version                      -> command rejected by whitelist
DENY shell  python -m pytest -q                   -> command rejected by whitelist
DENY shell  npm --prefix frontend run build       -> command rejected by whitelist
DENY shell  git commit -m x                       -> command rejected by whitelist
DENY shell  git push origin main                  -> command rejected by whitelist
DENY git    commit                                -> git subcommand not allowed: commit
DENY fs.read ../../backend/requirements.txt       -> path escapes worker workdir
OK   fs.write agent-out/t.md                      -> wrote (说明 3.4 的违规写盘是真的会发生)
```

另外实测到一个**本机特有**的问题：白名单内的 `shell` 命令虽然放行，但执行时返回 `exit=ENOENT`——因为 `src/tools.mjs` 把 shell 写死成 `pwsh.exe`，而这台机器只有 Windows PowerShell 5.1（`powershell.exe`），没有 `pwsh.exe`。
也就是说：**在这台机器上，worker 的 `shell` 工具整体不可用**，只有专用的 `git` 工具（直接调 git）能用。这进一步压缩了"托管"的可能性。


### 3.2 没有 skill 加载机制

`AGENTS.md` 是硬门槛：

> 任何 git 操作（建分支、提交、PR、tag、验收、发布、hotfix）开始前，先加载本项内置 skill：`skill(name="git-workflow")`

local-superagent 没有 skill 概念（`src/` 里不存在对应实现），worker 也不会去读 `.dsh/skills/`。硬跑就等于**违反项目自己的规约**。

### 3.3 没有回写渠道

loop 只有 `POST /api/triggers` 入口和 `outbox` 表（本地），没有 GitHub channel：不会评论、不会开 PR、不会改 issue 状态。
这个项目的工作流是 **issue → 分支 → PR → 验收**，缺回写就等于"只能干活不能交付"。

### 3.4 产物路径写死，与项目目录约定冲突

项目托管模式下，worker 的交付物固定是 `<workdir>/agent-out/<taskId>.md`（`src/worker.mjs` 的 `deliverableRel`）。
而 `AGENTS.md` §1/§3 明确规定：根目录只留那几样，临时/记录必须进 `temp/<task>/` 或 `docs/records/<task>/`，**禁止在仓库根散落文件**。

**后果**：只要把 `PROJECTS` 指到这个仓库，第一次任务就会在根目录留下 `agent-out/`——违反项目规约。
要想合规，只能把 workdir 指到 `temp/agent/`（gitignored），但那样 worker 就被限制在子目录里，读不到 `backend/`、`tests/` 的代码。**这是一个死结，必须改实现（可配置产物路径）才能解。**

## 4. 任务级可行性矩阵

| 任务 | 现在能做吗 | 卡在哪 |
| --- | --- | --- |
| 读某个模块并解释实现 | ⚠️ 能读，但产物落盘违规 | 3.4 |
| 写一份设计评审报告 | ⚠️ 同上 | 3.4 |
| 跑 `pytest` 并总结失败 | ❌ | 3.1 |
| 修一个 bug 并验证 | ❌ | 3.1（改完不能跑测试）＋3.2 |
| 构建 EXE 并核对产物 | ❌ | 3.1 |
| 提交/开 PR/更新 issue | ❌ | 3.1＋3.3 |
| 盯 issue 并分诊"这条该不该做" | ⚠️ 需要外部喂事件 | 3.3（只能本地记录） |
| 每天汇总仓库健康度（有脏文件吗、测试过了没） | ✅ 可行（外部 runner 跑命令，loop 只记录与判断） | 需方案 A |

## 5. 三种落地路线

### 方案 A（现在就能做，不改任何代码）：值班员模式

把"执行"和"判断"拆开：外部 runner 跑命令，loop 只收事件、做分诊、写记录。

```
Windows 任务计划程序（每小时）
  └─ scripts\patent-health.ps1            # 我们自己的脚本，放在 dsh-superagent 仓库里
       ├─ cd 专利批量化生成工具 && git status --porcelain
       ├─ cd patent-tool/backend && python -m pytest -q
       └─ POST /api/triggers  { source:"http", thread:"patent/health", text:"...结果..." }
            └─ loop 判断：绿=ignore（不打扰人）；红=dispatch（开一张工单）
```

特点：**不碰该项目任何文件和 git 状态**，只读它的输出；loop 的产物落在 dsh-superagent 自己的 `.work/` 里。
这也是官方设计里"主动观察环境事件"的最小实现。

### 方案 B（需要改 local-superagent 4 处，才有"操作工"能力）

| 改动 | 内容 | 工作量 |
| --- | --- | --- |
| B1 | `TOOL_SPEC` 增加 `run` 工具：按**命令白名单**执行（`python -m pytest`、`python run.py --no-window`、`npm --prefix frontend run build`、`git commit/push`），带超时与输出截断 | 半天 |
| B2 | skill 加载：worker 启动时读 `<workdir>/.dsh/skills/*/SKILL.md` 注入上下文 | 半天 |
| B3 | 产物路径可配：`PROJECTS` 支持 `prefix=dir::out=temp/agent`，不再固定 `agent-out/` | 2 小时 |
| B4 | GitHub channel：把工单结论回写成 issue 评论/PR（需要写权限 token，按仓库白名单） | 1 天 |

改完才谈得上"自动托管这个项目"。**本轮按你的要求没有动代码。**

### 方案 C（绕开自建 loop，直接用 DSH 本体）

这个项目已经自带 `.dsh/skills/git-workflow`，说明它本来就是按"给 DSH agent 用"设计的。
用 DSH 的常驻能力（官方原型的形态）跑它，比自建 loop 更贴合 AGENTS.md；代价是要回到 `docs/03` 里那套 DSH 部署路径（Windows 上需要 WSL2/容器）。

## 6. 如果现在就要上：最小可行配置（方案 A）

在 `local-superagent/.env.local` 里**不要**加这个项目（避免 3.4 的违规写盘），只在计划任务里跑巡检脚本，事件 thread 用 `patent/health`（不映射 PROJECTS → 产物落 `.work/`，不碰仓库）。

```
# 不添加这一行（会写进仓库根）
# PROJECTS=...;patent/=G:\Agent-workspace\专利批量化生成工具
```

巡检脚本的判定建议：

| 情况 | 事件文本 | 期望判定 |
| --- | --- | --- |
| pytest 全绿、工作区干净 | `@superagent patent 健康：tests ok, clean` | ignore（不打扰） |
| pytest 有失败 | `@superagent patent 测试失败 N 例，请排查` | dispatch |
| 工作区有未提交改动 | `@superagent patent 工作区不干净：K 个文件` | dispatch（或 observe 只记录） |
| 构建产物缺失/过期 | `@superagent patent 构建产物缺失` | dispatch |

## 7. 风险清单（真托管前必须处理）

1. **签名私钥**：`gitee-release/signing/` 是发布签名私钥，任何自动化都不能碰、不能提交、不能打包进产物。
2. **API Key 位置**：程序把模型 Key 存 `%LOCALAPPDATA%\PatentTool\config.json`，不在仓库内——这是好事，但也意味着"自动生成交底书"必须跑那台机器的用户会话，不能只靠仓库。
3. **规模**：1.18 GB、6001 文件。让模型逐文件读不现实；任何托管都必须先"缩小范围"（只看 `backend/app`、`tests`、`docs/devlog`）。
4. **分支纪律**：`main` 禁直推、`develop` 日常集成、`test` 侧永远不回流。自动托管一旦有写权限，最容易犯的错就是直推 main。
5. **私有仓库 token**：回写渠道需要 `repo` 权限的 token，必须限定到这个仓库，且不能进日志。
6. **AGENTS.md 优先**：与任何 loop 规则冲突时，项目规约优先——这是它自己在第一行写的。

## 8. 建议

| 步骤 | 做什么 | 是否需要改代码 |
| --- | --- | --- |
| 1 | 先做**方案 A**：写 `scripts/patent-health.ps1` + 计划任务，让 loop 只当值班员 | 否 |
| 2 | 观察一周：看它是否只在真出事时说话（噪音率） | 否 |
| 3 | 如果判定质量够，再做 B3（产物路径可配）+ B1（受限 run 工具），让它能跑 `pytest` | 是（半天+半天） |
| 4 | 最后才做 B2/B4（skill + 回写），进入"能交付"的阶段 | 是（1.5 天） |

**现在这一步的结论**：这个项目可以被这套 loop **观察和分诊**，但**不能被它自动修改和交付**——差的不是配置，是四个能力。
## 9. 把他们的规程逐条对到"agent 需要什么能力"

`agent-limits.md` 那 9 条不是建议，是硬约束。逐条翻译成能力需求：

| 他们的规则（原文要点） | agent 必须具备 | local-superagent 现状 |
| --- | --- | --- |
| 任务有界：正式改代码必须关联已授权 Issue | 能读 Issue、能判断"这条有没有授权"、能建分支 | ❌ 无 issue 读取、无分支操作 |
| 禁止垃圾目录：不得建 `temp/tmp/debug/notes/design/reports` | 产物路径受控，不能随手落在仓库根 | ❌ 固定写 `<workdir>/agent-out/` |
| 一个 Issue 一个分支，不重复建 | `git switch -c` / `git branch` | ❌ `git` 工具只允许 status/diff/log/rev-parse/branch/show，不能建分支 |
| 最小有效测试：不循环全量跑 | 能跑指定的 pytest/node 子集 | ❌ 不能跑 python/npm |
| 失败预算：同思路最多 2 次 | 重试要有上限（这条我们有：`WORKER_MAX_ATTEMPTS=2`） | ✅ |
| 不许伪造：没跑标 `NOT RUN`，失败标 `FAIL` | 报告结构里要有"未运行"字段 | ⚠️ 提示词里有反幻觉规则，但没有结构化 NOT RUN 字段 |
| Token 克制：不整仓扫描 | 按需读文件 | ✅ 有 spill/分页，但模型仍可能乱读 |
| 权限边界：可建分支/Draft PR，合并与发版必须人工 | 能开 PR、不能合并 | ❌ 无 channel，不能开 PR |
| 交付简洁：只报改动点/关联 Issue/实跑/阻碍 | 输出模板化 | ⚠️ 自由文本 |

**9 条里当前能满足 2 条（失败预算、Token 克制），其余 7 条都需要补能力。**

## 10. 修正后的建议

### 如果想"接管"，最短路径是给 local-superagent 加 5 项能力（不是 4 项）

| 编号 | 能力 | 对应他们的规则 | 工作量 |
| --- | --- | --- | --- |
| B0 | **gh CLI 工具**（issue list/view、pr create、comment） | 任务有界、权限边界 | 半天 |
| B1 | 受限 `run`（白名单：`python -m pytest` 子集、`npm run typecheck`） | 最小有效测试 | 半天 |
| B2 | skill 加载（读 `.dsh/skills/git-workflow`） | 强制入口 | 半天 |
| B3 | 产物路径可配（`out=temp/agent` 或 `docs/records/<task>/`） | 禁止垃圾目录 | 2 小时 |
| B4 | PR/评论回写 + 结构化报告模板（改动点 / 关联 Issue / 实跑 / NOT RUN / 阻碍） | 交付简洁、不许伪造 | 1 天 |

### 如果只是想"少花人力"，建议不要接管，做这两件事就够

1. **值班员**（方案 A，不改代码）：每小时跑 `git status` + `pytest -q`，异常才投事件。这条今天就能落地。
2. **交接质量守门**：把 issue 里的 `NOT RUN` 与 `FAIL` 抽出来做看板（他们有这个习惯，但靠人记）。

### 一条现实判断

这个仓库的规程是**为"有审批、有分支、有 PR、有 QA 分离"的多 agent 协作**设计的。用我们这套只读+直写的 loop 去接管，等于把一辆有刹车联动的车换成没有刹车的——技术上跑得动，制度上是退步。
真要做，先补 B0–B4，再谈接管。
