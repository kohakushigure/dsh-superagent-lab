# 演示脚本：GitHub Issue 里 @ 机器人 → 工单 → PR

> **状态：整条链路 `[未实测]`。** 卡点在 `docs/03-local-deployment-runbook.md` §3.8 的部署自检（原生 Windows 上是 `spawn env ENOENT`）。本文件是「一旦自检能过，就照这个演」的脚本，不是已跑通的记录。
>
> 前置：A 方案已到 `status.ps1` 退出 **0**（不是 3）。只要还是 3，说明 setup 还没过，别开始。

---

## 0. 演示前必须知道的三件事

1. **不能用上游仓库演示。** `deepseek-ai/dsh-superagent-prototype` 的 Issues / Discussions / PR 已关闭（`has_issues=false`，2026-11-02 核对）。用**你自己的仓库**或 **fork**，并且打开 Issues。
2. **agent 必须是独立账号**，且对目标仓库有写权限（006:33-47）。用自己的账号相当于把自己的身份借给机器人。
3. **`accept` 默认 `observe`**：机器人只记录判断、不执行。演示「真干活」要把 `eval.mode` 从 `observe` 放开，或明确说明本次是观察模式。

---

## 1. 准备（一次性）

### 1.1 目标仓库

```powershell
# 用你自己的仓库；这里以 you/agent-playground 为例
gh repo create agent-playground --private --add-readme --clone
gh repo view you/agent-playground --json hasIssuesEnabled,nameWithOwner
# 预期：{"hasIssuesEnabled":true,"nameWithOwner":"you/agent-playground"}
```

### 1.2 agent 账号的 gh wrapper（Windows 版）

官方给的是 `#!/bin/sh` 脚本（006:36-45），Windows 上要用 `.cmd`：

```bat
rem %USERPROFILE%\.local\bin\gh-agent.cmd
@echo off
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-agent"
"C:\Program Files\GitHub CLI\gh.exe" %*
```

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.local\bin" | Out-Null
# 把上面的内容存成 gh-agent.cmd 后：
& "$env:USERPROFILE\.local\bin\gh-agent.cmd" auth login
& "$env:USERPROFILE\.local\bin\gh-agent.cmd" api user --jq .login
# 预期：agent 账号的 login（不是你的）
```

然后把这个 agent 账号加为仓库协作者并接受邀请（006:33、SETUP.md §4.1）。

> Windows 上还有一层坑：插件找 CLI 时不补 `.exe`，setup 又用 `env` 包进程（见 runbook §3.8）。所以**原生 Windows 上这一步无论如何过不去**，WSL2 里用官方 `sh` wrapper 才是正路。

### 1.3 面板里配四个块

进 `http://127.0.0.1:3082/?token=…` → 侧边栏 **Superagent**（006:143-157）：

| 块 | 填什么 | 注意 |
| --- | --- | --- |
| **Sources → GitHub** | `repository` = `you/agent-playground`；`cli` = agent 的 gh wrapper 绝对路径 | 保存时**先检查** agent 账号能否推送，不通过返回 400 + `setup` 详情 |
| **Policy → 各 Source** | `allowed` 加**你自己的 login** 一行 | 名单为空 → 任何请求都成不了工单（006:148） |
| **Execution** | `directory` 留空（默认 `<stateDir>/work`）；`maxWorkers` 3；`prepare` 见下 | `prepare` 才决定每个工单拿到哪个 checkout |
| **Prompts → team** | 提交作者 = agent 账号；auto-merge = No | 人工合并 |

`prepare` 命令（Windows 下 `git worktree` 版本，参考 006:150-154，把路径换成你的）：

```text
git -C G:\work\agent-playground fetch --no-tags "https://github.com/%DSH_SUPERAGENT_GITHUB_REPOSITORY%.git" "%DSH_SUPERAGENT_GITHUB_PR_HEAD%" &&
git -C G:\work\agent-playground worktree add -b "agent/%DSH_SUPERAGENT_NAME%" "%DSH_SUPERAGENT_DIR%" "%DSH_SUPERAGENT_GITHUB_PR_HEAD%"
```

可用变量（从 `GET /orchestrator/api/settings` 的 `environment.variables` 读到）：`DSH_SUPERAGENT_DIR`、`DSH_SUPERAGENT_NAME`、`DSH_SUPERAGENT_TICKET`、`DSH_SUPERAGENT_GITHUB_REPOSITORY`、`DSH_SUPERAGENT_GITHUB_ACCOUNT`、`DSH_SUPERAGENT_GITHUB_NUMBER`、`DSH_SUPERAGENT_GITHUB_PR_HEAD`、`DSH_SUPERAGENT_BLOCKED_COMMANDS`。

等价 API（省去点页面）：

```powershell
$api='http://127.0.0.1:3082/orchestrator/api'; $h=@{'x-orchestrator-request'='1'}
$s = (Invoke-WebRequest "$api/settings" -Headers $h -UseBasicParsing).Content | ConvertFrom-Json
$rev = ($s.sources | Where-Object id -eq 'github').revision
$body = @{ value=@{ enabled=$true; config=@{ repository='you/agent-playground'; cli="$env:USERPROFILE\.local\bin\gh-agent.cmd" } }; revision=$rev } | ConvertTo-Json -Depth 6
Invoke-WebRequest "$api/settings/source:github" -Method Put -Headers $h -ContentType application/json -Body $body -UseBasicParsing
# 成功：{"saved":true,"revision":n,"policy_changed":…,"restarting":true}  ← 会重启，等 status.ps1 不再退 1
```

