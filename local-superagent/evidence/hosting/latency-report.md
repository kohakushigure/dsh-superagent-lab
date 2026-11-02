# 延迟/并发实测报告（hosting latency measurement）

采样时间：2026-11-02 22:22 — 22:24（Asia/Shanghai）
执行人：deploy-runner
机器：Windows 11 26200，28 逻辑核
被测：`local-superagent`（Node 24，零依赖）+ `scripts/hosting/fake-llm.mjs` 合成模型延迟

> 目的：回答「这台机器能不能常驻托管」。`local-superagent` 的离线 mock 大脑是瞬时的，所以
> `MAX_CONCURRENCY` 在**真实模型延迟**下到底有没有起作用、吞吐是多少，此前没有任何实测。
> 本报告用本地 OpenAI 兼容桩注入固定延迟，走**真实适配器路径**（不是 mock）来测。
>
> 标注：`[已实测通过]` / `[已实测失败:原因]` / `[未实测]`

---

## 1. 方法

| 项 | 取值 |
| --- | --- |
| 桩 | `scripts/hosting/fake-llm.mjs`，`POST /v1/chat/completions`，零依赖，合法 `chat.completion` JSON |
| 模型延迟 | 固定 `--delay-ms 1500`（jitter 0） |
| 任务形状 | Router 1 次调用 + Worker 2 次调用（`--worker-steps 1`：先 `fs.write`，再 `final`）= 每任务 3 次模型调用，其中 2 次落在该任务的关键路径上 |
| 事件 | 8 条 `@superagent`，**8 个不同 thread**（不触发订阅直通，也不跨 thread 合并） |
| 批次窗口 | 默认 `BATCH_WINDOW_MS=800` |
| 适配器 | `OPENAI_BASE_URL=http://127.0.0.1:<port>/v1` + 假 `OPENAI_API_KEY` → `llm.mode=openai` |
| 采样 | 每 100 ms 读一次 `GET /api/state`，记录 `concurrency.inflight` / `queued` |
| 计时 | 从第一条 POST 到「8 个任务全部进入终态且 inflight=queued=0」 |

关键前提：桩返回的 JSON **完全照 `src/filter.mjs`（Router）与 `src/worker.mjs`（Worker）实际解析的字段造**，
不是猜的——Router 要 `{action,confidence,reason,title,intent}`，Worker 要 `{thought,tool,args}` 或 `{thought,final:{summary,deliverable}}`。
已单独验证：把三份真实形状的请求打给桩，返回的 `choices[0].message.content` 逐个 `JSON.parse` 通过，且 title 被正确提取。

