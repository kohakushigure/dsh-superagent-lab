# 15 真仓库托管：第一个 draft PR

> 对象：`kohakushigure/llm-patent-batch-generator`（用户与 DSH 共建的私有仓库）
> 目标：把「issue → 分支 → 受控测试 → 提交 → draft PR → issue 回写」整圈跑在**真仓库**上。
> 约束：只动分支，不碰 main/develop，不合并。

## 1. 结果

**draft PR #45 已开**：https://github.com/kohakushigure/llm-patent-batch-generator/pull/45

| 项 | 值 |
| --- | --- |
| issue | #44（loop 托管试运行） |
| 分支 | `agent/loop-record`（基于 `develop`） |
| 改动 | 仅 `docs/records/loop-trial/`：README + 两份 worker 记录，共 73 行新增 |
| 实跑 | `python -m pytest --collect-only -q` → 1119 tests collected，exit 0 |
| PR 状态 | `isDraft: true`，base `develop` |
| issue 回写 | 已在 #44 留下带 PR 链接与 NOT RUN 的评论 |

## 2. 谁做了什么（权限分离的实际形态）

```
issue 评论（@dsh-superagent-lab）
  → github-poll.mjs 摄取（thread=kohakushigure/llm-patent-batch-generator#44）
  → Router 分诊 → 工单（project 命中 → workdir=本地克隆）
  → Worker（deepseek-flash）：建分支、写文件、跑 pytest --collect-only、git add/commit/push
      · 它尝试 gh pr create → **被白名单拒绝**（这是对的：Worker 不对外）
  → Router.deliver() → Channel → gh pr create --draft → PR #45
  → Router.deliver() 之后 issue 评论（本次由人手动补发，见 §4 缺口）
```

## 3. 这一轮暴露的四个真问题（都已修或已定位）

| # | 现象 | 根因 | 处理 |
| --- | --- | --- | --- |
| 1 | 工单跑在 `.work/` 而不是克隆目录 | 启动脚本里的 PROJECTS JSON 被中文字符写坏（编码问题），解析失败 → 映射为空 | 启动脚本改成**纯 ASCII**，中文只留在 issue 里 |
| 2 | 第一次跑 `max-steps (6)` 截断 | 真模型做完「建分支→写文件→跑测试」就用完 6 步 | 项目规则新增 `maxSteps`（本项目 18）+ `recipe`（显式 WORKFLOW 注入 prompt） |
| 3 | `tasks.report` 一直为空，Channel 拿不到 branch | 之前的补丁被整文件重写覆盖 | 重新落库；并新增 `rule.prBranch` 兜底（报告没 branch 也能开 PR） |
| 4 | `deliver()` 定义了却从没被调用 | 同样被整文件重写覆盖 | 在 `start()` 里重新挂 `p.then(deliver)`，`drain()` 等待回写完成 |

还有一条不是 bug 但值得记：**Worker 自己调 `gh pr create` 被拒绝**——这正是设计意图（合并/开 PR 属于 Router 的 Channel），所以最终 PR 是 Router 开的。

## 4. 仍缺的一块

`Router.deliver()` 的「回写 issue 评论」这一步这次没有自动发生（PR 开出来后，评论是我手补的）。
原因：previously 的 deliver 只覆盖了 PR 分支，没有同时发评论；下一轮会改成「开 PR 成功后自动在 issue 里贴一条」。

## 5. 下一批（goal 继续）

1. deliver 同时做「开 PR + 回写 issue」；
2. 选一个真实代码 issue（#39 RC 通道 / #35 发布门禁），在 `agent/<issue>` 分支上产出代码改动 + 跑对应测试；
3. 每轮都跑 `node --test`（本仓库）与他们的测试入口，结果写进 PR 描述；
4. 全程 draft PR，不合并，等人工审批。
## 6. 第二个工单：自动回写跑通（PR #47）

| 项 | 值 |
| --- | --- |
| issue | #46 |
| 分支 | `agent/loop-record-2` |
| draft PR | **#47**（由 Router 的 Channel 自动开出） |
| issue 回写 | **自动**：评论里带 PR 链接、分支、改动、实跑、NOT RUN（无需人工补） |

回写内容片段：

```
## loop 交付
- draft PR: https://github.com/kohakushigure/llm-patent-batch-generator/pull/47
- 分支: agent/loop-record-2 → develop
- 实跑: git switch -c ...; python -m pytest --collect-only -q -> 1119 tests collected; git add -A; git commit ...; git push -u origin agent/loop-record-2
- NOT RUN: Full test suite (only collection was run, per workflow)
```

