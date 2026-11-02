# 11 桌面入口（SuperAgent.exe / .cmd）

> 双击一个文件，把「常驻 loop + 每 5 分钟自检 + 进程外看门狗」拉起来，然后自动打开控制台。
> 所有产物都在本仓库目录内，不写注册表、不写系统目录。

## 1. 用法

| 命令 | 行为 |
| --- | --- |
| `SuperAgent.exe` | 幂等启动全家桶（loop + selfcheck + watchdog），等健康检查通过，打开 `http://127.0.0.1:3082/` |
| `SuperAgent.exe --no-open` | 同上但不打开浏览器（CI/脚本用） |
| `SuperAgent.exe --status` | 打印三个进程的状态与 pidfile |
| `SuperAgent.exe --stop` | 停掉全部并释放端口 |
| `SuperAgent.exe --port=3099` | 换端口 |

`SuperAgent.cmd` 是同一套逻辑的批处理回退版（没有 .NET 的机器用）。

## 2. 它到底做了什么

```
SuperAgent.exe
  -> 从自身路径向上找含 local-superagent\ 的目录（仓库根）
  -> powershell -File scripts\hosting\start-all.ps1 -Port 3082
        -> 已在跑：跳过；缺组件：补启（幂等）
  -> 每 500ms 请求 /api/health，最多 30s
  -> 成功：打印入口并 Process.Start(浏览器)
  -> 失败：打印日志位置，返回退出码 1
```

启动后用 `--status` 能看到三个组件各自 pid；`--stop` 会先让进程自己退出（`/api/stop`），再兜底 kill 端口占用者。

## 3. 怎么构建（约 1 秒，无需网络）

```powershell
& "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /optimize+ /platform:anycpu `
    /out:SuperAgent.exe tools\launcher\SuperAgent.cs
```

产物 7 KB，依赖系统自带的 .NET Framework 4.x，不需要运行时安装。源码只有 `tools/launcher/SuperAgent.cs`（约 130 行）。

## 4. 实测

```text
> SuperAgent.exe --status
repo      : G:\Agent-workspace\dsh-superagent
console   : http://127.0.0.1:3082/
[loop      ] pid=54212  http://127.0.0.1:3082
[selfcheck ] pid=25084
[watchdog  ] pid=57952
```

`--no-open` 在「loop 已在跑、但巡检/看门狗没起」的状态下会**补齐缺失组件**，这是它相对手工 `node bin/superagent.mjs start` 的唯一增量价值。

## 5. 边界

- 不做托盘/开机自启：开机自启交给 `scripts/hosting/install-autostart.ps1`（三级降级，已实测 Ready）。
- 不打包 Node 运行时：exe 只是启动器，Node 仍用系统 PATH 上的 `node`。要完全绿色化，下一步是把 Node 一起塞进 `runtime\` 并改 PATH —— 会多 80 MB，暂不做。
- 不自动更新：升级靠 `git pull`。
