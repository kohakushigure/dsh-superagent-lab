# 07 本机能不能做 loop 托管？小项目能不能托管？

> 面向"我这种电脑"的可行性判断：Windows 11 / 28 逻辑核 / Node 24 / 无 GPU / 无 API Key。
> 数据来自 2026-11-02 22:09–22:2x 的实测，命令与脚本都在 `scripts/hosting/`，日志在 `local-superagent/evidence/hosting/`。

## 0. 结论

**能。** 而且这台机器跑一个常驻 loop 的成本低到可以忽略：空载 CPU 0.00%、RSS 约 60 MB、16 线程；分离进程在启动它的 shell 退出后继续活着。

**小项目能托管，但有四个硬前提**（缺一个就会出事）：

1. 项目目录必须是 git 干净起点（worker 直接改真实文件，不备份）。
2. 项目里不能有生产密钥/生产库连接串（工具白名单只限制"写到哪"，不限制"写什么"）。
3. 并发必须设上限（默认 3），否则突发事件会把 N 个 worker 同时打给模型。
4. 用独立账号或独立目录，不要拿它直接改主干分支。

**不能托管的东西**：需要长时间运行的服务进程、需要 GPU/大内存的构建、含生产凭据的仓库、多人共享主干且要求强评审的仓库。

## 1. 三档托管形态（按投入从低到高）

| 档 | 形态 | 命令 | 适用 | 代价 |
| --- | --- | --- | --- | --- |
| L1 | 前台跑，关窗口即停 | `node bin/superagent.mjs start` | 试玩、调试 | 0 |
| L2 | 分离常驻，关终端不死 | `scripts/hosting/start-hosted.ps1` | 日常托管（推荐） | 要手动起，重启后要再起 |
| L3 | 登录自启，长期无人值守 | `install-autostart.ps1` | 一周以上的持续托管 | 出问题要自己看日志/面板 |

三档用的是同一个进程、同一个数据库，区别只在"谁把它拉起来"。

## 2. 本机实测基线（只记实测，不估算）

| 指标 | 实测值 | 测量方式 |
| --- | --- | --- |
| 空载 CPU | **0.00%**（5 秒采样内 0 ms） | `TotalProcessorTime` 前后差 |
| 常驻内存 | **59.4–61.0 MB**（RSS） | `Get-Process.WorkingSet64` |
| 线程数 | **16** | 同上 |
| 句柄数 | **265–267**（40 秒内无增长） | 同上 |
| 父 shell 退出后存活 | **是**（新进程里仍能查到 pid 与端口） | 分离进程 + 另起 pwsh 复查 |
| 摄取延迟 | POST 返回即 `received` +1，无排队 | `/api/triggers` 返回值 |
| 面板响应 | `/api/health`、`/api/state` 亚秒级 | Invoke-RestMethod |
| 单任务端到端（mock 大脑） | < 1 秒 | demo 日志 |
| 项目绑定 | 命中前缀 → 任务 workdir = 项目目录，交付物写进该项目 | `tasks.workdir/project` |

### 2.1 真实模型延迟下（本地 OpenAI 兼容桩，1.5 s/次调用，8 条事件 / 8 个 thread）

| cap | 峰值 inflight | 峰值排队 | 总耗时 | 每任务平均 | 等效吞吐 |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | **4** | 25,960 ms | 3,245 ms | ≈ 1,110 任务/小时 |
| 2 | 2 | 0 | 15,400 ms | 1,925 ms | ≈ 1,870 任务/小时 |
| 4 | **2** | 0 | 15,304 ms | 1,913 ms | ≈ 1,880 任务/小时 |

三个必须一起看的事实：

1. **cap 从 2 加到 4 只快 0.6%，是噪声**。原因在源码不在参数：`router.tick()` 对每个 thread 串行 `await decideBatch()`，8 个 thread 就是 8 × 1.5 s ≈ 12 s 的纯派发时间——相当于每 1.5 s 才放一个任务进池；而每个任务只占 2 × 1.5 s = 3 s，稳态并发天然收敛在 3.0/1.5 = 2。桩侧独立统计印证：cap=2/4 时桩观测到的并发峰值都是 3（2 worker + 1 router），从未到 4。
2. **cap=1 是唯一真正改变行为的取值**：排队涨到 4、总耗时 ×1.68。所以"设上限"这件事在 1 与 2 之间有意义，3 以上在当前实现里是心理安慰。
3. **OpenAI 适配器路径本轮从"未实测"升级为"已实测通过"**：`llm.mode=openai`、`calls=24`（8 router + 16 worker）、`mockCalls=0`，桩收到的请求数 24 == 应用自报 24；`response_format`、`choices[0].message.content` 解析、`usage` 透传全部走通。失败注入（HTTP 500）时任务被记为 failed、`lastError` 保留原文、进程存活继续响应面板。

> 口径：桩按 `src/filter.mjs` 与 `src/worker.mjs` 实际解析的字段构造 JSON，不是猜协议；每任务 2 次关键路径调用 + 1 次 router 调用。原始日志见 `local-superagent/evidence/hosting/latency-report.md` 与同目录 samples/stub jsonl。


