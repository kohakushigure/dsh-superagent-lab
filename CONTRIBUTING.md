# Contributing

欢迎提 issue / PR。这个仓库优先保证两件事：**结论可复现**、**证据不打折**。

## 环境

| 需要 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ^22.19 或 ≥ 24（开发用 24） | `local-superagent` 只用内置模块，无 `npm install` 步骤 |
| Windows / Linux / macOS | 任一 | CI 覆盖 ubuntu-latest 与 windows-latest |
| Python / tmux / DSH | 只在跑**官方原型**（A 路线）时需要 | 见 `docs/03-local-deployment-runbook.md` |

## 跑测试

`local-superagent/` 零依赖，clone 下来直接跑：

```powershell
cd local-superagent
node --test              # 单元 + 集成用例（当前 29 例）
node bin/demo.mjs        # 端到端 demo，11 段场景 / 30 条断言，mock 大脑，自清 state
node bin/superagent.mjs status
```

全量验收（干净副本 + 测试 + demo + 独立探针，输出落 `verify-out/`）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1
# 期望：RESULT: PASS，EXIT=0
```

接真实模型（任意 OpenAI 兼容网关）时，先自己确认不把 Key 写进文件：

```powershell
$env:OPENAI_BASE_URL="https://api.example.com/v1"; $env:OPENAI_API_KEY="sk-..."
$env:MODEL_ROUTER="deepseek-chat"; $env:MODEL_WORKER="deepseek-reasoner"
node bin/superagent.mjs start
```

## CI 会跑什么

```text
test  (ubuntu-latest / windows-latest)  node --test  →  node bin/demo.mjs
smoke (ubuntu-latest / windows-latest)  node bin/superagent.mjs start --port 18082
                                        → POST /api/triggers
                                        → 断言 tasks >= 1 且至少一个 done
                                        → POST /api/stop
```

CI 不联网、不需要任何 secret：没有 `OPENAI_API_KEY` 时实现自动走 mock 大脑。
本地能复现同样的两步，就等于复现了 CI。

## 提 PR

1. **一个 PR 一件事**。修 bug 和改文案不要混在一个 PR 里。
2. **带上证据**。涉及「跑没跑通」的改动，请在 PR 描述里贴命令 + 关键输出（或 `verify-out/verify-<ts>.log` 的片段）。
3. **只用三种状态词**：`[已实测通过]` / `[已实测失败:原因]` / `[未实测]`。不要写「应该可以」。
4. **区分设计与实现**。写「原型实现了 X」必须能指到文件或行；指不到就写「文章设计」。
5. **不编链接、不编数字**。易漂移数据（star 数等）要带采样时间与采样方。
6. **改 `local-superagent/src/` 必须带测试**。核心逻辑（Router/Worker/过滤/上下文/watchdog）不接受无测试的行为变更。
7. 提交信息用祈使句，首行 ≤ 72 字符。

## 不要提交这些东西

仓库的 `.gitignore` 已经挡住大部分，但提交前请自己再确认：

| 别提交 | 原因 |
| --- | --- |
| `local-superagent/state/`、`state-*/` | 运行时 SQLite（含任务、消息、触发器） |
| `local-superagent/.work/` | 每个工单的执行目录与交付物 |
| `verify-out/` | 本地验收产物（大，且带时间戳，不可复现命名） |
| `deploy/dsh-home/` | 内含 dsh 自建的 `.credentials.yaml`，**是凭据** |
| `deploy/state/`、`deploy/upstream/` | 运行时库 / 第三方克隆 |
| `*.sqlite*`、`*.log`（局部例外见 `.gitignore`） | 状态与日志 |
| `OPENAI_API_KEY`、GitHub token、任何 `.env` | 密钥 |

如果你发现某个产物**确实应该**进仓库（例如用于复核的小体积证据），请在 PR 里说明体积与用途，并用固定文件名而不是时间戳。

## 许可

提交即表示同意以本仓库的 MIT 许可发布（见 `LICENSE`）。上游 `dsh-superagent` 的归属说明见 `NOTICE.md`。