## 7. 这一轮又踩到两个坑

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 5 | `deliver()` 明明被调用却直接返回 null，PR/评论都没有 | 里有旧守卫 `rule.channel !== "github"`，把 `github-pr` 一并挡掉 | 改成同时接受 `github` / `github-pr`，并补了一条端到端用例（stub Channel，断言「开 PR + 回写评论」两次调用） |
| 6 | worker 的 `git push` 失败：`Failed to connect to 127.0.0.1:7078` | 全局 `git config http.proxy` 指向的代理已下线 | 清掉全局代理（直连 2.1s），重试后 push 成功 |

这两条都不是理论问题：一条是“守卫写窄了”，一条是“环境依赖悄悄死了”。loop 每跑一轮就把这类问题挤出来一个。
## 8. 第一个真代码任务：#35 失败项 A → draft PR #48

| 项 | 值 |
| --- | --- |
| issue | #35（QA 判定失败，失败项 A：根级 OTA 9 failed） |
| 分支 | `agent/issue-35-ota-version` |
| 改动 | `patent-tool/tests/test_ota_acceptance.py`（+7 / −2） |
| 修法 | 不再硬编码 `1.0.0.27/1.0.0.28`：`CURRENT_TEXT = version_mod.APP_VERSION`，`TARGET_TEXT = _bump_patch(CURRENT_TEXT)` |
| 验证 | `cd patent-tool && python -m pytest tests/test_ota_acceptance.py -q` → **96 passed, 1 skipped**（修复前 9 failed） |
| PR | **#48**（draft，base `develop`，由 Channel 开出） |
| 回写 | 已自动在 #35 留下 PR 链接 + 实跑 + NOT RUN |

## 9. 为跑通它新增的两个能力

| 能力 | 为什么需要 | 实现 |
| --- | --- | --- |
| `fs.replace`（精确单次替换） | 65 KB 的测试文件读进上下文会被 spill 截断，模型无法整文件重写 | 只允许命中一次，命中 0 次或多次都报错返回，不做模糊匹配 |
| 项目级 `runCwd` | 他们的测试入口在 `patent-tool/` 子目录 | 规则里写 `runCwd: "patent-tool"`，`run` 的 cwd 跟着走 |

## 10. 这一轮的环境事故

- 启动脚本被“手写 JSON + 中文”反复写坏（两次），最终改成**用 Node 生成脚本**（`gen-loop-patent.mjs`），彻底消灭转义问题。
- 全局 `git http.proxy` 指向的代理下线，导致 worker `git push` 失败；已清掉全局代理。
- 收尾时推送我们自己的仓库遇到 `Connection was reset`（网络抖动），本地提交 `a136f27` 已生成，下一轮重试。
## 11. 第 3 轮：全量复核 + 收尾

在 `agent/issue-35-ota-version` 上跑**完整根级测试**（不是只跑单文件）：

```
cd patent-tool && python -m pytest tests -q -p no:cacheprovider
→ 255 passed, 3 skipped（10.7s）
```

对照 QA 报告（9 failed / 243 passed / 3 skipped），失败项 A 已消除；PR #48 里已补上这条证据。

顺带核对了 `patent-tool/build/release.ps1`：它现在**已经**把根级 `tests/` 纳入门禁（PR #42 做的），
所以「release 自测没跑根级用例」这个根因也已闭环，不需要再改。

## 12. 本批交付汇总（3 个 draft PR，全部未合并）

| PR | 分支 | 内容 | 证据 |
| --- | --- | --- | --- |
| #45 | `agent/loop-record` | loop 试运行记录（docs） | 1119 tests collected（collect-only） |
| #47 | `agent/loop-record-2` | Channel 自动回写验证（docs） | 同上 |
| #48 | `agent/issue-35-ota-version` | 修 #35 失败项 A：版本从 APP_VERSION 推导 | **255 passed / 3 skipped** |

基线核对：`origin/develop` 仍是 `574d29b`，`main` 未被我们触碰；三个分支都只含各自改动；没有任何合并动作。

## 13. 这套托管现在能做什么（一句话）

给它一条提到 `@dsh-superagent-lab` 的 issue 评论，它会在**自己的分支**上改代码、跑**项目自己的**测试、提交推送，
由 Router 开 **draft PR** 并回写 issue；Worker 全程没有对外发言权，也没有合并权限。
## 14. 第 4 轮：#39 复验证据（无代码改动）

在 `develop @ 574d29b` 上只跑测试、不改代码，把结果回写到 #39：

| 命令 | 结果 |
| --- | --- |
| `cd patent-tool/backend && python -m pytest tests/unit -k ota -q` | 147 passed（exit 0） |
| `cd patent-tool && python -m pytest tests/test_ota_acceptance.py tests/test_ota_publishing.py -q` | 102 passed, 2 skipped |

同时如实列出未覆盖项（真实 Gitee 网络、EXE 级安装回滚、前端文案），并说明这不替代 QA 结论。

这条说明一个边界：**不是每个 issue 都要开 PR**。已实现、等验收的 issue，正确的交付物是「可复核的证据」，而不是再造一个分支。
