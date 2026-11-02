# 环境实测报告（deploy/env-report.md）

采样时间：2026-11-02 18:42 — 19:00（Asia/Shanghai）
执行人：deploy-runner（task-2）
机器：Windows 11 专业工作站版 10.0.26200，28 逻辑核
工作根：`G:\Agent-workspace\dsh-superagent`

标注：`[已实测通过]` / `[已实测失败:原因]` / `[未实测]`。所有原始输出在 `deploy/logs/`。

---

## 1. 版本实测表

| 组件 | 版本 | 来源 | 判定 |
| --- | --- | --- | --- |
| Windows | 10.0.26200（Windows 11 专业工作站版） | `Win32_OperatingSystem` | — |
| 逻辑核 | 28 | `Win32_Processor` | — |
| Node.js | v24.19.0 | `C:\Program Files\nodejs\node.exe` | `[已实测通过]` 满足 `^22.19.0 \|\| >=24` |
| npm | 11.17.0 | `C:\Program Files\nodejs\npm.ps1` | `[已实测通过]` |
| corepack | 0.35.0 | `C:\Program Files\nodejs\corepack.cmd` | 可用，但 enable 失败（见 §3） |
| **pnpm** | **12.16.1**（全局） | `%APPDATA%\npm\pnpm.cmd` | `[已实测通过]` 本轮新装 |
| pnpm（仓库内有效） | 11.7.0 | `package.json` 的 `packageManager` 自管 | `[已实测通过]` |
| pnpm（dsh plugin 内） | 11.28.5 | dsh 转发 pnpm | `[已实测通过]` |
| git | 2.47.1.windows.2 | `C:\Program Files\Git\cmd\git.exe` | `[已实测通过]` ≥2.32 |
| GitHub CLI | 2.103.3 (2026-10-26) | `C:\Program Files\GitHub CLI\gh.exe` | `[已实测通过]` ≥2.48 |
| Python | 3.12.3 | `%LOCALAPPDATA%\Programs\Python\Python312\python.exe` | `[已实测通过]` ≥3.8 |
| Docker | 27.5.1 (9f9e405) | `C:\Program Files\Docker` | 仅容器方案用 |
| dsh | 0.2.1-rc.4 | `C:\Users\lhz\.dsh\bin\dsh.cmd` | `[已实测通过]` 满足 `engines.dsh: ^0.2.1-alpha.2` |
| **tmux** | **缺失** | `Get-Command tmux` 无结果 | `[已实测失败:未安装]` |
| WSL | 2.4.11.0；Ubuntu(Stopped)、docker-desktop | `wsl --version` / `wsl -l -v` | `[未实测]` 未在其中跑原型 |
| 上游原型 | `6337fc823ce20251c8de8085948165c81aaa701e`，2026-10-31T20:05:39+08:00，`dsh-superagent 0.1.0` | `git log -1` | `[已实测通过]` |

### 缺口与修复

| 缺口 | 修复命令 | 结果 |
| --- | --- | --- |
| pnpm 未安装 | `corepack enable pnpm` → EPERM；改 `npm i -g pnpm` | `[已实测通过]` 得到 12.16.1 |
| tmux 未安装 | 无 Windows 原生发行版；换 WSL2 或在 Windows 上用 `deploy/start.ps1` | `[已实测失败:上游脚本硬依赖]` |
| `corepack enable` 需管理员 | 用 `npm i -g` 落到 `%APPDATA%\npm` | `[已实测通过]` |

---

## 2. 上游仓库与依赖 / 构建

```text
git clone --depth 1 https://github.com/deepseek-ai/dsh-superagent-prototype deploy/upstream/dsh-superagent-prototype
→ Cloning into '...'   exit=0                                  [已实测通过]
commit=6337fc823ce20251c8de8085948165c81aaa701e
authorDate=2026-10-31T20:05:39+08:00
subject=feat: add the dsh-superagent research prototype
```

`pnpm install`（`deploy/logs/pnpm-install.log`）—— `[已实测通过]`，exit 0，9.6 s，234 包：

```text
? Verifying lockfile against supply-chain policies (289 entries)...
✓ Lockfile passes supply-chain policies (289 entries in 5ms)
Lockfile is up to date, resolution step is skipped
Packages: +234
dependencies:
+ proper-lockfile 4.1.2
+ zod 4.4.3
devDependencies:
+ @deepseek-ai/cordis 4.0.5-alpha.1
+ @deepseek-ai/dsh-agent 0.2.1-alpha.2
+ ... (共 234 个)
Done in 9.6s using pnpm v11.7.0
### PNPM_INSTALL_EXIT=0
```

注：出现跨盘硬链接警告（C: 的 store 硬链接到 G: 失败，pnpm 自动用 `G:\.pnpm-store`），不影响结果。

