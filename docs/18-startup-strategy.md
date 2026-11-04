# 18 启动策略：DSH 启动时踢一脚，但别让它拥有 loop

## 结论

可以，而且建议做——但 **DSH 只负责「踢一脚」，不负责「持有」**。

## 为什么不把 loop 挂在 DSH 生命周期上

1. DSH 重启很频繁（每次会话端口都变）——loop 作为它的子进程会被反复杀掉；
2. DSH 崩溃会连坐 loop；反过来 loop 卡住也不该拖慢 DSH 启动；
3. 托管的价值在于「DSH 没开也在跑」（比如昨天那种无人值守）。

## 现在实际的三层（已落地并验证）

| 层 | 机制 | 作用 | 验证 |
| --- | --- | --- | --- |
| L1 保活 | 计划任务 `local-superagent-keepalive`，每 **10 分钟**幂等跑一次 `start-all.ps1` | 覆盖崩溃、睡眠恢复、手动 kill | `LastTaskResult=0`，进程数稳定为 2 |
| L1 登录 | 原任务 `local-superagent`（AtLogOn） | 开机登录即起 | `LastTaskResult=0` |
| L2 快速路径 | `scripts/hosting/dsh-with-loop.cmd` | 启动 DSH 前顺手踢一脚，不用等 10 分钟 | 冒烟通过，启动后仍是 2 个进程 |
| L3 进程内 | `watchdog-ext.mjs` + `selfcheck.mjs` | loop 卡死/停滞时重启、定期自检 | 已有 |

## L2 怎么用

```
scripts\hosting\dsh-with-loop.cmd "C:\path\to\DSH.exe" [args...]
```

它做两件事：

1. `start /b powershell -File start-all.ps1 -Port 3082 -Hidden >nul 2>&1`（不等待、幂等）；
2. 立刻 `start "" %*` 拉起 DSH。

loop 进程的父进程是 cmd，不是 DSH——所以关掉 DSH 不会带走 loop。

## 关于「是否默认接管项目」

建议按仓库开关：只有 `PROJECTS` 里配了规则的 thread 才托管；没配的一律不接管。
现在专利项目就是这样（`kohakushigure/llm-patent-batch-generator#` → 本地克隆）。

## 一个限制

计划任务用 `-Hidden` 传参，而 `start-all.ps1` 现在接受 `-Hidden`（见 docs/17）。
如果重写这个脚本，**必须保留这个参数**，否则又会静默 result=1。
