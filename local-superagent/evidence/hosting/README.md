# evidence/hosting — 常驻托管实测证据

由 `scripts/hosting/start-hosted.ps1` 与手动 `POST /api/triggers` 产生（2026-11-02，Windows 11 / Node 24.19.0 / mock 模型）。

| 文件 | 内容 |
| --- | --- |
| `hosted-3189-*.out.log` | 常驻进程 stdout（engine.init / panel.listening / engine.started） |
| `hosted-3189-*.err.log` | stderr（正常为空） |
| `hosted-3189.pid` | 进程号，`-Stop` 时会清理 |
| `autostart-*.log` | 三级自启的实测记录：T1 计划任务 / T2 Startup 文件夹 / T3 HKCU Run，各自 install → -Status → -Remove，末尾附残留探针（三项均 False） |

本轮验证到的事实：

1. `start-hosted.ps1` 首次执行 : spawned pid + health ok；二次执行 : `already running ... nothing to do`（幂等）。
2. `POST /api/triggers {text:'@superagent 写一份 hosted 说明', thread:'host/t1'}` → `{ok:true, decision:'batched', received:1}`，**常驻进程自己的 `router.received` 变成 1**（不是 CLI 进程干的）。
3. `GET /api/state` → `concurrency.inflight=0, queued=0, cap=3`，`tasks=1`。
4. `start-hosted.ps1 -Stop` → 端口释放。
