# NOTICE / 归属说明

本仓库是**独立研究产出**，不属于 DeepSeek 官方项目。

## 第三方内容

1. **dsh-superagent（研究原型）** — 作者 DeepSeek Harness Team，MIT License，
   上游：https://github.com/deepseek-ai/dsh-superagent-prototype
   - 本仓库**不包含**上游源码副本（`deploy/upstream/` 已在 .gitignore 中排除，请自行 clone）。
   - `research/sources/` 保留了上游文档（docs/000–008、README、SETUP、cordis.patch.yml 等）的抓取快照，
     每篇文件顶部标注了 `source_url` / `fetched_at` / `sha256`，用于可复核引用；版权归原作者，遵循 MIT。
   - `docs/01`、`docs/02` 中的引用、行号与结论均以该上游版本为准。

2. **DeepSeek Harness (DSH)** — `docs/03` 描述的部署对象，非本仓库分发物。

## 本仓库原创部分

- `docs/00`–`docs/08`：研究、部署手册、验收与自 loop 记录
- `local-superagent/`：独立实现的 Super-agent 最小系统（Node 24 内置模块，零依赖）
- `scripts/`：验收探针、托管脚本、自检事件源
- `deploy/`：Windows 部署脚本与配置样例（不含任何凭据）

## 不包含的内容

- 任何 API Key、GitHub Token、`.credentials.yaml`、运行时数据库与日志
- 上游源码副本、验证过程中的大体积临时副本（`verify-out/`）

## 商标

DeepSeek、DeepSeek Harness 为其权利人商标。本仓库仅作技术研究引用。