`pnpm build`（`deploy/logs/pnpm-build.log`）—— `[已实测通过]`，exit 0：

```text
ℹ tsdown v0.22.14 powered by rolldown v1.2.7
ℹ [CJS] lib\client.js  359.28 kB │ gzip: 86.67 kB
ℹ [ESM] lib\index.js   450.26 kB │ gzip: 127.47 kB
ℹ [ESM] lib\github-watch.js 33.91 kB │ gzip: 11.00 kB
ℹ [ESM] lib\feishu-watch.js  0.60 kB │ gzip: 0.29 kB
ℹ [ESM] 11 files, total: 693.50 kB
✔ Build complete in 1476ms
### PNPM_BUILD_EXIT=0
```

\WARN We recommend using the ESM format instead of CommonJS.\ 是 tsdown 对 client 产物格式的建议，非错误。

---

## 3. dsh 行为实测

### 3.1 `--from-default-profile` 三形态

```text
A  dsh superagent --from-default-profile web --dump-config        → error: unknown option '--from-default-profile'  exit=1  [已实测失败:参数位置]
B  dsh --profile superagent --from-default-profile web --dump-config → 1232 行配置树，创建 profile                exit=0  [已实测通过]
C  dsh --from-default-profile web --dump-config                     → EBUSY rename profiles/desktop → .desktop.staging-…  exit=1  [已实测失败:默认落到 desktop 且试图替换]
D  dsh --profile web --dump-config                                 → 正常打印                                        exit=0  [已实测通过]
```

C 的危险输出原文：

```text
dsh-desktop-next: failed to start packaged dsh: Error: EBUSY: resource busy or locked, rename
'C:\Users\lhz\.dsh\profiles\desktop' -> 'C:\Users\lhz\.dsh\profiles\.desktop.staging-lI5zuH\previous'
```

即：不给 profile 名时，`--from-default-profile` 会去替换默认 profile `desktop`。本机靠 desktop 应用占着文件才失败，**否则会毁掉用户 profile**。

### 3.2 DSH_HOME 重定向

| 调用方式 | `DSH_HOME` 是否生效 | 判定 |
| --- | --- | --- |
| PATH 上的 `dsh`（= `dsh.cmd`） | **否** | `[已实测失败:dsh.cmd 第 5 行 set "DSH_HOME=%USERPROFILE%\.dsh" 硬编码]` |
| 直接调 `DSH NEXT.exe --expose-internals …\desktop-cli.js` | **是** | `[已实测通过]` |

直接调用后，`deploy\dsh-home\profiles\web` 被创建（`cordis.patch.yml / cordis.yml / package.json / pnpm-workspace.yaml`），`~/.dsh\profiles` 不变。这就是 `deploy/bin/dsh-local.cmd` 的原理。

### 3.3 插件安装与管理面 API

```text
dsh plugin --profile superagent add "link:G:/…/dsh-superagent-prototype"   exit=0   [已实测通过]
→ dependencies: + dsh-superagent 0.1.0 <- ..\..\..\upstream\dsh-superagent-prototype
→ dsh.profile.bundles 追加 "dsh-superagent"
→ 警告：peerDependencies 不会从 link 目标解析（link: 协议正常行为）
```

`--dump-config` 中已出现 `# == dsh-superagent` 段落与两个 preset（`dsh-superagent-worker` / `dsh-superagent-router`）。

### 3.4 启动曲线（三次）

| # | 条件 | 结果 |
| --- | --- | --- |
| 1 | 未打补丁，`stateDir='G:\…\deploy\state'` | `[已实测失败:ValidationError /^\//]`，插件未激活，`/orchestrator/api/state` **404** |
| 2 | 打 2 行补丁 + `pnpm build` | `[已实测通过]` 面板起、`state` API **200**、SQLite 建库 |
| 3 | 修好 `start.ps1` 的空格路径 bug 后，18:51:14 再启 | `[已实测通过]` 端口 3082 监听、`status.ps1` 读到 `runtime=paused / setupPending` |

第 1 次失败的原文：

```text
dsh: warning: 2 entries did not activate
dsh-superagent (dsh-superagent): ValidationError: invalid config:
  - $.stateDir expect string to match regexp /^\// (at stateDir)
    at resolveConfig (…\@deepseek-ai\cordis\lib\index.js:960:27)
dsh-superagent-github (dsh-superagent/github-watch): pending (waiting for service: orchestrator)
```

第 2 次成功后的 `GET /orchestrator/api/state`（节选）：

