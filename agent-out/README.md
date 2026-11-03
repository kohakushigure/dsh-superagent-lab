# agent-out/ — loop 的交付物样本

这个目录里是 **local-superagent 自己跑出来的** 文件（真模型 `deepseek-v4-pro`，workdir = 仓库根）。
保留它们的原因：`docs/08`、`docs/09` 里讲「自 loop」时要有可对照的实物。

| 文件 | 是什么 |
| --- | --- |
| `task_gwnbb85e56352.md` | 从 GitHub 形状事件（thread `kohakushigure/dsh-superagent-lab#2`）派生的工单交付物：控制台给谁用 / 怎么看工单 / 写操作要什么 |
| `task_f6tzv9d39b05d.md` | 读 `docs/07` §0–§1 写的 80 字摘要（第一次在真模型上跑通） |
| `task_f6o30bd24b927.md` | 同上的另一版（markdown 标题格式） |
| `task_f2hqs56fd4c53.md` | 模型列了 46 个 `.work` 残留目录，并**主动说明**「当前工具集无法删除」——工具边界被正确识别 |

被删掉的那些：是自检没有冷却时反复重投的同一批「清理 .work」任务产物，纯噪音，问题已修（见 `docs/09` 第 3 轮）。

## 注意

- 这些文件由模型生成，内容不代表事实；只有 `docs/` 里带「实测」标注的结论才算数。
- 工单真正落盘的位置：项目模式是 `<项目>/agent-out/<taskId>.md`，非项目模式是 `.work/<taskId>/deliverable.md`。
