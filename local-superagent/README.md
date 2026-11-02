# local-superagent

自建的最小 Super-agent：**Router 只分派 / Worker 干活 / 两级过滤 / 订阅直通 / 上下文即缓存 / SQLite 恢复 / Watchdog / CLI + 面板**。

纯 Node 24 内置模块（`node:sqlite`、`node:http`、`node:test`、`node:child_process`），**零 npm 依赖**，不依赖 DeepSeek Harness。

> 这是官方原型的**替代实现（B 方案）**，不是原型的复刻。设计说明、与官方机制的逐条对照、已知差距见 `../docs/04-local-implementation.md`。

## 快速开始

```powershell
cd local-superagent
node --test                       # 19 个用例，约 0.5s
node bin/demo.mjs                 # 端到端 demo，30 条断言，产出 evidence/
node bin/superagent.mjs start     # 常驻 + 面板 http://127.0.0.1:3182
```

另开一个终端：

```powershell
node bin/superagent.mjs submit '@superagent 给 README 加一节 FAQ' --thread demo/t1 --author alice
node bin/superagent.mjs status
node bin/superagent.mjs logs -n 30
node bin/superagent.mjs watch
node bin/superagent.mjs stop
```

## 接真实模型

不设 Key 时自动走 mock 大脑（离线、确定性，验收用）。接真实模型只要:

```powershell
$env:OPENAI_BASE_URL='https://api.deepseek.com/v1'
$env:OPENAI_API_KEY='sk-...'
$env:MODEL_ROUTER='deepseek-chat'
$env:MODEL_WORKER='deepseek-chat'
node bin/superagent.mjs start
```

任何 OpenAI 兼容端点都行。真实端点路径在本机 **[未实测]**（无可用 Key）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/` | router / worker / filter / context / tools / watchdog / db / llm / mock / server / engine |
| `bin/` | `superagent.mjs`（CLI）、`demo.mjs`（端到端演示） |
| `test/` | 5 个 `node:test` 文件，19 例 |
| `testkit/` | 测试夹具（不参与 `node --test` 发现） |
| `evidence/` | 真实运行日志与断言结果 |
| `state/` | SQLite + spill（运行时生成） |
| `.work/` | 每工单隔离目录（运行时生成） |

## 常用调参（环境变量）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PANEL_PORT` | 3082 | 面板端口（demo 用 3182） |
| `BATCH_WINDOW_MS` | 800 | 批量窗口 |
| `BATCH_MAX` | 8 | 批量上限 |
| `FAST_SOURCES` / `FAST_GROUPS` / `FAST_ALLOWLIST` / `FAST_REGEX` | 见 `src/config.mjs` | Fast Path 四道确定性过滤 |
| `FAST_DEDUPE_TTL_MS` / `FAST_RATE_PER_MIN` | 300000 / 240 | 去重窗口 / 令牌桶 |
| `CONTEXT_SPILL_THRESHOLD` | 1200 | Spill 阈值（字符） |
| `WORKER_MAX_STEPS` / `WORKER_MAX_ATTEMPTS` | 6 / 2 | 单次执行步数 / 重启次数 |
| `WATCHDOG_STALL_MS` / `WATCHDOG_LOOP_THRESHOLD` / `WATCHDOG_ERROR_THRESHOLD` | 15000 / 3 / 2 | 三类判定阈值 |
| `PASSTHROUGH_ENABLED` | true | 关掉即消融实验（Router 决策数上升） |