## 3. 我实测踩到的四个坑（已修三个，一个是我自己的错）

| # | 现象 | 根因 | 状态 |
| --- | --- | --- | --- |
| 1 | 常驻进程 `router.received` 恒为 0，投递的事件全被 CLI 进程自己吃掉了 | `submit` 是 one-shot client，自己 `new Engine()` 干活；常驻进程没有任何摄取入口 | **已修**：`POST /api/triggers` 直接交给面板所属 Engine |
| 2 | 突发 20 条会同时起 20 个 worker | `router.schedule()` 直接 `worker.run()`，无队列、无上限 | **已修**：`MAX_CONCURRENCY`（默认 3，0=不限）+ 队列 + 结束补位 |
| 3 | 8 条事件（8 个不同 thread、跨两个项目）被合成 1 个决策 1 个任务，intent 拼在一起，thread 取第一个到达的 | 批量分组是全局的，没有按 thread 分组 | **已修**：按 `thread_id` 分组后再合批（跨 thread 绝不合批） |
| 4 | `PROJECTS` 设了却不生效，任务仍落 `.work/<taskId>` | 我的 demo 脚本漏了等号，写成 `demo-blog/<path>`；正确是 `demo-blog/=<path>` | **我的错，不是实现问题**，修脚本后立刻正常 |
| 5 | 自启 `-Remove` 后仍有残留：删了 Startup，`-Status` 却报 `ACTIVE: hkcu-run` | `-Remove` 只清"当前 ACTIVE 那一级"，另两级留着；上一轮的残留被下一轮当成新状态 | **已修**：`-Remove` 无条件清三级、install 前先全清、多级并存时打印 WARN |

第 3 条最值得记：它只在"多项目 + 突发"时暴露，单项目测试永远发现不了。这也是为什么托管多个项目时，`PROJECTS` 必须和 thread 前缀一起设计。

## 4. 项目隔离是怎么做到的

两层，缺一不可：

1. **绑定层**：`PROJECTS` 把 thread 前缀映射到真实目录（最长前缀优先）。命中的任务 `workdir` = 该项目目录；没命中的仍用隔离目录 `.work/<taskId>/`。
2. **写入层**：worker 的工具箱把路径解析后必须落在 workdir 之内；`../`、绝对路径、盘符路径都会被拒并计入 `denied`。

实测（`scripts/hosting/tool-probe.mjs` 同类探针）：

- `../demo-guest/hacked.md` → `denied:true`，`denied` 计数 +1
- `G:\Windows\Temp\hacked.md` → `denied:true`
- 项目内 `ok.md` → 成功

> 注意：隔离是"进程内 + 路径约束"，不是 OS 级沙箱。worker 的 shell 仍以你的用户身份运行，白名单只放行 `git status/diff/log/…` 与 `echo/dir/pwd` 这类只读命令。真要跑不可信代码，请用独立系统账号或容器。

## 5. 自启：三级降级（本机实测）

| 级 | 方式 | 需要管理员 | 本机结果 |
| --- | --- | --- | --- |
| 1 | Scheduled Task | **多数情况需要** | **不稳定**：我的两次尝试都被拒（`Access is denied`，`schtasks /Create` 与 `Register-ScheduledTask` 均拒），而独立验收轮次能成功注册（任务状态 Ready，指向 `start-hosted.ps1`）。差异来自执行上下文/账户权限，所以脚本必须自带降级，不能假设这一级可用 |
| 2 | Startup 文件夹 | 不需要 | **可写**（已建/删探针验证） |
| 3 | `HKCU\...\Run` | 不需要 | **可写**（已建/删探针验证） |

`install-autostart.ps1` 会按 1→2→3 自动降级，并打印实际采用的那一级；`-Status` 显示 `ACTIVE: scheduled-task|startup-folder|hkcu-run|none`，多级并存时打印 `WARN: multiple levels present ...`；`-Remove` **无条件清三级**（不是只清当前生效那一级——这正是我实测踩到的第 5 个坑，见 §3）。

## 6. 容量怎么估（别拍脑袋）

常驻 loop 的吞吐由三件事决定：并发上限、单任务模型延迟、单任务步数。

```
每小时任务数 ≈ 3600 / (单任务平均耗时) × 并发上限
单任务平均耗时 ≈ 模型平均延迟 × 平均步数 + 工具耗时
```

本机实测的模型延迟数据见 §2 的实测表（用本地 OpenAI 兼容桩注入固定延迟测得）。经验值：

- 实测（1.5 s/次调用、每任务 2 次关键调用）：cap=2 时 **≈ 1,870 任务/小时**；cap=1 时 ≈ 1,110；cap=4 与 cap=2 无差别
- 但这个数字被 **Router 串行派发** 钉死（每 thread 一次 1.5 s 决策，派发速率 ≈ 1/1.5 s），不是被 CPU 钉死
- 换真实网关后要打 3–5 折（网络 RTT、限流、重试）；任务步数变多时 cap 的作用点会后移

真正的瓶颈通常不是 CPU（空载 0%），而是：模型额度、API 限流、以及你愿意付多少钱。

## 7. 小项目适配清单

