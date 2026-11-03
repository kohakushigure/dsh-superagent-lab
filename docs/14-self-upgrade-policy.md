# 14 自我改造：让它既能守别人的规矩，又不偏离 Super-agent 的理论

> 目标（用户原话）：**先改造自己**——既要满足专利项目的规则，又要符合原始 Super-agent 的理论；**不改他们的代码**。
> 本文记录改了什么、对应官方哪个概念、对应他们哪条规矩、以及实测证据。

## 1. 一句话总结

这次给 local-superagent 补了三块它原本没有的东西：**受控的执行面**（run/gh 白名单）、**Channel 回写**、**项目级规则**（产物目录/skill 注入/policy）。
三块都能在官方设计里找到对应概念，不是临时打补丁。

## 2. 改动清单

| 能力 | 文件 | 对应官方概念 | 对应他们的规矩 |
| --- | --- | --- | --- |
| `run` 工具（命令前缀白名单 + 超时 + 输出截断） | `src/tools.mjs` | Executor 的工具面（Worker 只拿到被授权的工具） | 「最小有效测试」：只跑指定命令，不能整仓扫 |
| `gh` 工具（只读 + 评论/开 PR，合并/删除不在白名单） | `src/tools.mjs` | Channel 的写侧受 Policy 约束 | 「权限边界」：可建分支/Draft PR，合并发版必须人工 |
| 项目级规则 `PROJECTS` 支持对象（`dir/outDir/run/gh/channel`） | `src/config.mjs` | Policy 的 Source 部分 + 每项目 Mandate 范围 | 「禁止垃圾目录」：产物落到 `temp/agent`，不进仓库根 |
| `policy` 段（版本、allowlist、acceptMode、selfLogin） | `src/config.mjs` | Policy / Mandate（版本化授权） | 「任务有界」：只接受白名单人的请求 |
| Channel：`src/channel.mjs`（`parseThread` / `formatReport` / `postIssueComment`） | 新增 | **Channel**（Thread 的写侧），Router 唯一对外出口 | 「交付简洁 + NOT RUN 如实声明」：结构化报告直接回评到 issue |
| Router.deliver()：任务结束按项目规则回写 | `src/router.mjs` | Channel 由 Router 统一执行，Worker 无对外权限 | 同上 |
| Worker 注入项目 skill（`.dsh/skills/*/SKILL.md`） | `src/worker.mjs` | Skill 作为执行上下文的一部分 | 「强制 skill 入口」 |
| 交付物路径支持 `outDir` | `src/worker.mjs` | 产物落盘位置属于 Policy，不属于模型自由 | 「禁止垃圾目录」 |
| 任务持久化结构化报告（`tasks.report`） | `src/db.mjs` + `src/worker.mjs` | Report（Assignment 向 Ticket 汇报的结构化结果） | 「不许伪造」：ran / NOT RUN / blockers 分字段 |
| 修 shell 二进制探测（`pwsh.exe` 不存在时退回 `powershell.exe`） | `src/tools.mjs` | —（工程修复） | 之前 worker 的 shell 在本机整体不可用 |

## 3. 与官方领域模型的对应关系

```
Policy(版本)  ──► 谁能提需求（allowlist）+ 每项目的 Mandate 范围（run/gh/outDir/channel）
   │
   ├─► Gate：fast path 仍做确定性过滤（source/author/regex/去重/限速）
   ├─► Ticket：dispatch 时记录 project 前缀；workdir 与 outDir 都来自 Policy
   ├─► Executor(Worker)：工具面 = fs + git + run(白名单) + gh(白名单)，仍被 workdir 约束
   └─► Channel：任务结束后由 Router 调用，把结构化报告写回 thread（GitHub issue 评论）
```

三个刻意的取舍：

1. **Worker 永远没有对外说话的能力**：它只能产报告；回写是 Router 的动作（Channel 层）。这与官方「Worker 不直接对外说话」一致。
2. **命令白名单是 Policy 的一部分**，写在项目规则里，不是全局常量——换项目就换授权面。
3. **合并/发版不在任何白名单里**：`gh pr merge`、`gh repo delete` 这类调用会被拒绝（有测试）。

## 4. 实测证据