复跑一条命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hosting\measure-latency.ps1 -Caps 1,2,4 -Events 8 -DelayMs 1500
```

---

## 2. 主表：cap × 峰值 inflight × 排队 × 总耗时

```text
run          cap  events  accepted  peakInflight  peakQueued  totalMs  done  failed  avgTaskMs  llmCalls  llmMode  adapterOk
cap1           1       8         8             1           4    25960     8       0       3245        24   openai   True
cap2           2       8         8             2           0    15400     8       0       1925        24   openai   True
cap4           4       8         8             2           0    15304     8       0       1913        24   openai   True
fail-worker    2       2         2             -           -     1935     0       2          0         4   openai   True
```

| cap | 峰值 inflight | 峰值排队 | 总耗时 | 每任务平均 | 8 任务等效吞吐 |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | **4** | 25.96 s | 3.25 s | 0.31 任务/s ≈ **1,110 任务/小时** |
| 2 | 2 | 0 | 15.40 s | 1.93 s | 0.52 任务/s ≈ **1,870 任务/小时** |
| 4 | **2** | 0 | 15.30 s | 1.91 s | 0.52 任务/s ≈ **1,880 任务/小时** |

### 桩侧独立证据（不是应用自己报的数）

桩自己统计的「同时在处理的请求数」峰值：

| cap | 桩观测峰值 | 构成 |
| --- | --- | --- |
| 1 | 2 | 1 个 worker 调用 + 1 个 router 调用重叠 |
| 2 | 3 | 2 个 worker + 1 个 router |
| 4 | 3 | 同上，**从未到 4** |

这直接印证了上表：**cap=4 时真实并发模型调用从未超过 3**（2 个 worker + 1 个 router），
所以 cap=4 相对 cap=2 没有任何收益——总耗时只差 96 ms（0.6%），是噪声。

---

## 3. 结论

### 3.1 这台机器在 1.5 s 模型延迟下的产能

- **cap=3（默认值）与 cap=2 等价**：瓶颈不在 worker 并发，见 3.2。按 8 任务实测外推，稳态约 **1,870 任务/小时**（每任务 2 次关键路径调用 × 1.5 s，2 路并发）。
- **cap=1 会腰斩**：1,110 任务/小时，且排队堆到 4 个未消化任务。
- 理论上限（2 worker ÷ 3 s/任务 = 0.667 任务/s）是 **2,400 任务/小时**；实测 1,870 是因为还要付 800 ms 批次窗口和 router 爬坡，属于预期损耗。

### 3.2 关键发现：真正卡住吞吐的是 Router 的串行 slow-path，不是 MAX_CONCURRENCY

`src/router.mjs` 的 `tick()` 对同一批 eligible 的每个 thread **串行** `await decideBatch()`：

```js
for (const rows of groups.values()) {
  out.push(await this.decideBatch(rows.slice(0, this.cfg.filter.batchMax)));
}
```

8 个不同 thread ⇒ 8 次串行 router 调用 ⇒ 光是**派发**就要 8 × 1.5 s = 12 s，等于每 1.5 s 才放一个任务进 worker 池。
而每个任务只占 worker 3 s，所以**稳态在飞任务数天然收敛到 ≈ 2**：

```text
派发间隔 1.5 s / 任务占用 3.0 s  ->  稳态 inflight = 3.0 / 1.5 = 2
```

因此：

- `MAX_CONCURRENCY >= 2` 在这个负载形状下是**空转配置**；实测 cap=4 与 cap=2 的总耗时差 0.6%。
- 想真正用满更高的 cap，必须让任务更长（更多 worker 步）或让 router 决策并行/合并——这是**代码层的事**，不是调参能解决的。
- cap=1 是唯一会真正**改变行为**的取值（排队 4、耗时 ×1.68）。

### 3.3 适配器路径（此前 docs 一直标"未实测"）

| 断言 | 结果 |
| --- | --- |
| `metrics.llm.mode === 'openai'` | `[已实测通过]` 三次运行全部 `openai` |
| `metrics.llm.calls > 0` | `[已实测通过]` 每轮 24 次（8 router + 16 worker） |
| `metrics.llm.mockCalls === 0` | `[已实测通过]` 三轮均为 0，**没有偷偷走 mock** |
| 桩收到的请求数 == 应用报的 llm.calls | `[已实测通过]` 24 == 24（三轮一致） |
| 请求确实打到 `/v1/chat/completions` 且带 Bearer | `[已实测通过]` 桩日志逐条记录 role/step/latency/status |

所以 **OpenAI 兼容适配器这条路径可以从未实测升级为已实测通过**（含 `response_format` 请求、`choices[0].message.content` 解析、`usage` 透传）。

### 3.4 失败路径

桩 `--fail-rate 1 --fail-role worker`（每次都 429/500）：

| 断言 | 结果 |
| --- | --- |
| 任务失败被记录 | `[已实测通过]` `failed=2`，`metrics.llm.errors=2` |
| 进程没崩 | `[已实测通过]` `process alive=True`，服务继续响应 `/api/state` |
| 重试语义符合源码 | `[已实测通过]` `LLM_MAX_RETRIES=1` ⇒ 每任务 2 次尝试（桩侧 4 次失败 = 2 任务 × 2 次） |
| 错误文本落到 `llm.lastError` | `[已实测通过]` 例如 `HTTP 500 {"error":{"message":"synthetic failure injected by fake-llm (500)"...}}` |
| watchdog 不把进程带崩 | `[已实测通过]`（本轮 `WATCHDOG_AUTO_RESTART=false`，见 4.1） |

失败是**按任务隔离**的：两个任务各自失败、互不影响，服务保持在飞。

---

## 4. 未验证项（别当成已完成）

1. `WATCHDOG_AUTO_RESTART=true` 下「失败 → 自动重启 worker → 二次失败」的完整链路**没测**：本轮失败试验特意关掉了自动重启，只证明「不崩 + 失败被记录」。
2. **多步任务没测**：一任务 2 次关键路径调用是刻意设定的最短形状。真实 `WORKER_MAX_STEPS` 默认 6，任务更长，cap 的实际作用点会后移——那时的 cap 才可能真正卡住。
3. **长稳没测**：单轮 15–26 s、共 8 任务。没有跑过小时级连续负载，也没有测内存/句柄增长。
4. **真实模型没测**：延迟是合成的固定 1500 ms，没有首 token 抖动、没有长输出、没有限流退避的真实分布。真实 API 的 429 退避会让数字更差。
5. **订阅直通下的并发**没测：8 个事件用了 8 个不同 thread 以避免直通，所以本报告描述的是**冷启动派发**路径。
6. 每任务 token 数是桩自己按字符数估的（`promptTokens/completionTokens`），**不是真实计费口径**。

---

## 5. 原始文件

同目录（`local-superagent/evidence/hosting/`）：

| 文件 | 内容 |
| --- | --- |
| `latency-summary.csv` / `.json` | 上表的机器可读版本（最新一轮） |
| `latency-summary-20261102-222225.*` | 带时间戳的同内容快照 |
| `20261102-222225-cap{1,2,4}-samples.jsonl` | 每 100 ms 一次的 inflight/queued/done/failed/llmCalls 采样 |
| `*-stub.jsonl` | 桩侧逐请求日志（role / step / 状态码 / 延迟 / 当时并发） |
| `*-stub-summary.json` | 桩侧汇总（含它自己观测的峰值并发） |
| `*-agent.out.log` / `*.err.log` | 应用 stdout / stderr（stderr 全为空） |
| `state-cap*/` | 每轮独立 SQLite 状态库（`SUPERAGENT_STATE_DIR`） |

过程说明：首次运行把 `-Caps 1,2,4` 当成了单个整数 `124`（PowerShell 5.1 的 `[int[]]` 参数绑定坑），
已修成字符串拆分；那一轮的产物（`*cap124*`、以及参数试跑 `*222139*` / `*222151*`）已删除，未计入本报告。
跑完已确认：18900–18930 无监听端口，无残留 `node` 进程。
