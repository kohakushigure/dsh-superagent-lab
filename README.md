# dsh-superagent-lab

**DeepSeek Super-agent（2026-10-31）研究 + 一个真能跑的本地托管 loop。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)
![Tests](https://img.shields.io/badge/tests-26%20passing-brightgreen)
![Probes](https://img.shields.io/badge/independent%20probes-267%2F267-blue)

> 目标：完全理解 DeepSeek 在 **2026-10-31** 发布的 Super-agent 方案，并搞清楚"怎么在本机部署一个 superagent"。
>
> 本仓库是**独立研究产出**，与 DeepSeek 官方无关；上游研究原型（MIT）的源码副本未包含在内，见 [NOTICE.md](NOTICE.md)。
>
> 三句话结论：①它真正新的只有一件事——把"人手动切会话"换成"系统分诊 + 并行执行 + 回原对话"；②官方原型是研究代码，**原生 Windows 跑不通**（两道 POSIX 硬墙，实测记录在 docs/03）；③本仓库的 `local-superagent/` 是零依赖重实现，本机可跑，且已经在管它自己的仓库（docs/08）。

本仓库回答三个问题：

1. **它到底是什么**（不是"两个进程"，是一套以事件和授权为中心的领域模型）→ [docs/00-overview.md](docs/00-overview.md)
2. **它怎么设计、为什么这么设计** → [docs/01-architecture-deep-dive.md](docs/01-architecture-deep-dive.md) + [docs/02-official-prototype-digest.md](docs/02-official-prototype-digest.md)
3. **在本机怎么跑起来**（两条路线，含实测与卡点）→ [docs/03-local-deployment-runbook.md](docs/03-local-deployment-runbook.md) + [local-superagent/](local-superagent/)

---

## 30 秒结论

| 问题 | 答案 |
| --- | --- |
| 发布的是什么 | 一篇设计文章 《Super-agent 设计探索：迈向更自主的 Agent 系统》 + 一个 MIT 研究原型 dsh-superagent（DSH 插件包） |
| 核心创新 | 把"人切换会话"换成"系统分诊 + 并行执行 + 回原对话"；其余是调度/缓存/存算分离/看门狗的经典思路移植 |
| 真实概念 | Source → Trigger → Thread → Eval（Gate 准入 + Assessment 研判）→ Decision → Mandate → Ticket → Assignment → Executor；Subscription 做扇出 |
| 能不能生产用 | 不能。上游明说 "Research prototype ... not production-ready" |
| 收益是什么 | 注意力与时延；不是编码能力（实验用合成负载、编码被工具模拟） |
| 成本是什么 | 权限。Router/Worker 以你的 OS 用户近乎无审批执行 |
| 本机能不能原样跑 | **原生 Windows 不能**：stateDir 校验 /^\\// 拒盘符；scripts/dsh-superagent 依赖 python fcntl + tmux |
| 那怎么办 | 两条路线：A 在 WSL2/容器里跑官方原型；B 用 local-superagent/（纯 Node 24，本机可跑，等价实现五机制） |

---

## 目录结构

```
dsh-superagent/
├─ README.md                     ← 你在这里
├─ docs/
│  ├─ 00-overview.md             总纲：领域模型、五模块对照、决策矩阵、红线
│  ├─ 01-architecture-deep-dive.md  架构深读（机制、状态机、上下文、实验）
│  ├─ 02-official-prototype-digest.md  上游仓库逐文件档案与配置字段
│  ├─ 03-local-deployment-runbook.md   Windows/Linux 部署手册（含实测与卡点）
│  ├─ 04-local-implementation.md  自建实现设计 + 与官方逐条对照
│  ├─ 05-validation-report.md     端到端验收记录
│  ├─ 06-fact-check.md            事实核查：每条声明→出处→判定（含纠错）
│  ├─ 07-loop-hosting-feasibility.md  本机能不能常驻托管/托管小项目（实测）
│  └─ 08-selfloop.md              让这个 loop 管这个项目的实跑记录
├─ research/                     上游原文抓取快照（带 URL/时间/SHA256）
├─ deploy/                       官方原型部署产物：upstream 克隆、profile、脚本、日志
├─ local-superagent/             自建可运行实现（Node 24，零重型依赖）
└─ scripts/                      一键验证脚本
```

---

## 快速开始

### B 路线：本机直接跑自建实现（推荐先做）

```powershell
cd local-superagent
node --test              # 20 个单元/集成用例
node bin/demo.mjs        # 11 段场景 / 30 条断言，无 Key 也能跑（mock 模型，自清 state）
node bin/superagent.mjs status
```

接真实模型（任意 OpenAI 兼容网关）：

```powershell
$env:OPENAI_BASE_URL="https://api.example.com/v1"
$env:OPENAI_API_KEY="sk-..."
$env:MODEL_ROUTER="deepseek-chat"      # 分诊用轻量模型
$env:MODEL_WORKER="deepseek-reasoner"  # 执行用强模型
node bin/superagent.mjs start
```

细节与设计取舍见 [docs/04-local-implementation.md](docs/04-local-implementation.md)。

一键复跑全部验收（干净副本 + 测试 + demo + 8 组独立探针）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1
# 结果：RESULT: PASS  →  20/20 测试 · 30/30 断言 · 159/159 探针检查
# 详细：docs/05-validation-report.md；原始日志 verify-out/verify-<ts>.log
```

### A 路线：官方原型（Windows 需 WSL2/容器）

```powershell
# 原生 Windows 的结论与替代路径见 docs/03
code docs/03-local-deployment-runbook.md
```

上游克隆在 [deploy/upstream/](deploy/upstream/)。**注意：这份 checkout 已被打上 2 行研究用补丁**（`src/deployment.ts` 与 `src/policy.ts` 各 1 行，为绕过 `stateDir` 的 `/^\//` 约束），与上游 main 不一致；还原命令见 [docs/03](docs/03-local-deployment-runbook.md) §3.5，引用行号时以未打补丁的上游为准。

### 本机实测到哪一步（详见 [docs/03](docs/03-local-deployment-runbook.md) §1）

| 环节 | 状态 |
| --- | --- |
| clone / `pnpm install` / `pnpm build` | [已实测通过] |
| profile 创建、`dsh plugin add link:` | [已实测通过] |
| 插件挂载 + 管理面 API + 建库（trigger/ticket 9 张表） | [已实测通过]（需先打那 2 行补丁） |
| setup 自检（gh 探针） | [已实测失败: spawn env ENOENT] — Windows 无 `env`，不可小补丁绕过 |
| 官方 `scripts/dsh-superagent` 启动器 | [已实测失败] — python3 + fcntl + tmux |
| 整体启动链路 / 首个工单 / PR | [未实测] |

结论：**原生 Windows 上 A 方案止步于"插件能挂载、管理面能应答"，不能完成 setup 与首个工单。** 官方支持面内的路是 WSL2/容器；要当天跑通，用 B 路线。

---

## 阅读顺序

1. [docs/00-overview.md](docs/00-overview.md) — 先建立正确心智模型（避免被"Router/Worker 两个进程"带偏）
2. [docs/01-architecture-deep-dive.md](docs/01-architecture-deep-dive.md) — 机制层
3. [docs/06-fact-check.md](docs/06-fact-check.md) — 哪些说法有出处、哪些是转述（**建议和第二篇一起读**）
4. [docs/03-local-deployment-runbook.md](docs/03-local-deployment-runbook.md) + [docs/04-local-implementation.md](docs/04-local-implementation.md) — 怎么落地
5. [docs/05-validation-report.md](docs/05-validation-report.md) — 到底跑没跑通
6. [docs/07-loop-hosting-feasibility.md](docs/07-loop-hosting-feasibility.md) — 想让它 7×24 托管时看这篇（三档形态、容量实测、自启三级）

---

## 纪律（本仓库的写作规则）

- 每条"原型实现了 X"必须能指到**文件或行**；指不到的写成"文章设计"。
- "能不能跑"只有三种标记：`[已实测通过]` / `[已实测失败+原因]` / `[未实测]`。
- 易漂移数据（star 数等）必须带**采样时间与采样方**。
- 不编造一手链接：官方文章 URL 至今未定位，引用一律写"据 IT之家 2026-10-31 报道转述"。
- 不把合成负载的调度实验换算成"编码效率"。

---

## 许可与归属

上游 dsh-superagent 为 DeepSeek Harness Team 以 MIT 许可发布；本仓库的 doc/code 为研究产出，与 DeepSeek 官方无关。
