# research/sources/ — 抓取留档说明与抓取日志

> 注意：本目录下的 `README.md` 是**上游仓库的 README 逐字副本**，不是本说明。本说明文件名是 `_CAPTURE-LOG.md`。

本目录是 task-1 的**原始材料证据区**。每个文件顶部 7 行头部给出：

```text
source_url : 逐字抓取的完整 URL
fetched_at : 抓取时间（+08:00 与 UTC 双标）
sha256     : 该文件正文的 SHA-256（不含头部）
bytes      : 字节数
note       : 说明"以下是逐字原文，未改写、未截断"
```

**行号换算**：本地行号 = 上游仓库原文行号 **+ 7**（头部偏移）。
未加头部的同内容副本在 `research/raw/`，行号 = 上流行号，按行号核对请用那份。

## 1. 抓取方式

```text
GET https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/<path>
工具：curl.exe -sS -L --max-time 45（Windows 11 内置 curl）
目录枚举：GET https://api.github.com/repos/deepseek-ai/dsh-superagent-prototype/contents/<dir>
完整树：  GET https://api.github.com/repos/deepseek-ai/dsh-superagent-prototype/git/trees/main?recursive=1
```

抓取期间 **raw.githubusercontent.com 间歇性断连**（curl 退出码 56 Recv failure / 28 timeout），
脚本用"最多 4 次重试 + 递增退避"处理，**每个文件最终都成功**。
交叉校验：24/24 文件字节数 = GitHub contents API 返回的 `size`。

## 2. 已抓取清单（24 个）

| 文件（本地名） | 上游路径 | 字节 | 用途 |
| --- | --- | --- | --- |
| README.md | /README.md | 2571 | 定位、边界、免责声明 |
| SETUP.md | /SETUP.md | 7894 | 交互式安装步骤 |
| package.json | /package.json | 4693 | bundle 声明、engines、peerDeps |
| cordis.patch.yml | /cordis.patch.yml | 8398 | ★ 两个 preset 的完整工具面 |
| examples__profile.cordis.patch.yml | /examples/profile.cordis.patch.yml | 474 | ★ 用户 profile 模板 |
| docs__000-philosophy.md | /docs/000-philosophy.md | 3251 | 操作哲学 |
| docs__001-domain.md | /docs/001-domain.md | 12442 | 领域模型 |
| docs__002-authorization.md | /docs/002-authorization.md | 13372 | ★ 授权模型 |
| docs__003-execution.md | /docs/003-execution.md | 17389 | 执行与交付 |
| docs__004-prompts.md | /docs/004-prompts.md | 9603 | prompt 分层 |
| docs__005-panel.md | /docs/005-panel.md | 6218 | 面板 |
| docs__006-deployment.md | /docs/006-deployment.md | 23244 | ★ 部署/权限/排错 |
| docs__007-architecture.md | /docs/007-architecture.md | 70507 | ★ 实现架构（机制主源） |
| docs__008-cookbook.md | /docs/008-cookbook.md | 29826 | 新增 Source |
| scripts__dsh-superagent | /scripts/dsh-superagent | 12223 | ★ 服务脚本（python3+fcntl+tmux、退出码） |
| src__deployment.ts | /src/deployment.ts | 9650 | ★ 机器限制默认值 |
| src__limits.ts | /src/limits.ts | 415 | 校验上下界 |
| src__policy.ts | /src/policy.ts | 19082 | Policy schema |
| src__admission.ts | /src/admission.ts | 1066 | admission 表 |
| src__kv.ts | /src/kv.ts | 4413 | 持久化 KV |
| src__navigation.ts | /src/navigation.ts | 1217 | 面板跳转（按 Session id） |
| src__setup.ts | /src/setup.ts | 2715 | 启动校验 |
| src__index.ts | /src/index.ts | 1990 | 插件入口 |
| （raw 侧）__tree.json | git/trees/main?recursive=1 | 72160 | 完整文件树（216 blob） |

## 3. 抓取失败项（如实记录，含错误原文）

### 3.1 官方技术文章正文：**未定位，抓取失败**

| 候选 URL | 结果 | 错误/状态原文 |
| --- | --- | --- |
| `https://www.deepseek.com/blog` | **失败** | `HTTP 404`（curl `-w '%{http_code}'` 返回 `404`） |
| `https://www.deepseek.com/en/harness/` | 200 但**不是文章** | 页面存在，**0 处提及 super-agent**（qa-verifier 独立核实） |
| README 内是否有文章外链 | 无 | `README.md:7` 只链 `https://www.deepseek.com/en/harness/` |

**结论**：一手文章 URL 无法从官方仓库/官网定位。
docs/01、docs/02 中所有"文章侧"内容一律标 **[文章设计]** 并注明
**"二手源（IT之家 2026-10-31 / explainx 2026-11-01 转述）"**，
**未编造任何 deepseek.com 文章链接**。

### 3.2 范围内但未抓（非失败，时间盒取舍）

| 项 | 原因 |
| --- | --- |
| `prompts/*.md`（13 个）、`skills/*/SKILL.md`（2 个） | 优先保证 docs/01、docs/02 落盘；按同一 URL 规则可补抓 |
| `src/` 其余 ~92 个文件 | `docs/007-architecture.md` 已逐模块描述职责，够写架构文档 |
| `tests/*.spec.ts`（52 个） | 未用于本文档结论 |
| 上游 git 历史 / release | 未取；`package.json` 版本 0.1.0，`pushed_at` 2026-10-31T12:05:51Z |

## 4. 一致性校验

- 24/24 文件字节数 = contents API `size`。
- SHA-256 逐文件写入头部，可判定"引用后是否被改动"。
- 仓库树 `truncated: false`，216 blob → 文件清单完整。

## 5. 易漂移数据（必须带采样时间）

| 项 | 值 | 采样方 | 时间 |
| --- | --- | --- | --- |
| stars | 10,875 | source-analyst（GitHub API） | 2026-11-02T10:4xZ（≈18:4x+08:00） |
| stars | 10,887 | qa-verifier | 2026-11-02T18:45:11+08:00 |
| forks | 1,123 / 1,124 | 同上 | 同上 |
| pushed_at | 2026-10-31T12:05:51Z | GitHub API | — |

媒体"2,800 星"与实测差一个量级，**不成立**。