---

## 2. 触发：在 Issue 里 @ 机器人

用**允许名单上的账号**（你自己）操作：

```powershell
gh issue create --repo you/agent-playground --title "Add a subtract() helper" --body @"
@<agent-login> please add a subtract(a, b) helper to the calculator module and cover it with one test.
"@
gh issue list --repo you/agent-playground --limit 1
```

规则（006:147、006:231）：
- 必须是 **mention 到 agent 账号**，且作者在 `allowed` 里。
- **改已有 Issue 的正文加 @ 不算**（不会收到通知），要**新发一条评论**。
- 新 Issue / 新评论在下一次轮询（默认 60 s）到达。

---

## 3. 预期时间线

| 时间 | 观测 | 怎么验 |
| --- | --- | --- |
| +0 s | 发送成功 | `gh issue list` 能看到 |
| ≤ 60 s | Source 收到事件 → fast path 过滤 → 若通过则进评估 | `GET /orchestrator/api/sources` 的 `stats` / `filtered` |
| ≤ 60 s | 面板 **Overview** 出现一条 **Ticket** | 面板；或 `GET /state` 的 `load.queued` |
| +1~10 min | Ticket 进入执行：起一个 Executor Session，在 `<stateDir>/work/<短名>` 里干活 | `GET /state` 的 `load.running`；状态库 `ticket` 表 |
| 完成 | 在原 Issue 里回帖，并开 PR（分支最后一段 = `DSH_SUPERAGENT_NAME` 时自动绑到工单） | `gh pr list`；PR 分支形如 `agent/<短名>` |
| 人工 | 你 review → 合并（**不要**开 auto-merge） | — |

判定「这是 Super-agent 而不是普通 bot」的三个看点：
1. **一个工单一个 Session、一个目录**——上下文隔离（官方 02 双层架构）。
2. **多个工单可以并发**（`maxWorkers` 默认 3）。
3. 后续在同一 thread 里的追问**不再经过主 Session**（订阅直通，官方 04 模块）——但注意这是**文章里的机制**，原型里的实现程度要以 `docs/02-official-prototype-digest.md` 与 `docs/06-fact-check.md` 的三态标注为准。

---

## 4. 观察与干预命令

```powershell
$api='http://127.0.0.1:3082/orchestrator/api'; $h=@{'x-orchestrator-request'='1'}

# 全局
(Invoke-WebRequest "$api/state"    -Headers $h -UseBasicParsing).Content
(Invoke-WebRequest "$api/sources"  -Headers $h -UseBasicParsing).Content

# 暂停 / 恢复处理（演示时最容易用上）
Invoke-WebRequest "$api/executor/pause" -Method Post -Headers $h -ContentType application/json -Body '{"paused":true}'  -UseBasicParsing
Invoke-WebRequest "$api/executor/pause" -Method Post -Headers $h -ContentType application/json -Body '{"paused":false}' -UseBasicParsing

# 重跑 / 停止某个工单
Invoke-WebRequest "$api/tickets/<id>/retry" -Method Post -Headers $h -UseBasicParsing
Invoke-WebRequest "$api/tickets/<id>/stop"  -Method Post -Headers $h -UseBasicParsing
```

`POST executor/pause` 与 `GET state/settings/sources` 均 `[已实测通过]`（无需 setup 完成即可用）。`tickets/<id>/retry|stop` 是 `[未实测]`。

---

## 5. 演示脚本（讲给人听的口播顺序）

1. **先立规矩**：机器人只对 `allowed` 名单里的人、在指定仓库里、被 @ 到时才动；默认 `observe` 只记录不执行。
2. **展示一次被拒的请求**：用**不在名单上**的账号 @ 一次 → 面板 `sources` 的 `filtered` 计数 +1，**不产生 Ticket**。这一步最能说明「不会替全队烧注意力」。
3. **展示一次通过的请求**：名单内账号 @ → Ticket 出现 → 说明它在一个**独立 Session + 独立目录**里干活。
4. **并发**：连发 3 个请求 → `load.running` 最多到 `maxWorkers`。
5. **交付**：Issue 回帖 + PR，分支名绑定工单；**人来合并**。
6. **收尾**：说清风险——`danger-full-access`、跑在操作者 OS 账号下、只支持 github.com、这是 research prototype 不是生产件。

---

## 6. 出问题先查这五条

| 症状 | 查什么 |
| --- | --- |
| @ 了但什么都没发生 | 作者在 `allowed` 里吗？Source 开着吗？`paused` 是不是 true？是不是**改正文**而不是发评论？ |
| 面板没 Ticket，但有 `filtered` 计数 | fast path 通过、被 policy/评估挡了；看 `GET sources` 的 `dropped` 与 `dropped.reason` |
| Ticket 失败 `The prepare command failed: …` | `prepare` 里的 clone 路径 / worktree 冲突，按输出改再 retry |
| `status.ps1` 退 2 | 某个 Source 或 `sync:<id>` 报错，重启修不好，看 `errors` 详情 |
| `status.ps1` 退 3 | setup 没过；在原生 Windows 上就是 runbook §3.8 的 `spawn env ENOENT` |
