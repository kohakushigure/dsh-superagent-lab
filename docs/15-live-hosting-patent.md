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