| 适合托管 | 为什么 | 注意 |
| --- | --- | --- |
| 个人脚本库 / CLI 小工具 | 改动小、可回滚、git 干净 | 先建分支，别直接改主干 |
| 文档站 / README / CHANGELOG | 低风险、验收直观 | 让 worker 只碰 docs/ |
| 测试补全、lint 修复 | 结果可自动验证 | 跑完要人工看 diff |
| Issue 分诊 / 需求整理 | 不需要改代码 | 用 observe 模式先看它想干什么 |
| 小爬虫 / 数据整理脚本 | 任务边界清楚 | 别让它碰真实账号 |

| 不适合 | 原因 |
| --- | --- |
| 需要常驻服务的项目（web server、worker 队列） | 它是任务制，不是进程守护 |
| 含生产密钥 / 生产库的项目 | 工具白名单不限制"写什么"，只限制"写到哪" |
| 多人共享主干、强评审流程 | 它会直接产出改动，评审成本转移给你 |
| 大仓（>1 GB / 编译 10 分钟以上） | 每个任务都在真实目录里跑，编译时间直接吃吞吐 |
| 需要 GPU 的训练/推理 | 这台机器没有可用 GPU 给 worker |

## 8. 上线清单（照这个顺序做，别跳）

1. `git status` 必须干净；给托管建一个分支（`git switch -c agent/work`）。
2. 选目录：`PROJECTS="proj/=D:\code\proj"`，只映射你允许它改的项目。
3. 设并发：`MAX_CONCURRENCY=3`（先 2，稳了再加）。
4. 起服务：`scripts/hosting/start-hosted.ps1`，然后打开面板确认 `inflight/queued` 正常。
5. 先投一条低风险任务（例如"补一段 README"），看 diff、看日志、看 `denied` 计数。
6. 稳定一天后再上 `install-autostart.ps1` 做 L3；同时把面板端口只绑 `127.0.0.1`。

## 9. 还没验证的（别当已验证）

- 真实模型网关下的延迟/限流/失败率（本机无 Key；适配器路径已用本地桩验通，但真实网关注释了网络抖动与配额）。
- 多步任务（默认 `WORKER_MAX_STEPS=6`）下的并发形态；本轮桩只跑到 2 次关键调用/任务。
- `WATCHDOG_AUTO_RESTART=true` 的自动重启链路（失败注入试验特意关掉，只证明了"不崩 + 失败被记录"）。
- 真实 GitHub/飞书渠道（当前只有 `http`/`cli` 两个 source）。
- 跨机/存算分离：这套是单机常驻，没有云端 loop + 本地仓库的分离能力。
- 长时间 soak（> 数小时）与内存曲线；本轮只做了 40 秒到几分钟级别的观测。
- 计划任务路径在**有权限账户**下的长期稳定性（本机被拒，只验证了降级链）。

## 10. 复跑

```powershell
powershell.exe -NoProfile -File scripts\hosting\measure-loop.ps1 -Port 3082 -Burst 20 -SoakSeconds 40
powershell.exe -NoProfile -File scripts\hosting\demo-hosting.ps1 -Port 3099 -Cap 2
powershell.exe -NoProfile -File scripts\hosting\install-autostart.ps1 -Status
```
## 11. 两个 Windows 环境坑（会咬到下一个动手的人）

1. **PS 5.1 不支持无 BOM 的中文脚本**：本机只有 Windows PowerShell 5.1（无 pwsh 7）。`.ps1` 若存成 UTF-8 无 BOM 且含中文，5.1 会在**不相干的行**报"字符串缺少终止符"（实测：一个 `…` 让第 156 行的 `done` 被判成非法 token）。所有脚本请存 UTF-8 **带 BOM**。
2. **`[int[]]` 参数绑逗号字符串会变成一个整数**：`-Caps 1,2,4` 绑到 `[int[]]$Caps` 得到的是 `124`（本轮第一次跑成了 `MAX_CONCURRENCY=124`）。参数用 `[string]` 收、自己按逗号拆。
## 12. 托管能力的验收结果（2026-11-02 22:31，独立复跑）

`scripts/verify.ps1` → **RESULT: PASS**，独立探针 **267/267** 全绿（比上一轮多 108 条，都是这轮新增的托管用例）：

| 组 | 条数 | 验的是什么 |
| --- | --- | --- |
| H1 | 25 | `POST /api/triggers` 真的喂给常驻 Engine（不是 CLI 自己干活），`router.received` 增长 |
| H2 | 18 | `MAX_CONCURRENCY=2` 时峰值 inflight ≤ 2 且期间 queued > 0，最终全部完成 |
| H3 | 17 | `PROJECTS` 隔离：每个任务只写自己的项目，越界路径被 denied，两个项目互不污染 |
| H4 | 17 | 硬杀常驻进程后再起，in-flight 任务被恢复；stop 后端口释放 |
| H5 | 31 | 自启：装/查/卸后**三路独立探针**（计划任务、Startup 文件、HKCU Run 值）全部不可见，零残留 |

加上原有 A–G、O 组，一键复跑覆盖 267 条断言。想自己复核：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1
```