| 项 | 结果 |
| --- | --- |
| 单测 | **36/36 通过**（新增 4 例：run 白名单、gh 白名单、outDir+skill 注入、channel 格式化与 dry-run） |
| 工具边界（旧行为） | `python --version` / `python -m pytest` / `npm run build` / `git commit` / `git push` 全部 DENY（`scripts/hosting/probe-toolbox.mjs`） |
| Channel 真发评论 | `postIssueComment` 直接调用 gh，成功返回 `#issuecomment-6593408334`（本仓库 issue #1） |
| demo A–J | 全部 PASS（含 spill、watchdog、恢复、面板、鉴权后的决策 resolve） |
| demo K（消融） | **仍会崩**（0xC0000409，Node/libuv 层），属已知问题，消融数字以 `docs/09` §2 的独立测量为准 |

## 5. 现在能不能托管那个专利项目？

能力上：**能跑测试、能回写评论、能按它的 skill 行事、产物不落仓库根**——四道硬约束解决了三道半。

剩下的两件半：

1. **没有 PR 创建**（只有评论）。要开 PR 需要把 `gh pr create` 加入项目白名单，并在报告里带 diff 摘要。
2. **skill 只读 `SKILL.md`**，不读 `references/*.md`（那才是真正的细则）。要补一个多文件读取 + 截断预算。
3. **没在他们仓库实跑过**：按你的要求，一行都没动。真跑之前建议先在他们仓库的 `test` 分支或一个 fork 上试。

## 6. 下一步（按价值排序）

| 优先级 | 事项 | 工作量 |
| --- | --- | --- |
| P0 | skill references 加载（带预算）+ 报告里自动带"跑了什么/没跑什么" | 2 小时 |
| P1 | `gh pr create` 白名单 + PR 描述模板（关联 issue、验证表） | 半天 |
| P2 | 修 demo 的 K 段崩溃（跟托管能力无关，但影响验收观感） | 2 小时 |
| P3 | 在 fork 上做一次完整的 issue → 分支 → 测试 → PR 演练 | 半天 |
## 7. 第二轮（loop-lab）：P0–P3 全部落地

| 项 | 做了什么 | 验证 |
| --- | --- | --- |
| **P0 skill references** | `skillsBlock()` 现在读 `SKILL.md` + `references/*.md`，受 `WORKER_SKILL_BUDGET`（默认 6000 字符）约束，截断处标 `…[truncated]` | 新用例：references 被加载、预算上限生效、截断标记存在 |
| **P1 PR 创建** | `channel.mjs` 新增 `formatPrBody()` 与 `createPullRequest()`（默认 draft，合并永不在此发生）；`router.deliver()` 支持 `channel: "github-pr"` + `report.branch` | 新用例：PR 描述含 Closes #N / 实跑 / NOT RUN；dry-run 输出 `would open agent/x -> develop` |
| **P2 demo 消融崩溃** | 根因：ablation 的 `loadConfig(process.env)` 继承了 `.env.local` 里的真模型 key，K 段变成 20 次真模型调用后崩；同时 `drain()` 没等 Channel 回写 | demo 全绿：**checks passed: 30, failed: 0**（exit 0） |
| **P3 真项目演练** | `scripts/hosting/rehearse-patent.mjs`：把他们的仓库浅克隆到 `dist/rehearse/patent`，用项目规则跑**他们真实存在的命令** | 6/6 通过（见下） |

### P3 演练输出（在克隆上，未触碰原仓库）

```
PASS allowed: pytest version        :: exit=0 / pytest 9.1.1
PASS allowed: their route checker   :: exit=1 / usage: check_pr_route.py [-h] --head HEAD --base BASE
PASS denied: full pytest run        :: command not in project allowlist: python -m pytest -q
PASS denied: git commit             :: command not in project allowlist: git commit -m x
PASS denied: gh pr merge            :: gh call not in project allowlist: pr merge 1 --merge
PASS denied: read outside workdir   :: path escapes worker workdir: ../../etc/passwd
checks 6, failed 0
```

注意第二条：他们的 `check_pr_route.py` 退出码是 1，但**这是它自己的 usage 提示**（缺 `--head/--base`），不是我们的失败——说明命令确实被允许执行了。

### 当前测试口径

- `node --test`：**38/38**
- `node bin/demo.mjs`：**30/30**，exit 0
- 交付物、回写、PR 模板、skill 预算都有专门用例