```json
{"setup":{"machine":{"stateDir":"G:\\Agent-workspace\\dsh-superagent\\deploy\\state","promptMaxChars":100000,
 "admissionContextMaxPages":10,"admissionContextTimeoutMs":15000},
 "problem":{"place":"github","code":"repositoryUnset","values":{},
 "detail":"The GitHub Source names no repository."},"feishuProblem":null,"accounts":null},
 "load":{"running":0,"queued":0,"maxWorkers":3},
 "masterId":"orchestrator-537d5fa54b5827023316973d159a9d18","paused":false,
 "health":{"runtime":{"state":"paused","detail":"Waiting for the deployment check","code":"setupPending"},
 "...":"relay/notice/launch/delivery/assessment/reply/evals 均为 ready",
 "github":{"state":"paused","detail":"Waiting for the deployment check","code":"setupPending"}}}
```

### 3.5 setup 探针的两条 Windows 失败

```text
PUT settings/source:github  cli="gh"
→ HTTP 400 {"error":"The agent GitHub CLI was not found.\ngh is not an executable file on PATH",
            "setup":{"place":"github","code":"agentCliMissing"}}          [已实测失败:不按 PATHEXT 补 .exe]

PUT settings/source:github  cli="C:\Program Files\GitHub CLI\gh.exe"
→ HTTP 400 {"error":"The agent GitHub CLI cannot read its account.\nspawn env ENOENT",
            "setup":{"place":"github","code":"agentCliSignedOut"}}        [已实测失败:setup 用 env 包装进程]
```

源码定位：
- `src/deployment.ts:61-65` `executable()` 用 `statSync(candidate).isFile()` + `accessSync(X_OK)`，无 `.exe` 扩展名补全。
- `src/deployment.ts:75` `runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, …)` —— 每条 setup 探针都经 `env` 起进程，Windows 无 `env`。

`POST /orchestrator/api/executor/pause` `{"paused":true}` / `{"paused":false}` —— `[已实测通过]`。

---

## 4. 运行时数据（插件初始化的证据）

只有插件真的挂载并初始化，才会有这些：

| 对象 | 观测 |
| --- | --- |
| `deploy\state\orchestrator.sqlite` | 4096 B + `-wal` 177192 B + `-shm` 32768 B |
| 表结构（只读打开） | `decision, disposition, effect, kv, outbox, thread, ticket, trigger, trigger_thread` |
| `/state` 的 `masterId` | `orchestrator-537d5fa54b5827023316973d159a9d18` |
| 默认 executor 目录 | `G:\…\deploy\state\work`（`directory` 为空时的默认） |
| 默认策略 | 两条规则 `copy` / `visual`；`eval.mode=observe`；`maxWorkers=3`；`allowed` 为空 |

结论：**插件初始化 `[已实测通过]`；部署自检 `[已实测失败:spawn env ENOENT]`；端到端 `[未实测]`。**

---

## 5. 本轮踩到的脚本级 bug（已修）

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| `Error: Cannot find module 'G:\Agent-workspace\DSH'` 启动即死 | `Start-Process -ArgumentList @('--expose-internals', $boot, …)` 会**用空格拼接且不加引号**，含空格的 `DSH NEXT` 被拆断 | 传单个已加引号的字符串；`deploy/start.ps1` 已修 |
| 从工具后台作业里启动后服务随作业一起消失 | 后台作业结束时连带杀掉其子进程树 | 在真实终端 / 计划任务里跑 `start.ps1`，不要包在会退出的作业里 |

---

## 6. 现阶段结论

- 环境侧：只差 pnpm（已补）与 tmux（Windows 无原生版本）。
- 代码侧：两组 POSIX 硬依赖 —— `stateDir` 路径校验（可 2 行补丁绕过）与 setup 的 `env` 包装（**不可小补丁绕过**）。
- 因此原生 Windows 上 **A 方案止步于「插件已挂载、面板与 API 可用，但部署自检无法通过」**。
- 继续走 A 方案 → WSL2 / 容器（§5，均 `[未实测]`）。
- 不等价替代 → `local-superagent/`（B 方案）。
---

## 7. 敏感文件提示（清理前必读）

项目内 `DSH_HOME` 会自己长出凭据类文件，别当普通缓存删/传：

| 路径 | 内容 | 处理 |
| --- | --- | --- |
| `deploy/dsh-home/.credentials.yaml` | dsh 在该 home 下的凭据存储（本轮由 dsh 自行创建） | 不要提交、不要外发；清理时用 `Remove-Item -Recurse deploy\dsh-home` 连目录一起删 |
| `deploy/dsh-home/.anonymous-user-id` | 匿名实例 id | 同上 |
| `deploy/state.lock` | `proper-lockfile` 的锁（在 `<stateDir>.lock`，不在 stateDir 内） | 进程异常退出后可能残留；确认没有进程再用后删 |
| `deploy/state/orchestrator.sqlite*` | 工单/触发器/决策数据 | 可能含 Issue 正文与账号信息 |

另外本仓库根目录 `.gitignore` 未见忽略 `deploy/dsh-home`、`deploy/state`——**如果之后要 git 管理这个项目，先把这两条加进 `.gitignore`**（本轮按规定没有 commit）。
