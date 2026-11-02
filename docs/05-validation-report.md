# 05 实现验收与端到端验证（T5）

> 验收人：qa-verifier（独立于实现作者 impl-engineer）
> 执行时间：2026-11-02 19:01–19:02 +08:00（最终一轮），此前 18:58 起有多轮探针调试
> 被测对象：`local-superagent/`（作者自建的最小 Super-agent，Node 24 内置模块，零第三方依赖）
> 复跑入口：`scripts/verify.ps1` → 本轮 **RESULT: PASS，退出码 0**
> 写入范围：`scripts/`、`docs/05-`、`verify-out/`。**未修改** `local-superagent/` 内任何文件，原目录仅作只读对照。

> **[路径说明]** 本文所有 `verify-out/…`、`local-superagent/evidence/…`、`verify-tmp/…` 引用都是**本地产物，未随仓库分发**（`verify-out/` 在 `.gitignore` 中，证据日志与状态库都不进仓库）。下面每一条都可原地复现，不是死链：
>
> | 想复现 | 命令 |
> | --- | --- |
> | 全量验收（测试 + demo + 全部探针 → `RESULT: PASS`） | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1` |
> | 只跑单元/集成测试 | `cd local-superagent; node --test` |
> | 只跑 30 条断言的端到端 demo | `cd local-superagent; node bin/demo.mjs` |
> | 只跑某一组探针 | `node scripts\probes\run-all.mjs verify-out\clean-<ts> verify-out --only=H1,H2` |
>
> 跑完会在 `verify-out/` 下重新生成 `verify-<ts>.log` 与 `probes-<iso>.json`；文件名带时间戳，所以本文引用的是**当时那一轮**的名字，重跑后名字会变。CI 侧的等价验证见 `.github/workflows/ci.yml`。

---

## 0. 结论摘要

| 阶段 | 结果 | 判定 |
|---|---|---|
| 干净副本构建 | robocopy 排除 `state/`、`.work/`、`evidence/`、`state-test/` | 通过 |
| `node --test`（作者测试） | tests 19 / pass 19 / fail 0 | 通过 |
| `node bin/demo.mjs`（作者演示） | checks passed 30 / failed 0 | 通过 |
| 独立探针 A–F | **101 / 101 checks，0 failed** | 通过 |
| 一键复跑 | `TEST_EXIT=0`、`DEMO_EXIT=0`、`PROBES_EXIT=0`、`RESULT: PASS` | 通过 |

**通过 101 项 / 失败 0 项**（独立探针），另有基线 19 测试 + 30 演示断言全部通过。
发现 **2 个探针自身缺陷（已修）**、**0 个被测功能失败**、**3 个交付前建议修的实质问题**（见 §7）。

---

## 1. 方法与红线

1. **干净副本**：`verify-out/clean-<ts>/`，用 `robocopy /E /XD state .work evidence state-test` 复制，杜绝作者的历史 db / 交付物 / 证据污染结论。所有阶段只在该副本内执行。
2. **不 import 原目录**：探针通过 `pathToFileURL(<clean>/src/*.mjs)` 动态导入被测代码，运行路径与被测代码都锁定在副本里。
3. **不复用作者断言**：A–F 六组断言由我编写；作者的 `demo.mjs`/`evidence/` 只作为“基线”和“对照物”，不作为判定依据。
4. **故障要真**：
   - (B) 用**真进程 + SIGKILL**（`child.kill('SIGKILL')`，Windows 下即 TerminateProcess），不模拟“优雅退出”。
   - (C) 在 **LLM 边界**注入永久挂起（worker 侧 `chat()` 返回永不 resolve 的 Promise），router 侧仍走真 mock 决策，从而让 task 真的卡在 `running`。
   - (F) 注入一个**一被调用就抛异常**的 `fetchImpl`，用“网络一旦被触碰就失败”来证明 mock 路径零联网。
5. **不加依赖、不改被测代码**：探针只读被测 API（Engine/Router/Worker/Watchdog/ContextStore/Repo）与 HTTP 面板。

---

## 2. 运行环境

| 项 | 值 |
|---|---|
| OS | Windows 11 26200，28 逻辑核 |
| Node | v24.19.0 |
| Shell | **Windows PowerShell 5.1**（本机 PATH 上**没有** `pwsh.exe`；`verify.ps1` 按 5.1 兼容语法编写，并已用 `powershell.exe -NoProfile -File` 实测） |
| 模型 | 无 `OPENAI_API_KEY`（全程 mock） |
| 面板端口 | 探针用 30000+pid%2000 随机端口，避开作者 demo 的 3182 |

---

## 3. 用例表

### 3.1 基线（作者自带，跑在干净副本内）

| ID | 用例 | 预期 | 实测 | 判定 | 证据 |
|---|---|---|---|---|---|
| BASE-1 | `node --test` | 全绿 | `tests 19 / pass 19 / fail 0 / duration 468.5ms` | 通过 | `verify-out/verify-20261102-190119.log` |
| BASE-2 | `node bin/demo.mjs` | 全绿 | `passed=30 failed=0` | 通过 | 同上 + `clean-.../evidence/demo-run.json` |

### 3.2 独立探针 A–F

| ID | 断言数 | 关键实测值 | 判定 | 证据 |
|---|---|---|---|---|
| A 订阅直通绕过 Router | 15 | 直通开：`decisions 1→1`、`bypass 1`、`trigger2=passthrough`、`decisionsTouching2=0`；直通关：`decisions 1→2`、`bypass 0`、`trigger2=dispatched` | 通过 | `verify-out/probes-2026-11-02T11-01-26-188Z.json` |
| B 崩溃恢复（真 SIGKILL） | 12 | 杀前 `status=running attempt=1`；杀后 DB 仍 `running`；新进程 `recovered=[task]`；`attempt 1→2`；`status=done`；`session_id 不变`；`messages 0→3`；`runs=2` | 通过 | 同上 |
| C Watchdog 抓 stalled → 重启 → 升级 | 16 | 时间线 `stall(idleMs=257,threshold=250) → restart(attempt=2) → stall(idleMs=280) → gave_up(attempts=2)`；`task.status=failed`、`error=watchdog gave up: stall`、`decision(policy=watchdog,action=need_human)` 且进入 pending=1 | 通过 | 同上 |
| D spill 后召回 | 20 | 3034 字符 > 阈值 1200 → 落盘；磁盘 blob 与原文**逐字节相同**；`readSpill()` 返回原文；摘要 450 字符含续读 hop；inline 1212 字符（有界）；召回链 `message→thread→session→task` | 通过 | 同上 |
| E HTTP 面板 | 26 | `/api/health` `{ok:true,llm:"mock"}`；`/api/state` 含 tasks/subs/events/metrics，`decisionsInDb=2`，pending=1；`/` 为 HTML 且含待决策区与绕过计数；resolve → `approved/resolved=1` 且 pending 归零；retry → 200 + `manual_retry` 事件；未知路由/未知任务 → 404 | 通过 | 同上 |
| F 无 Key mock 路径 | 12 | `mode=mock`、`calls=4 / mockCalls=4`、`errors=0`、**fetch 调用 0 次**；交付物含 `brain: mock`；负向对照：给了 key 后 `mode=openai`、fetch 被调用 1 次并抛错，不回落到 mock | 通过 | 同上 |

逐条断言的完整明细（每条 name/ok/detail）已写入 `probes-2026-11-02T11-01-26-188Z.json` 的 `cases[].detail`。

---

## 4. 作者 evidence 与独立复跑的一致性

对照对象：`local-superagent/evidence/demo-run.json`（作者，18:50 之前生成） vs `verify-out/clean-20261102-190119/evidence/demo-run.json`（我在干净副本跑出的）。

### 4.1 一致（可比且相同）

| 指标 | 作者 | 我的干净副本 | 结论 |
|---|---|---|---|
| `passed` / `failed` | 30 / 0 | 30 / 0 | 一致 |
| `ablation.on.decisions` | 15 | 15 | 一致 |
| `ablation.on.bypass` | 5 | 5 | 一致 |
| `ablation.off.decisions` | 20 | 20 | 一致 |
| `ablation.off.bypass` | 0 | 0 | 一致 |
| `ablation.deltaPercent` | 33.3 | 33.3 | 一致 |
| `ablation.on/off.tasks` | `done:20` / `done:20` | `done:20` / `done:20` | 一致 |
| `ablation.on/off.llmCalls` | 75 / 80 | 75 / 80 | 一致 |

### 4.2 不一致（已定位原因，非功能问题）

| 指标 | 作者 | 我的干净副本 | 原因 |
|---|---|---|---|
| `metrics.decisionsInDb` | 8 | 4 | demo 主阶段把 stateDir 固定为 `<BASE_DIR>/state`（`bin/demo.mjs:42`）且**不清理**，作者在已有 state 上重复运行，计数累计；我的副本 `state/` 被 robocopy 排除，从零开始 |
| `metrics.decisions` | 8 | 4 | 同上（同一数据源的两种投影） |

`ablation` 阶段反而是干净的（`bin/demo.mjs:282` 与 `:307` 对 `state-ablation-on/off` 做了 `rmSync`），所以那组数字可复现。**结论：行为一致、ablation 一致，仅“累计型计数器”不可从干净仓库复现**（见 §7 M3）。

### 4.3 无法独立复现

| 项 | 说明 |
|---|---|
| 面板 URL `http://127.0.0.1:3182` | 只代表作者当时的端口；我用 30684 / 31776 复现了同一面板，**端口本身不是可复现事实**，只有“面板可达且内容正确”是可复现的 |
| `evidence/run.jsonl`、`spill/<session>/*.md` 的具体 id | id 由随机/时间生成，只能验证“结构相同”，不能验证“值相同” |

**声明**：作者的 `demo-run.json` 中 `passed=30` 我**没有采信为证据**；我是独立跑 `demo.mjs` 得到同样的 30/0，并在副本里重新生成了该文件，两者再作比对。


---

## 5. 三处最关键的独立证据（可直接引用）

**证据 1 — 订阅直通是“绕过 Router”，不是“跑得快”（用例 A）**
同一 thread 的第二条事件：`trigger.status = 'passthrough'`；`decisions` 表**没有新增行**（1→1，且无任何 decision 的 `trigger_ids` 含该 trigger）；`bypass` 计数 1（进程内）/1（DB `SUM(subscriptions.hits)`）；新建 task 的 `origin='passthrough'` 且 `session_id` 等于订阅里那个 worker session；`passthrough` 事件自带 `bypassed:["batch","slow_path"]`。
对照组：同一负载关掉 `PASSTHROUGH_ENABLED` 后，同一事件 `decisions 1→2`、`bypass 0`、`trigger.status='dispatched'`。
→ 这排除了“直通只是优化了延迟”的可能，真的少了一次 Router 决策。

**证据 2 — 崩溃恢复保留 worker 会话上下文（用例 B）**
杀进程前：`status=running, attempt=1, session=sess_X, messages=0`；SIGKILL 后直接读 DB：仍 `running`（说明没有优雅退出兜底）。
新进程启动：`recovered=["<taskId>"]`，写 `recovered` 事件 `{from:"running", attempt:2}`；最终 `status=done`、`attempt=2`、**`session_id` 仍为 sess_X**、会话消息 0→3、`runs=2`、`task_start` 事件 2 次、deliverable 落盘。
→ 恢复是“同一会话续跑”，不是“另起一个会话重做”。

**证据 3 — Watchdog 是独立回路且会升级给人（用例 C）**
真实时间线（事件表原文）：`watchdog_stall(idleMs=257, threshold=250)` → `watchdog_restart(attempt=2)` → `watchdog_stall(idleMs=280)` → `watchdog_gave_up(attempts=2)`；`task.status=failed`、`error="watchdog gave up: stall"`；同时写入一条 `decisions(policy='watchdog', action='need_human')`，`pendingHumanDecisions()` 变为 1（面板上可见）。
额外：3 次相同 `tool_call`（`fs.read:same`）被判为 `kind='loop'`（`repeats=3`），与 stall 区分。
→ watchd 不依赖 router 主循环，也不会无限重启。

---

## 6. 失败项与复现步骤

### 6.1 探针自身缺陷（已修，不计为被测缺陷）

| ID | 现象 | 根因 | 修法 | 如何复现 |
|---|---|---|---|---|
| QA-1 | 一键复跑时 case C 报 `0/0 passed, failed=1`，无 `PROBE_RESULT` 行 | `p3-watchdog.mjs` 里 `process.exit()` 写在 `T.finish()` **之前**，结果行来不及输出 | 调换顺序：先 `T.finish()` 再 `process.exit(process.exitCode)` | 用旧版 p3 跑 `run-all.mjs`，汇总行会出现 `case C 0/0 failed=1` |
| QA-2 | case D 首轮 `19/20`，失败项是“summary states the original size” | 我把期望长度硬编码成 `已落盘 3000 chars`，实际 payload 是 3034 字符（代码输出正确：`〔已落盘 3034 chars〕`） | 断言改用 `BIG.length` 动态比对 | 旧版 p4 首轮输出即复现；修正后 20/20 |

这两条都是**我的探针写错**，不是被测实现的问题。修完重跑通过，故保留记录以示未掩盖。

### 6.2 被测实现的功能失败

**无。** A–F 六组共 101 条断言全绿，基线 19 测试 + 30 演示断言全绿。

---

## 7. 交付前必须修的问题（3 条，均非阻断验收）

### M1 订阅永不关闭 → 直通会一直打到同一个（可能已空闲的）worker 会话
**证据**：`src/db.mjs:210` 定义了 `closeSubscriptionsForTask()`，全仓库**没有任何调用点**（`grep -rn closeSubscriptionsForTask` 只命中定义处）。`findSubscription` 只认 `status='active'`，而没有任何代码把状态改成 `closed`。
**后果**：某 thread 一旦被派发过，后续所有事件都走 passthrough（用例 A 已验证该行为）；订阅表只增不减；面板能看不能解绑（服务端未暴露 unsubscribe 路由）。
**建议**：task 终止/thread 关闭时调用 `closeSubscriptionsForTask`；或在 `/api/` 增加 `unsubscribe`；至少在 `docs/04` 里写明“订阅按 thread 生命周期常驻”。

### M2 Watchdog 重启不会取消上一次执行 → 双执行风险
**证据**：`src/worker.mjs` 的 `run()` 没有任何 abort/cancel 检查（`grep AbortController` 只命中 `src/llm.mjs:55-56` 的请求超时）。用例 C 里 `workerHangs=2`：第一次 worker 的 Promise 仍然挂着，watchdog 又调度了第二次。
**后果**：若模型调用“只是慢”而不是“死”，重启后旧执行仍可能继续写同一 `workdir/deliverable` 并把 task 状态改回 done，与 M1 叠加会放大影响。
**建议**：给 `Worker.run` 传 `AbortSignal`，watchdog 重启前 abort 旧执行；或把 `workdir` 按 `attempt` 分目录，交付物以最后一次为准。

### M3 demo 主阶段计数器不可从干净仓库复现
**证据**：`bin/demo.mjs:42` 固定 `stateDir: <BASE_DIR>/state` 且不清理；作者 `evidence/demo-run.json` 的 `metrics.decisionsInDb=8`，我的干净副本为 4（§4.2）。
**后果**：任何人第一次跑 demo 都会得到与仓库内 evidence 不同的计数，容易误判为“行为变了”。
**建议**：主阶段也 `rmSync` 状态目录（与 ablation 段一致，见 `:282`/`:307`），或把面板/报告里的计数改成“本次运行增量”，并在 `evidence/README.md` 注明累计语义。

---

## 8. 未覆盖项（明确未验证，不得当作已验证）

| 未覆盖 | 原因 / 影响 |
|---|---|
| 真实模型调用 | 无 `OPENAI_API_KEY`，全程 mock。只做了负向验证（给 key 后确实走网络并抛错），**未验证真实响应的解析质量与失败重试语义** |
| 真实 GitHub / 飞书渠道 | 本实现只有 `cli` 一个 source，没有官方原型里的 github/feishu Source 适配器。渠道侧行为完全未验证 |
| 跨机部署 / 存算分离 / BYOM | 未实现，故未验证（与原型的差距见 docs/06 B 节） |
| 面板的浏览器渲染与 JS 交互 | 只验证 HTTP 200 + HTML 关键片段 + API；未在真实浏览器点按钮，`resolve()` 的 JS 前端路径靠 API 直调覆盖 |
| 并发上限 / 多 worker 并行压力 | 实现无 `maxWorkers` 配置项；未做并发任务压力与竞态测试 |
| Windows 下的 shell 工具白名单 | 探针把 `worker.shellProbe` 设为 `false` 以避开对本机 git 的依赖；白名单拒绝只在 demo 的 mock 第 4 步（`Remove-Item -Recurse -Force C:/Windows`）间接覆盖，我未独立断言 |
| 长时间运行（soak） | 未做小时级运行；订阅表/事件表/消息表的无界增长未测（与 M1 相关） |
| 断电 / 文件系统级损坏 | 只验证了进程级 SIGKILL 下的 WAL 一致性 |
| 计划任务 / 守护进程化 | 未验证开机自启、进程守护 |

---

## 9. 如何复跑

```powershell
# 一键复跑（本机无 pwsh.exe，用 Windows PowerShell 5.1；装了 PS7 也可以直接 pwsh -File）
powershell.exe -NoProfile -File scripts\verify.ps1

# 输出：
#   verify-out/verify-<ts>.log            完整transcript（含 test/demo/探针全部输出）
#   verify-out/probes-<iso>.json          每条断言的 name/ok/detail
#   verify-out/clean-<ts>/                干净副本（含它自己跑出来的 evidence/、verify-tmp/）

# 单独跑某一组（需先有一个干净副本目录）
node scripts\probes\p1-passthrough.mjs verify-out\clean-<ts>
node scripts\probes\p2-recovery.mjs    verify-out\clean-<ts>
node scripts\probes\p3-watchdog.mjs    verify-out\clean-<ts>
node scripts\probes\p4-spill.mjs       verify-out\clean-<ts>
node scripts\probes\p5-panel.mjs       verify-out\clean-<ts>
node scripts\probes\p6-mock.mjs        verify-out\clean-<ts>
node scripts\probes\run-all.mjs        verify-out\clean-<ts> verify-out
```

**退出码语义**：`0` = 全部通过；`1` = 有阶段失败（test / demo / 任一探针）；`2` = 干净副本构建失败。

---

## 10. 附录

### 10.1 探针文件职责

| 文件 | 职责 |
|---|---|
| `scripts/probes/lib.mjs` | 从干净副本动态 import 被测模块、临时状态目录、断言器、`PROBE_RESULT` 输出协议 |
| `scripts/probes/p1-passthrough.mjs` | 用例 A：直通开/关的决策数与绕过计数对照 |
| `scripts/probes/p2-recovery.mjs` | 用例 B：父进程 SIGKILL + 第二个进程恢复，读 DB 断言 |
| `scripts/probes/child-engine.mjs` | B 的子进程 harness（`hold` 挂起 worker / `resume` 恢复并输出 JSON） |
| `scripts/probes/p3-watchdog.mjs` | 用例 C：LLM 边界故障注入 → stall/restart/升级；附 loop 判定 |
| `scripts/probes/p4-spill.mjs` | 用例 D：落盘字节一致性、摘要/续读、召回链、重开进程仍可读 |
| `scripts/probes/p5-panel.mjs` | 用例 E：health/state/HTML/resolve/retry/404 |
| `scripts/probes/p6-mock.mjs` | 用例 F：无 key 的 mock 路径 + 零网络 + openai 分支负向对照 |
| `scripts/probes/run-all.mjs` | 汇总六组，写 `probes-<iso>.json`，非零退出码即失败 |
| `scripts/verify.ps1` | 干净副本 → test → demo → 探针 → VERDICT，全部 tee 到 `verify-out/verify-<ts>.log` |

### 10.2 本轮产物

| 产物 | 说明 |
|---|---|
| `verify-out/verify-20261102-190119.log` | 最终一轮完整 transcript（35,208 字节，RESULT: PASS） |
| `verify-out/probes-2026-11-02T11-01-26-188Z.json` | 最终一轮 101 条断言明细（21,720 字节） |
| `verify-out/verify-20261102-190106.log`、`probes-2026-11-02T11-01-12-543Z.json` | 修复探针前的失败轮（case C 0/0），保留作为 QA-1 的复现证据 |
| `verify-out/test-20261102-185820.log`、`demo-20261102-185820.log` | 首次手工基线（干净副本 clean-20261102-185820） |
| `verify-out/clean-20261102-190119/` | 最终干净副本，含它自己生成的 `evidence/demo-run.json` 与 `verify-tmp/<case>/` 状态 |

> 原目录 `local-superagent/` 未被写入：我只读取了它的 `src/`、`bin/`、`test/`、`package.json`、`evidence/demo-run.json` 作为对照。

---

## 11. 签名

- 验收人：qa-verifier（T5）
- 判定：**通过**（独立探针 101/101；基线 19/19 + 30/30）
- 保留意见：§7 的 M1/M2/M3 为交付前建议修复项；§8 为明确未覆盖范围


---

## 12. 复验记录（M1/M2/M3 修补后 · 2026-11-02 19:07–19:12）

> 本节**追加**，不覆盖 §0–§11 的原始验收结论。原始一轮为“修补前”，本节为“修补后”。

### 12.1 范围与方法

- 只做回归：`node --test` 与 `bin/demo.mjs` 全量；探针 **C 全量重写、G 全量新增**，A/B/D/E/F 抽跑，最后用 `scripts/verify.ps1` 一键全量复跑作为判据。
- 两套干净副本：`verify-out/regress-20261102-190703/`（定向回归用）与 `verify-out/clean-20261102-190742/`（verify.ps1 自建）。
- 仍然：`robocopy /E /XD state .work evidence state-test`、动态 import 副本代码、原目录只读。

### 12.2 实际改动（对照 `verify-out/baseline-hashes-T5.txt`）

**9 个文件变更，15 个未变，0 新增，0 删除**（lead 说的“10 个文件”含 `docs/04`，它在 `local-superagent/` 之外，故不在此表）：

| 文件 | 变更后大小 | 内容 |
|---|---|---|
| `src/worker.mjs` | 11,278 B | active Map + abort/isActive/stale/finishStale + 4 个 stale 检查点 |
| `src/watchdog.mjs` | 5,175 B | restart 前 `worker.abort()`，finding 增 `aborted` |
| `src/server.mjs` | 8,620 B | `POST /api/unsubscribe` + 面板按钮 |
| `src/db.mjs` | 16,311 B | `closeSubscription` / `closeSubscriptionsByThread` |
| `src/llm.mjs` | 4,585 B | `chat()` 接受 signal |
| `src/tools.mjs` | 6,180 B | `call(name,args,{signal})` 透传 execFile |
| `bin/superagent.mjs` | 9,372 B | CLI `unsubscribe` |
| `bin/demo.mjs` | 22,272 B | 启动清理 `state/`、`.work/` |
| `test/watchdog.test.mjs` | 6,195 B | 新增 1 例（19→20） |

未变：`src/{config,context,engine,filter,log,mock,router}.mjs`、`package.json`、`README.md`、`.gitignore`、`test/{context,filter,passthrough,recovery}.test.mjs`、`testkit/helpers.mjs`。
→ 改动面与 lead 的清单**逐条对上**，无夹带重构。

### 12.3 用例结果（修补后）

| ID | 断言数 | 结果 | 关键实测 |
|---|---|---|---|
| BASE-1 `node --test` | 20 tests | **20 pass / 0 fail** | 与 lead 声明的 19→20 一致 |
| BASE-2 `bin/demo.mjs` | 30 checks | **30 pass / 0 fail** | `DEMO_REPORT passed=30 failed=0` |
| A 直通（抽跑） | 15 | 15/15 | `decisions 1→1 / bypass 1`（ON）vs `1→2 / bypass 0`（OFF），语义未被改动破坏 |
| B 崩溃恢复（抽跑） | 12 | 12/12 | SIGKILL → `running` → recovered → `attempt 2 / done`，同 session 复用 |
| **C watchdog（全量）** | 30 | **30/30** | 见 12.5 |
| D spill/召回（抽跑） | 20 | 20/20 | 3034 字节逐字节一致、链 `message→thread→session→task` |
| E 面板（抽跑） | 26 | 26/26 | health/state/HTML/resolve/retry/404 |
| F 无 Key（抽跑） | 12 | 12/12 | `calls=4/mockCalls=4`、fetch 0 次 |
| **G 解绑（新增）** | 24 | **24/24** | 见 12.4 |
| O 记账观察（新增，非门禁） | 9 | 9/9 | 见 12.7 的 N1/N2 |
| **合计** | **148** | **148/148，0 failed** | `verify.ps1` → `RESULT: PASS`，**EXIT=0** |

### 12.4 M1 正面证明（用例 G）：解绑后同 thread 必须重新过 Router

时间线（全部为探针实测，非作者断言）：

1. 事件 1 → `batched → dispatch`，thread 获得 active 订阅（session A）。
2. 事件 2（同 thread）→ `passthrough`，`bypass=1`，`decisions` 停在 1。
3. `POST /api/unsubscribe {thread}` → **200**，`ok:true, closed>=1`；`findSubscription` 变 0；行保留但 `status='closed'`（审计可查）；写入 `unsubscribe` 事件。
4. 事件 3（同 thread）→ **`batched`（不再是 passthrough）** → `tick` → `dispatch`；`decisions 1→2`；`bypass` 仍为 **1**（未增长）；trigger 状态 `dispatched`；新 task `origin='router'`（不是 passthrough）。
5. 同 thread 重建订阅：`session != session A`、`hits=0`。

三种入口都验证：HTTP `{thread}`、HTTP `{id}`、CLI `node bin/superagent.mjs unsubscribe <thread>`（exit 0，输出 `closed 1 subscription(s) matching thread_cli_unsub`）；另验 400 路径（既无 id 也无 thread）。
→ 结论：**“解绑”语义成立**，且与“订阅默认常驻是有意设计”不冲突（未解绑时仍直通，由 A 用例与 G 的 baseline 断言同时证明）。

**语义小瑕疵（仅报告，不影响行为）**：`closeSubscriptionsByThread` 返回该 thread 的**全部**行，所以响应的 `closed` 计数包含本就已 closed 的行；CLI 对 `closeSubscription(id)` 恒回 1（即使那一行早已 closed）。计数≠“状态翻转数”。

### 12.5 M2 复验：abort 生效，但 workdir 未按 attempt 分目录

**先更正一处前提**：lead 给的条件“若 M2 改的是 workdir 分 attempt，断言新旧 attempt 目录不互相覆盖”——实际 M2 走的是**取消旧执行**路线，`worker.mjs:84` 仍是 `path.join(workRoot, taskId)`，**没有**按 attempt 分目录。故该条不适用；改用更强的替代断言：**旧执行不得写状态、不得写交付物、不得回报**。

C1（一次重启，手动释放旧 run 以命中检查点）：

| 断言 | 实测 |
|---|---|
| watchdog 在重启前调用 `worker.abort` | `worker_abort` 1 条，`reason='watchdog:stall'` |
| finding 记录 `aborted` | `findings[0].aborted === true` |
| attempt 递增 | 1 → 2 |
| 旧 run 返回值 | `{status:'superseded'}` |
| superseded 事件 | `{attempt:1, where:'after-llm', aborted:true}` |
| `counters.superseded` | 1 |
| 旧 run 释放后 task.summary | 仍为 `null`（未被旧 run 写） |
| 最终提交者 | `attempt=2`，`summary='NEW-ATTEMPT-2'` |
| 回报次数 | `worker_report` 1 条、`task_done` 1 条（无双重上报） |
| 收敛耗时 | 371 ms（远小于 60 s 模型超时） |

C2（升级链，worker 永久挂起）：`stall(idleMs=261/250) → worker_abort → restart(attempt 2) → stall(idleMs=279) → gave_up(attempts 2)`；task `failed`（`watchdog gave up: stall`）+ `need_human(policy='watchdog')` 进 pending=1；`hangs=2`。
→ M2 目标达成：**旧执行不再参与状态/交付物**。

### 12.6 M3 复验：demo 计数改为“本次运行增量”

同一 checkout 连续两次 `node bin/demo.mjs`：

| | runTag | passed | `metrics.decisionsInDb` | `metrics.decisions` | tasks |
|---|---|---|---|---|---|
| run 1 | `dmvz5nlui` | 30/0 | **4** | **4** | `done:6` |
| run 2 | `dmvz5nm58` | 30/0 | **4** | **4** | `done:6` |

两次完全一致 → 计数不再累计。修补前作者的 evidence 是 8（累计），现在 **4 是稳定可复现值**。
→ §4.2 记录的“不一致”在修补后**已消除**；原文保留不动，以本节为准。

### 12.7 本轮新发现（3 条，均为记账/取消语义级，非阻断）

| ID | 严重度 | 现象 | 证据 | 建议 |
|---|---|---|---|---|
| **N1** | 中低 | 旧 run 结束时把**新 attempt** 的 `active` 条目一并删掉 → 新 run 之后无法被 `abort()` | O 用例：supersede 后 `isActive=false`，但 task 仍 `running/attempt=2` 且阻塞在第 2 次模型调用；`worker.abort(taskId)` 返回 **false** | `finishStale` 删除前校验归属：`const cur=this.active.get(taskId); if(cur && cur.attempt===runAttempt) this.active.delete(taskId)` |
| **N2** | 低 | 非 stale 的异常路径不删自己的 `active` 条目 → `isActive` 永久失真、内存泄漏 | O 用例：注入 provider 异常 → task `failed`，但 `isActive(taskId)===true` | `catch` 末尾（或用 `finally`）删除本条 entry |
| **N3** | 中 | **模型调用不可中断**：`worker.run` 调 `llm.chat` 时没有把 `signal` 传下去（只有工具调用传了） | `worker.mjs:116` 无 `signal`；`worker.mjs:142` 有。C2 中 hung promise 永不返回 → 无 `worker_superseded`（已写成显式断言） | `this.llm.chat({... , signal})`；`llm.mjs` 已支持 signal，mock 分支也应响应 |

N1/N2 已在 `probes-*` 中固化为 case **O**，每次一键复跑都会重新观测（`still_present` 字段）。

### 12.8 残余风险（修补后仍然存在）

1. **N1/N2/N3 未修**：属记账与取消语义；不影响“旧执行不写交付物”这条主结论，但会让「第二次 abort」失效、并让每次 stall 泄漏一个挂起 Promise 直到 `LLM_TIMEOUT_MS`（默认 60 s）。
2. **订阅仍无自动关闭**：M1 只提供显式解绑入口；长期运行时仍需人工/脚本清理，`unsubscribe` 事件可作审计依据。
3. **workdir 仍按 taskId 复用**：旧 run 若恰在 `updateTask`/写文件瞬间被 abort，理论上有极窄 TOCTOU 窗口（本轮未复现）。
4. **面板 unsubscribe 按钮**只在服务端渲染代码中确认（`server.mjs:100/106`），未做浏览器点击验证（API 已验）。
5. §8 的原有未覆盖项（真实模型、真实 GitHub/飞书渠道、跨机/存算分离、soak、断电级损坏）**依旧未覆盖**。

### 12.9 复验结论

**PASS**：`node --test` 20/20、`bin/demo.mjs` 30/30、独立探针 **148/148**（A–G + O），`scripts/verify.ps1` 一键复跑 `RESULT: PASS`、**EXIT=0**。
M1/M2/M3 三条修补均达成目标（M1 有正面证明、M2 有 abort+no-double-write 证据、M3 有连续两次一致计数）；新增 3 条非阻断问题（N1/N2/N3）已固化进 case O 并列入残余风险。

**本轮产物**：`verify-out/verify-20261102-190742.log`（44,175 B，一键复跑完整 transcript）、`verify-out/probes-2026-11-02T11-07-50-591Z.json`（148 条断言明细）、`verify-out/regress-20261102-190703/`（定向回归副本）、`scripts/probes/p7-unsubscribe.mjs`、`scripts/probes/p8-bookkeeping.mjs`、重写的 `scripts/probes/p3-watchdog.mjs`。


---

### 12.10 N1/N2/N3 修补后复验（最终轮 · 交付说明中称“§12.4”）

> 编号说明：§12.4 已被“M1 正面证明”占用，为避免与已发出的引用冲突，本节以 **12.10** 追加，内容即交付说明里的“§12.4 N1/N2/N3 修补后复验”。

#### 12.10.1 改动面（对照上一轮冻结态 `verify-out/clean-20261102-190742/`）

**恰好 3 个文件变更，21 个未变，0 新增，0 删除**（与交付说明一致）：

| 文件 | 上一轮 | 本轮 | 说明 |
|---|---|---|---|
| `src/worker.mjs` | 11,278 B | **11,901 B** | `runSeq` + `runId=taskId#attempt#seq`；`releaseActive(taskId,runId)` 校验归属，非 owner 记 `active_keep` 并跳过；active 清理收敛进 try/finally；`llm.chat` 传 `signal` |
| `src/llm.mjs` | 4,585 B | **4,699 B** | mock 分支遇已 abort 的 signal 抛 `LLMError('aborted before mock call')` |
| `test/watchdog.test.mjs` | 6,195 B | **6,974 B** | 重写 1 例（用 abort-aware 可控慢 mock），仍为 20 例 |

#### 12.10.2 before / after 对照

| 项 | 修补前（§12.7 观测，case O） | 修补后（本轮实测） | 判定 |
|---|---|---|---|
| N1 supersede 后 `isActive(taskId)` | **false**（条目被旧 run 删掉） | **true** | 已修 |
| N1 supersede 后 `active.attempt` | 无条目 | **2** | 已修 |
| N1 supersede 后 `worker.abort(taskId)` | **false** | **true**（并记第 2 条 `worker_abort`） | 已修（核心症状） |
| N1 记账 | 无痕删除 | **1 条 `active_keep`**，`owner=task#2#2 / caller=task#1#1` | 已修（新增背压日志） |
| N2 失败运行后的 `isActive` | **true**（泄漏） | **false** | 已修 |
| N3 `worker → llm.chat` 的 signal | 未传（`undefined`） | **AbortSignal 已传** | 已修 |
| N3 abort → 旧 run 结算 | 永不返回（无 `worker_superseded`，只能等 60 s 超时） | **2 ms** | 已修 |
| case O 断言数 | 9 | **10** | +1 |
| case C 断言数 | 30 | **40** | +10 |
| 全量断言总数 | 148 | **159** | +11 |

#### 12.10.3 N3 的独立测量（未沿用实现方自测数值）

- **注入方式**：我自己的 chat 替身 = “仅在 `req.signal` 触发 abort 时 reject，否则**永不 resolve**”（无限挂起）。不是实现方说的 4000 ms 延迟。
- **计时方式**：钩住 `engine.worker.abort` 记录调用时间戳，与旧 run 的 promise 结算时间相减（早期用轮询观测会出现 −13 ms 的负值，已改掉）。
- **阈值自定**：`< 2000 ms`（`LLM_TIMEOUT_MS` 默认 60 000 ms）。
- **实测**：`sawSignal=true`；`abort → settle = 2 ms`；旧 run `status='superseded'`、`worker_superseded{where:'error-path', aborted:true}`。
- 结论：abort 现在能真正打断模型调用，而不是只“抑制后续写入”。（若 provider 自己忽略 signal，则仍不可中断 —— 见 12.10.5 第 2 条。）

#### 12.10.4 N1 正向断言（lead 要求的三条，全部通过）

1. supersede 之后 `isActive(taskId) === true`；
2. 且 `worker.active.get(taskId).attempt === 2`（`owner=task#2#2`）；
3. 且此时再调 `worker.abort(taskId)` 返回 **true**（当初的失败症状就是 false），并留下第 2 条 `worker_abort` 事件。

补充：M2 既有断言无回归 —— 旧 run 不写状态（task 行始终不带 `OLD-ATTEMPT-1`）、不写交付物、`worker_report` / `task_done` 各仅 1 条、`attempt 2` 唯一提交。

#### 12.10.5 已知行为（刻意语义，不是缺陷）

- **手工 `abort()` 后任务会停在 `running`，直到下一次 watchdog 巡检接手。** 本轮 C4 实测链路：`running/attempt=2` →（手工 abort，记第 2 条 `worker_abort` + 第 2 条 `worker_superseded`）→ 停在 `running` → 下一次巡检 `watchdog_stall`（第 2 次）→ 重启到 `attempt=3` → 提交 `done / ATTEMPT-3`。
  → abort 的语义是“取消这次执行”，不是“重新排队”；重排由 watchman 负责。运维需要知道这个时延上界 = `WATCHDOG_STALL_MS`（默认 15 s）+ 巡检间隔。
- **`active_keep` 是正常记账**：supersede 时旧 run 发现自己已不是 owner，于是记录并放弃删除（case C1 / O 各有 1 条）。它出现**说明保护生效**，不是异常。

#### 12.10.6 本轮探针自身修正（诚实记录，均非实现问题）

1. “旧 summary 未落到 task 行”原断言 `=== null`，与 attempt 2 秒级提交形成竞态 → 改为 `!== 'OLD-ATTEMPT-1'`，语义等价且无竞态。
2. `active_keep` 原本被我断言为“应不存在”，方向写反 → 改为断言其条数与 `owner/caller` 归属（更强）。
3. N3 计时原用轮询观测点，出现 −13 ms → 改为钩住 `abort()` 取时间戳。

#### 12.10.7 残余风险（最终）

1. 手工 abort 的“停 running 直到巡检”是刻意语义（见 12.10.5），需在运维文档写明时延上界。
2. **非协作 provider**（忽略 AbortSignal）仍无法中断：每次 stall 会泄漏一个挂起 Promise，最长 `LLM_TIMEOUT_MS`（60 s）。C2 已用“忽略 signal 的替身”实证（`worker_superseded=0`）。属 provider 侧能力，不是本实现缺陷。
3. 订阅仍无自动关闭：M1 只提供显式解绑入口，长期运行仍需人工/脚本清理；`unsubscribe` 事件可作审计。
4. `workdir` 仍按 `taskId` 复用（未按 attempt 分目录）：旧 run 若恰在 `updateTask`/写文件瞬间被 abort，理论上有极窄 TOCTOU 窗口（两轮均未复现）。
5. 面板 unsubscribe 按钮只在服务端渲染代码确认（`server.mjs:100/106`），未做浏览器点击验证（API 已验）。
6. §8 的原有未覆盖项（真实模型、真实 GitHub/飞书渠道、跨机/存算分离、soak、断电级损坏）不变。

#### 12.10.8 最终结论

**PASS**：`node --test` **20/20**、`bin/demo.mjs` **30/30**、独立探针 **159/159**（A15 B12 C40 D20 E26 F12 G24 O10），`scripts/verify.ps1` 一键复跑 `RESULT: PASS`、**EXIT=0**。
N1/N2/N3 三条均已修复并有 before/after 证据（N1 三条正向断言 + `active_keep` 归属、N2 泄漏消失、N3 signal 透传 + 2 ms 收敛）；M2 既有断言无回归；**无阻断项**。

**本轮产物**：`verify-out/verify-20261102-191126.log`（47,018 B，一键复跑完整 transcript）、`verify-out/probes-2026-11-02T11-11-35-844Z.json`（159 条断言明细）、`verify-out/final-20261102-191057/`（本轮干净副本）、重写的 `scripts/probes/p3-watchdog.mjs`（40 断言）与 `scripts/probes/p8-bookkeeping.mjs`（10 断言）。


---

## 13. T7 托管场景验收（摄取 / 并发 / 项目隔离 / 常驻存活 / 自启）

> 验收人：qa-verifier。被测：`local-superagent/`（task-6 的常驻托管改造）+ `scripts/hosting/`。
> 命令入口：`scripts/verify.ps1` → **RESULT: PASS，EXIT=0**；探针 **254/254**。写入范围：`scripts/`、`docs/05-`、`verify-out/`。
> 本节之前的 §0–§12 保持原样（那一轮只覆盖 A–G/O）。

### 13.1 改动面（对照上一轮冻结态 `verify-out/final-20261102-191057/`）

`local-superagent/` 内 **4 改 1 增**（`src/config.mjs`、`src/db.mjs`、`src/router.mjs`、`src/server.mjs`；新增 `test/hosting.test.mjs`），20 个文件未变。
`local-superagent/` **之外**另有 `scripts/hosting/{start-hosted.ps1, install-autostart.ps1, measure-loop.ps1}`（task-6 新增，位于我 task-7 的 `scripts/` 写入范围内，我只读、未改）。

### 13.2 用例结果

| ID | 断言 | 结果 | 关键实测 |
|---|---|---|---|
| H1 摄取 | 22 | **22/22** | `router.received` 0→**10**（常驻进程自报，非 CLI）；10 条全部 `batched`→`dispatched`；2 个 task（批合并 5+5）、10 个 trigger 全部挂到 task；面板 HTML 列出新 task；空 text → 400；`tasks[].project` 字段存在 |
| H2 并发 | 12 | **12/12** | cap=2；**峰值 inflight=2**、期间 **queued 峰值=6**、超限样本 **0**；102 个样本中 33 个看到饱和双跑；8 条全部 done；6 条 `task_dequeued` 事件里 inflight 均为 1（<cap）；stub worker 被调用 8 次 |
| H3 隔离 | 17 | **17/17** | 前缀 `proj-a/`/`proj-b/` 正确落到 task.project；workdir = 各自真实项目目录；无前缀线程回退 `.work/<taskId>`；交付物分别落在各自项目；两项目 canary **SHA-256 未变**；越界写 `..\proj-b\pwn.txt` 被拒（`path escapes worker workdir`）、`worker.denied=1`、proj-b 下无 pwn.txt |
| H4 存活/恢复 | 17 | **17/17** | `start-hosted.ps1` 分离启动 + 幂等（第二次报 already running）；pid 文件；任务到 `running` 后 `taskkill /F` → 端口释放、DB 仍 `running`；重启后 `recovered` 事件 `{from:"running"}`、attempt 1→2、**同一 session 复用**、done；`-Stop` 退出 0、端口释放、pid 文件清理 |
| H5 自启 | 27 | **27/27** | 三级降级全部实测：默认 → `scheduled-task`；`-SkipScheduledTask` → `startup-folder`；再 `-SkipStartupFolder` → `hkcu-run`；每级都断言"**只有该级产物存在**"；连续两次 install 仍单级生效、输出无 WARNING/residue；`-Remove` 后三级产物全空、`schtasks` 集合与 baseline **identical** |
| 合计 | **254** | **254/254** | 另：`node --test` **25/25**、`bin/demo.mjs` **30/30** |

H5 判据按 lead 的新要求改为"**不信 -Status 自报，直接验三级产物**"：权威来源是 ①`Get-ScheduledTask -TaskName local-superagent` ②`<Startup>\superagent-host.cmd` ③`HKCU:\...\Run::local-superagent`；`-Status` 只做一致性交叉检查（不一致会 FAIL）。

### 13.3 环境更正（与 lead 的前提不同，需记录）

lead 给的前提是"本机 `schtasks /Create` 与 `Register-ScheduledTask` 都返回 Access is denied（非管理员）"。**实测不成立**：本轮 `Register-ScheduledTask` 成功，任务状态 `Ready`，tier 1 正常工作。
- 证据：`install-autostart.ps1` 输出 `[1] scheduled task: OK -> local-superagent`；`Get-ScheduledTask` 查到任务；`-Status` 报 `ACTIVE: scheduled-task`。
- 影响：默认路径就是 tier 1；降级链（tier 2/3）用 `-SkipScheduledTask` / `-SkipStartupFolder` 强制触发并分别验证。
- 差异原因未查（可能是 lead 当时在受限会话/不同账号下测），但结论以本轮实测为准。

### 13.4 本轮发现

| ID | 级别 | 现象与证据 | 状态 |
|---|---|---|---|
| **D1** | 阻断（已修） | `install-autostart.ps1 -Remove` **只清当前 ACTIVE 那一级**，另两级残留 → 跨轮残留导致 `-Status` "时有时无"。我的复现：phase1 装 tier1 后 `-Remove`，紧接着 `-Status` 报 `startup-folder`（上一轮遗留的 shim） | impl 已修：安装前 pre-clean + `-Remove` 三级全清（输出 `remove: clean (all three levels absent)`），H5 由 4 FAIL 变 27/27 |
| **D2** | 我的探针缺陷（已修） | H5 里函数参数写成 `[string[]]$args`，与 PowerShell 自动变量 `$args` 冲突 → `@args` 展开丢失 `-Remove` 标志，**真的把计划任务装上了**（而不是删掉） | 已改名为 `$psArgs`；当轮残留已手工清除并核验 `CLEAN`（task/shim/HKCU 全空）；已在脚本注释里写明这个坑 |
| **D3** | 观察（已缓解） | 子进程退出后，计划任务/注册表状态还要 **~600–870 ms** 才稳定（H5 记录的 settleMs：593/616/646/677/857/866）→ 不做轮询会得到**假红** | 探针改为有界轮询（≤10 s）并把 settleMs 记进证据；永久不一致仍会 FAIL |

### 13.5 未覆盖（明确未验证）

- **真实登录触发**：没有注销/重新登录去验证 Startup shim 与 HKCU Run 真会拉起进程（只验证了产物写入与内容）。
- 多用户/HKCU 其他用户、组策略（GPO）下发、企业管控场景。
- 常驻长跑 soak（小时级）、订阅/事件表无界增长、面板前端交互。
- 端口抢占/竞态（`start-hosted` 用 `Get-NetTCPConnection` 判断，极端竞争下仍可能双启）。
- 真实模型与真实 GitHub/飞书渠道（仍为 mock/stub）。

### 13.6 复跑

```powershell
powershell.exe -NoProfile -File scripts\verify.ps1
# 只跑托管组：node scripts\probes\run-all.mjs verify-out\clean-<ts> verify-out --only=H1,H2,H3,H4,H5
# 单独跑 H5（会短暂注册/移除自启项，finally 里必清）：
powershell.exe -NoProfile -File scripts\probes\h5-autostart.ps1
```

**本轮产物**：`verify-out/verify-20261102-222315.log`（74,774 B，含 test/demo/H1–H5 全量输出）、`verify-out/probes-*.json`（254 条断言明细）、`verify-out/hosted-projects/`（两套项目夹具 + manifest）、`verify-out/h5-schtasks-baseline.json`、`verify-out/h4-state/`、`verify-out/h4-logs/`、`scripts/probes/{hlib,h1-ingest,h2-concurrency,h3-isolation,h4-resident,h5-autostart}.mjs/.ps1`。

### 13.7 结论

**PASS**：H1–H5 全绿（22+12+17+17+27），一键复跑 `254/254`、测试 `25/25`、demo `30/30`，`verify.ps1` **EXIT=0**。
D1（阻断级）已由 impl 修复并被本轮验证覆盖；D2 是我的探针缺陷（已修并披露）；D3 属 OS 状态稳定延迟（探针已用有界轮询吸收）。无遗留阻断项；残余风险见 13.5。


### 13.8 修补后复验（`-Remove` 三级全清 + D1 跨 thread 合批）

> 触发：impl 修了 ①`install-autostart.ps1`（`-Remove` 无条件清三级 + install 前 pre-clean + 多级 WARN）②D1 跨 thread 合批（按 thread 分组）。本节为修补后复验，不覆盖 13.1–13.7。

#### 13.8.1 我改了哪些判据

| 用例 | 变化 | 原因 |
|---|---|---|
| H1 | 22 → **25** 断言 | D1 之后：新增"跨 thread 不被合并（0 条）"、"decisions == 10（每 thread 一条）"、"tasks == 10" |
| H2 | 12 → **18** 断言 | 新增 **cap=1 对照**（峰值必须为 1、queued>0、且严格小于 cap=2 的峰值）——按 deploy-runner 的结论，cap≥3 会被 router 逐 thread 串行 await 掩盖，因此有意义的对照是 cap=1 vs cap=2 |
| H5 | 27 → **31** 断言 | 新增 phase5：人为制造"计划任务 + Startup shim"两级 → `-Status` 必须报 `WARN: multiple levels present`；`-Remove` 必须把**非活跃那级**也删掉（D1 的直接回归）；并把 WARN 匹配从 `WARNING` 扩到 `WARN`（覆盖新的 `WARN:` 前缀） |

另外按 lead 的 PS 5.1 坑修了编码：`scripts/probes/*.ps1`、`scripts/hosted/*.ps1`、`scripts/verify.ps1` 统一改为 **UTF-8 with BOM**，并把唯一一个非 ASCII 字符（注释里的 em dash `—`）去掉；现已全部 0 非 ASCII。

#### 13.8.2 最终计数（一键复跑 `scripts/verify.ps1`，EXIT=0）

`node --test` **25/25** · `bin/demo.mjs` **30/30** · 探针 **267/267**

| 组 | A | B | C | D | E | F | G | O | H1 | H2 | H3 | H4 | H5 | 合计 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 断言 | 15 | 12 | 40 | 20 | 26 | 12 | 24 | 10 | **25** | **18** | 17 | 17 | **31** | **267** |

（上一次全量是 254；本次 267 = 254 + H1 3 + H2 6 + H5 4。）

#### 13.8.3 H5 五步结论

1. **setup**：`-Remove` → `scheduled-task / startup-folder / hkcu-run` 全部 `already-absent` 或 `removed`，三路产物直验为 `{task:false, startup:false, hkcu:false}`，`-Status` = none（状态稳定耗时 ~600–920 ms，已用有界轮询吸收）。
2. **phase1（默认链）**：`scheduled-task` 单级生效（levelCount=1，另两级 false）；`-Status` 与产物一致；`-Remove` 后三级全空且输出 `remove: clean (all three levels absent)`。
3. **phase2（`-SkipScheduledTask`）**：`startup-folder` 单级生效；shim 内容为 `powershell.exe … -File "<repo>\scripts\hosting\start-hosted.ps1" -Port 3987 -Hidden`；`-Remove` 后全空。
4. **phase3（再 `-SkipStartupFolder`）**：`hkcu-run` 单级生效；Run 值指向 start-hosted.ps1；`-Status` 一致；`-Remove` 后全空。
5. **phase4 + phase5**：连装两次 → 仍**单级**、两份安装输出**无 WARN/residue/FAILED**；人为造两级（task + leftover shim）→ `-Status` 输出 `WARN: multiple levels present (scheduled-task, startup-folder)`，`-Remove` 输出 `startup-folder: removed`（**非活跃级也被清掉**，D1 回归点）→ 三级全空。
   最终：三路产物全 false，`schtasks` 集合与 baseline `identical=true`，系统**零残留**（独立复查：task=False / shim=False / HKCU=[]）。

#### 13.8.4 本轮发现（均为我的探针缺陷，已修）

| ID | 现象 | 修法 |
|---|---|---|
| D4 | H2 尾部引用 cap=2 块内的 `const seen` → `ReferenceError: seen is not defined`，H2 直接崩 | 提升为外层 `let cap2Peak`，在 cap=2 段赋值，cap=1 对照段读它 |
| D5 | `h5-autostart.ps1` 注释里有一个 em dash + 无 BOM | 去掉非 ASCII 并统一 BOM（见 13.8.1） |
| D2（前轮） | 函数参数名 `$args` 撞 PS 自动变量导致丢标志 | 已改 `$psArgs`，本节复跑中未再出现 |

#### 13.8.5 结论

**PASS，无阻断项**：`-Remove` 三级全清（含非活跃级）与 WARN 均已正面验证；D1 之后每 thread 一条决策，跨 thread 不再合并（10 thread → 10 decisions / 10 tasks）；并发闸门以 cap=1 vs cap=2 的在途峰值对照证明（1 vs 2，均无超限样本）。
残余风险沿用 13.5（真实登录触发未验证、多用户/GPO、soak、端口竞态、真实模型/渠道），另加一条设计注记：**cap≥3 在单 thread 串行 decide 下无可观测收益**（deploy-runner 实测 + 我的 cap 对照一致），若将来支持并行 decide 需重测。

