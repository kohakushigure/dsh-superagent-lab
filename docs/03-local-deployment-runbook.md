# 03 · 本地部署 runbook（Windows 11 实测）

> **[路径说明]** 本文引用的 `deploy/logs/`、`deploy/run/`、`deploy/backup/`、`deploy/state/`、`deploy/dsh-home/`、`deploy/upstream/` 全部是**本地产物，未随仓库分发**（已在 `.gitignore` 里）。每条命令都可原地复跑：上游克隆见 §3.1，profile 与 stateDir 见 §3.4–3.5，启动日志落在 `deploy/run/`（§3.6）。仓库里随代码分发的是脚本与配置模板本身：`deploy/start.ps1`、`deploy/stop.ps1`、`deploy/status.ps1`、`deploy/bin/dsh-local.cmd`、`deploy/profile.cordis.patch.yml`、`deploy/patches/`。
>
> 目标：把官方原型 `deepseek-ai/dsh-superagent-prototype` 在本机（Windows 11 26200 / dsh 0.2.1-rc.4）上部署到「可复现」的程度，并把走不通的地方写成可执行的替代路径。
>
> **标注约定**（全队统一，只用这三种）：
> - `[已实测通过]` — 本机真跑过，有输出为证
> - `[已实测失败:原因]` — 本机真跑过，失败，原因已定位
> - `[未实测]` — 没跑过，命令来自官方文档或推断，照抄前先自己验
>
> 涉及「设计 vs 原型」的地方另用三态标注：`【文章设计】` / `【原型已实现】` / `【两者有差距】`。
>
> 实测环境与全部原始输出：`deploy/env-report.md`、`deploy/logs/`。脚本：`deploy/start.ps1`、`deploy/stop.ps1`、`deploy/status.ps1`、`deploy/bin/dsh-local.cmd`。
>
> 上游仓库 Issues / Discussions / PR 已关闭（`has_issues=false`，据 qa-verifier 2026-11-02 核对）。**demo 里的「在 Issue 里 @ 机器人」必须用你自己的仓库或 fork，不能在上游仓库演示。**

---

> ## ⚠ [注意] 本仓库内 upstream checkout 已应用 2 行补丁，与上游 main 不一致
>
> - 状态：`deploy/upstream/dsh-superagent-prototype` 的 `src/deployment.ts` 与 `src/policy.ts` **各被改 1 行**（`git diff --stat` 真实输出见 §7.5，当前为 `2 files changed, 2 insertions(+), 2 deletions(-)`）。
> - 影响：这是**研究用旁路**，偏离上游、仅用于本机验证架构、升级即失效、不建议生产。任何「上游怎么写的」判断都以未打补丁的上游为准。
> - 还原：`git -C deploy/upstream/dsh-superagent-prototype checkout -- src/deployment.ts src/policy.ts` 然后 `pnpm build`（详见 §3.5）。
> - **本文引用行号一律以「未打补丁的上游」为准**；打了补丁后 `deployment.ts:13` / `policy.ts:94` 的字节内容与本仓库当前文件不同。
>
> ## ⚠ [注意] 凭据文件
>
> `deploy/dsh-home/.credentials.yaml` 是 dsh 在项目内 `DSH_HOME` 下自建的**本地凭据存储**，同目录还有 `.anonymous-user-id`。**勿外发、勿提交、勿贴进 issue/PR**。`deploy/state/orchestrator.sqlite*` 可能含 Issue 正文与账号信息。根 `.gitignore` 已由 lead 加入 `deploy/dsh-home`、`deploy/state`——deploy-runner 未改根目录任何文件。

---

## 1. 结论先行：原生 Windows 上 A 方案能到哪一步

| 步骤 | 状态 | 一句话 |
| --- | --- | --- |
| 拉取仓库 | `[已实测通过]` | `git clone --depth 1`，HEAD `6337fc8` |
| `pnpm install` | `[已实测通过]` | 234 个包，9.6 s，pnpm v11.7.0 |
| `pnpm build` | `[已实测通过]` | tsdown/rolldown，`lib/index.js` 450.26 kB |
| 创建 `superagent` profile | `[已实测通过]` | 但**参数位置必须改**，官方写法报 unknown option |
| 装 bundle（`dsh plugin add link:`） | `[已实测通过]` | 有 peerDependencies 未解析警告，不影响挂载 |
| 写 profile patch（`stateDir`） | `[已实测失败:stateDir 校验 /^\// 拒绝盘符路径]` | 见 §3.5，原生 Windows 的**第一道硬墙** |
| 启动（官方 `scripts/dsh-superagent start`） | `[已实测失败:python3 + import fcntl + 硬依赖 tmux]` | 该脚本在 Windows 上连 import 都过不去 |
| 启动（自写 `deploy/start.ps1`，且已打 2 行补丁并 rebuild） | `[已实测通过·仅到模块挂载]` | 面板端口起、`/orchestrator/api/state` 返回 200、插件建库成功 |
| 部署自检（setup） | `[已实测失败:spawn env ENOENT]` | 见 §3.8，原生 Windows 的**第二道硬墙**，无小补丁可绕 |
| 首个工单 → PR（端到端） | `[未实测]` | 需要 agent 专用 GitHub 账号；且被上面两道墙挡住 |

**一句话结论：A 方案在原生 Windows 上跑不通，卡点是两组 POSIX 硬依赖，不是环境没配好。**

- 硬墙 1（配置层）：`stateDir` 的 schema 是 `/^\//`，盘符路径被 schemastery 直接拒绝 → 可以打 2 行补丁绕过。
- 硬墙 2（执行层）：setup 探针一律用 `env PATH=… <cli> …` 起进程（`src/deployment.ts:75`），Windows 没有 `env` → `spawn env ENOENT`。**这一层没有小补丁可绕**，必须换运行时（WSL2 / 容器）。

> 注意别写成「原型不支持 Windows」。插件本体是有 Windows 分支的：`cordis.patch.yml:51-62 / 151-162` 显式 `disabled: !!js process.platform === 'win32'` 切到 `pwsh-sandbox` / `tool-pwsh`。不可用的只是「这个 POSIX 服务脚本」+「配置里的路径约束」+「setup 的 env 包装」。

---

## 2. 前置与版本实测表

实测机器：Windows 11 专业工作站版 10.0.26200，28 逻辑核。

| 组件 | 上游要求（006:23-27） | 本机实测 | 判定 |
| --- | --- | --- | --- |
| Node.js | 22.19+ 或 24+ | v24.19.0 | `[已实测通过]` |
| npm | 无明文要求 | 11.17.0 | — |
| pnpm | 需要 | **12.16.1**（本轮新装，`npm i -g pnpm`）；仓库内自管为 11.7.0；`dsh plugin` 里是 11.28.5 | `[已实测通过]`（详见 §3.2 版本三变） |
| git | 2.32+ | 2.47.1.windows.2 | `[已实测通过]` |
| Python | 3.8+ | 3.12.3 | `[已实测通过]` |
| GitHub CLI | 2.48+ | 2.103.3 | `[已实测通过]` |
| **tmux** | 需要 | **缺失**（`Get-Command tmux` 无结果） | `[已实测失败:未安装]` |
| dsh | `engines.dsh: ^0.2.1-alpha.2` | 0.2.1-rc.4（`C:\Users\<u>\.dsh\bin\dsh.cmd`） | `[已实测通过]` semver 满足 |
| corepack | — | 0.35.0 可用，但 `corepack enable pnpm` 失败 | `[已实测失败:EPERM 需管理员]`；替代路径 `npm i -g pnpm` → `[已实测通过]` |
| Docker | 只在容器方案需要 | 27.5.1 | — |
| WSL | 只在 WSL2 方案需要 | WSL 2.4.11.0 + Ubuntu(Stopped) + docker-desktop | `[未实测]`（未在其中跑过原型） |

**本机缺口只有两个：pnpm（已补）、tmux（Windows 上无官方发行版）。**

---

## 3. A 方案：跑通官方原型

下面的命令块全部是 PowerShell 5.1 / 7 语法。工作根目录 `G:\Agent-workspace\dsh-superagent`。

### 3.0 先决：项目内重定向 DSH_HOME（**必做**）

这是本 runbook 与官方文档最大的差别。原因：`%USERPROFILE%\.dsh\bin\dsh.cmd` 第 5 行是

```bat
set "DSH_HOME=%USERPROFILE%\.dsh"
```

**硬编码**，父进程设的 `DSH_HOME` 会被它覆盖。所以直接用 PATH 上的 `dsh` 永远落在 `~/.dsh`。

`[已实测失败:dsh.cmd 硬编码覆盖 DSH_HOME]` —— 设 `$env:DSH_HOME=…\deploy\dsh-home` 后跑 `dsh --profile web --dump-config`，配置仍写到 `~/.dsh\profiles`，`deploy\dsh-home` 保持空。

`[已实测通过:绕过 shim，直接调用 DSH 可执行文件时 DSH_HOME 生效]`

```powershell
# 一次性：看清 shim 真正指向哪个可执行文件
Select-String -Path "$env:USERPROFILE\.dsh\bin\dsh.cmd" -Pattern 'DSH_DESKTOP_APP_EXECUTABLE'
# 预期：set "DSH_DESKTOP_APP_EXECUTABLE=G:\Agent-workspace\DSH NEXT\DSH NEXT.exe"

# 项目内 wrapper（本项目已提供，等价于 dsh.cmd 但 DSH_HOME 指向项目）
& .\deploy\bin\dsh-local.cmd --version
# 预期：0.2.1-rc.4   [已实测通过]
```

下文所有 `dsh …` 命令，**原生 Windows 上一律用 `& .\deploy\bin\dsh-local.cmd …` 代替**，否则会写 `~/.dsh`。在 WSL2/Linux 上不需要这层，直接 `dsh`。

### 3.1 拉取仓库

```powershell
Set-Location G:\Agent-workspace\dsh-superagent
New-Item -ItemType Directory -Force deploy\upstream | Out-Null
git clone --depth 1 https://github.com/deepseek-ai/dsh-superagent-prototype deploy\upstream\dsh-superagent-prototype
git -C deploy\upstream\dsh-superagent-prototype log -1 --format='%H %cI %s'
```

预期：`6337fc823ce20251c8de8085948165c81aaa701e 2026-10-31T20:05:39+08:00 feat: add the dsh-superagent research prototype`　`[已实测通过]`

失败处置：设 `$env:GIT_TERMINAL_PROMPT='0'` 避免卡凭据；公司网走代理先配 `git config --global http.proxy`。只看到「Cloning into …」并带 `NativeCommandError`，是 PowerShell 把 git 的 stderr 当错误流，**不代表失败**，看 `$LASTEXITCODE` 是否为 0。

### 3.2 补 pnpm（两种办法，按顺序试）

```powershell
# 办法 1：corepack（需要写 C:\Program Files\nodejs，普通用户会失败）
corepack enable pnpm
# 预期失败：Internal Error: EPERM: operation not permitted, open 'C:\Program Files\nodejs\pnpx'
#           [已实测失败:非管理员无权限写 Node 安装目录]
# exit=1

# 办法 2：npm 全局装（落在用户可写的 %APPDATA%\npm）
npm config get prefix           # 预期 C:\Users\<u>\AppData\Roaming\npm
npm i -g pnpm
pnpm --version                  # 预期 12.16.1   [已实测通过]
```

⚠️ **版本三变现象**（本机实测，别被吓到）：

| 位置 | `pnpm --version` | 原因 |
| --- | --- | --- |
| 任意目录 | 12.16.1 | 刚装上的全局版 |
| 原型仓库内 | 11.7.0 | pnpm 自管版本，读 `package.json` 的 `"packageManager": "pnpm@11.7.0"` |
| `dsh plugin` 内部 | 11.28.5 | dsh 转发 pnpm 时用 profile 目录上下文 |

`[已实测通过:三个版本都能正常装依赖]`。安装时会看到 `npm warn allow-scripts pnpm@12.16.1 (preinstall/postinstall)`，是 npm 11 的脚本白名单提示，**不影响使用**（`pnpm --version` 正常即证明）。要消掉它：`npm i -g --allow-scripts=pnpm pnpm`。

### 3.3 装依赖 + 构建

```powershell
Push-Location deploy\upstream\dsh-superagent-prototype
pnpm install --reporter=append-only 2>&1 | Tee-Object ..\..\logs\pnpm-install.log
pnpm build                          2>&1 | Tee-Object ..\..\logs\pnpm-build.log
Pop-Location
```

预期（`[已实测通过]`）：

```text
Packages: +234
... Done in 9.6s using pnpm v11.7.0        # install, exit 0

ℹ tsdown v0.22.14 powered by rolldown v1.2.7
ℹ [CJS] lib\client.js  359.28 kB │ gzip: 86.67 kB
ℹ [ESM] lib\index.js   450.26 kB │ gzip: 127.47 kB
ℹ [ESM] 11 files, total: 693.50 kB
✔ Build complete in 1476ms                 # build, exit 0
```

产物：`lib\index.js`、`lib\client.js`、`lib\github-watch.js`、`lib\feishu-watch.js` 与对应 `.d.ts`。

失败处置：
- `ERR_PNPM_NO_MATCHING_VERSION … @deepseek-ai/dsh-*` → 私有 registry 或镜像缺包，`npm config get registry` 换回 `https://registry.npmjs.org/`。
- `ERR_PNPM_UNSUPPORTED_ENGINE` → Node 版本不在 `^22.19.0 || >=24`。
- 硬链接警告 `The store at C:\Users\…\pnpm\store\v11 is not used because packages cannot be hard linked` → 跨盘（C: 与 G:）导致，pnpm 自动换到 `G:\.pnpm-store`，**可忽略**（本机实测出现过，install 仍 exit 0）。

### 3.4 创建 profile（官方命令有坑，必须改参数位置）

**三种形态实测对照**：

| 形态 | 命令 | 结果 |
| --- | --- | --- |
| ✗ 官方原样（006:79） | `dsh superagent --from-default-profile web --dump-config` | `error: unknown option '--from-default-profile'`，exit 1　`[已实测失败:参数位置]` |
| ✓ 可用 | `dsh --profile superagent --from-default-profile web --dump-config` | exit 0，打印 1232 行配置树，并创建 profile　`[已实测通过]` |
| ✗ 危险 | `dsh --from-default-profile web`（不给 profile 名） | 它去**替换默认 profile `desktop`**：`EBUSY: … rename 'C:\Users\lhz\.dsh\profiles\desktop' -> '…\.desktop.staging-…\previous'`　`[已实测失败:默认落到 desktop 且试图替换]` |
| ✗ | `dsh --profile web --from-default-profile web` | template 不能落到同名 shipped profile（据 qa-verifier 实测） |

> **为什么**：`dsh` 的解析是 `dsh [--profile] <name> [options] [app-args...]`（`dsh --help` 首行）。`<name>` 之后的参数被当作**应用参数**转发，启动器标志因此失效。标志本身存在，不是「被移除」。

> **为什么这条命令危险**：它会把目标 profile 整个替换掉并删除其 `cordis.patch.yml`（006:87）。本机正是靠 desktop 应用占着文件、`EBUSY` 失败，才没被毁。**永远给 `--profile <名字>`，且名字不要写 `desktop` / `web`。**

正确命令（原生 Windows）：

```powershell
& .\deploy\bin\dsh-local.cmd --profile superagent --from-default-profile web --dump-config |
  Set-Content -Encoding utf8 deploy\logs\dump-config.txt
$LASTEXITCODE                       # 预期 0   [已实测通过]
Get-ChildItem deploy\dsh-home\profiles\superagent
# 预期：cordis.patch.yml  cordis.yml  package.json  pnpm-workspace.yaml
```

### 3.5 装 bundle 并写 profile patch

```powershell
# 装 bundle（link: 指向上游 checkout）
& .\deploy\bin\dsh-local.cmd plugin --profile superagent add "link:G:/Agent-workspace/dsh-superagent/deploy/upstream/dsh-superagent-prototype"
$LASTEXITCODE                       # 预期 0   [已实测通过]
Get-Content deploy\dsh-home\profiles\superagent\package.json -Raw
```

预期：`dependencies` 多出 `"dsh-superagent": "link:…"`，`dsh.profile.bundles` 末尾多出 `"dsh-superagent"`。同时会打印一大段 **peerDependencies 未解析警告**（`The linked in dependency will not resolve the peer dependencies from the target node_modules`）——`link:` 协议的正常行为，实测不影响后续挂载。想消掉可改用 `file:`。

```powershell
# 写机器配置（stateDir）
Copy-Item deploy\profile.cordis.patch.yml deploy\dsh-home\profiles\superagent\cordis.patch.yml -Force
```

**这一步是原生 Windows 的第一道硬墙。**

`[已实测失败:stateDir 必须是 POSIX 绝对路径]`

```text
dsh: warning: 2 entries did not activate
dsh-superagent (dsh-superagent): ValidationError: invalid config:
  - $.stateDir expect string to match regexp /^\// (at stateDir)
```

没打补丁时 `deploy\state` 保持空，`/orchestrator/api/state` 返回 **404**，面板上没有 Superagent 条目。

失败处置两条：
1. **换运行时**（推荐）：WSL2 / Linux，`stateDir: '/home/me/.dsh/state/superagent'` 直接可过。
2. **打本仓库提供的 2 行补丁**（仅限本机自测，不要当成官方支持）：

   ```powershell
   git -C deploy\upstream\dsh-superagent-prototype apply deploy\patches\windows-absolute-path.patch
   Push-Location deploy\upstream\dsh-superagent-prototype; pnpm build; Pop-Location
   ```

   补丁内容：`src/deployment.ts:13` 的 `/^\//` → `/^(\/|[A-Za-z]:[\\/])/`，以及 `src/policy.ts:94` executor `directory` 的同类判断。打完这一条，插件能挂载（见 §3.6）。**本项目 checkout 当前已应用该补丁**，还原：`git checkout -- src/deployment.ts src/policy.ts` 后 `pnpm build`。

   ⚠ **分级：这是「研究用旁路」，不是推荐路径。** 它 **偏离上游**、**仅用于本机验证架构**、**升级即失效**（`git pull` 会冲突或被覆盖）、**不建议生产**。它唯一的用处是证明「原生 Windows 上插件本体能挂载、管理面能起来、能建库」——即卡点是工程缺陷，不是配置错误。真要跑，走 §5 的 WSL2。

### 3.6 启动

**官方脚本在 Windows 上不可用。**

`[已实测失败:python3 + import fcntl + tmux]`

`scripts/dsh-superagent` 是 `#!/usr/bin/env python3`，第 10 行 `import fcntl`，第 166-167 行没有 tmux 就 `raise RuntimeError('Both dsh and tmux must be on PATH.')`，第 229 行 `fcntl.flock`。Windows 上 `import fcntl` 直接 `ModuleNotFoundError`，`tmux` 也不存在。**没有绕法**（除非装 MSYS2/Cygwin 的 fcntl 兼容层，不值得）。

改用本项目提供的三个 PowerShell 脚本（复刻官方脚本语义：状态查询、健康判定、退出码 0/1/2/3）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\status.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\stop.ps1
```

打了 §3.5 补丁后，`start.ps1` 的真实输出（`[已实测通过]`）：

```text
launcher : G:\Agent-workspace\DSH NEXT\DSH NEXT.exe
DSH_HOME : G:\Agent-workspace\dsh-superagent\deploy\dsh-home
started  : PID 13212
--- panel ---
dsh web: http://127.0.0.1:3082/?token=<token>
--- state ---
health.runtime = paused (Waiting for the deployment check)
SETUP   github/repositoryUnset: The GitHub Source names no repository.
load    running=0 queued=0 maxWorkers=3 paused=False
exit=3
```

`exit=3` 就是官方语义里的「服务在跑，但在等 setup」。**不是失败，是它还没被告知要给哪个仓库干活。**

### 3.7 面板

```powershell
# 面板 URL 在启动日志第一行，带一次性 token
Get-Content (Get-ChildItem deploy\run\dsh-superagent-superagent-*.out.log |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName -TotalCount 1
```

`[已实测通过:端口监听 + 根路径要求 token]`：直接请求 `http://127.0.0.1:3082/` 返回 **401**（必须带 `?token=…`）；`/orchestrator/api/state` 带 `x-orchestrator-request: 1` 返回 **200** 和完整 JSON。

侧边栏出现 **Superagent** 条目即表示 bundle 已挂载。**面板的人工点击走查 `[未实测]`**（只验到 HTTP 层，没在浏览器里点）。

### 3.8 首个工单（到这里就断了）

`[已实测失败:setup 探针依赖 POSIX env]`

设 GitHub Source 的两条实测失败，正好说明硬墙 2：

```powershell
$api='http://127.0.0.1:3082/orchestrator/api'; $h=@{'x-orchestrator-request'='1'}
$rev = ((Invoke-WebRequest $api/settings -Headers $h -UseBasicParsing).Content | ConvertFrom-Json).sources |
  Where-Object id -eq 'github' | Select-Object -ExpandProperty revision
$body = @{ value=@{ enabled=$true; config=@{ repository='you/your-repo'; cli='gh' } }; revision=$rev } | ConvertTo-Json -Depth 6
try { Invoke-WebRequest "$api/settings/source:github" -Method Put -Headers $h -ContentType application/json -Body $body -UseBasicParsing } catch { $_.ErrorDetails.Message }
```

- 传 `cli='gh'` → **400** `agentCliMissing`：`The agent GitHub CLI was not found. / gh is not an executable file on PATH`
  原因：`src/deployment.ts:61-65` 用 `statSync().isFile()` + `accessSync(X_OK)` 找候选名，**不按 PATHEXT 补 `.exe`**。Windows 上 `gh` 实际是 `gh.exe`。
- 传 `cli='C:\Program Files\GitHub CLI\gh.exe'` → 找到文件了，但 **400** `agentCliSignedOut`：`The agent GitHub CLI cannot read its account. / spawn env ENOENT`
  原因：`src/deployment.ts:75` 里是 `runAsWorker(subprocess, ['env', 'PATH=…', ...argv], …)`。**每条 setup 探针都通过 `env` 起进程**，Windows 没有 `env`。这是本轮唯一一条没有小补丁可绕的阻断。

所以：**首个工单 / PR 端到端 `[未实测]`**，且在原生 Windows 上按现有代码看是走不到的。要继续必须换运行时（§5）。

另外 `[已实测通过]` 的 API：`POST /orchestrator/api/executor/pause` → `{"paused":true}` / `{"paused":false}`，可用于临时停摆。

---

## 4. 排错表（全部是本轮真踩过的）

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| `error: unknown option '--from-default-profile'` | 标志被当成 app 参数转发，`<name>` 之后的位置不算启动器参数 | 改成 `dsh --profile superagent --from-default-profile web …` |
| `EBUSY: … rename '…\.dsh\profiles\desktop' -> '…\.desktop.staging-…\previous'` | 没给 profile 名，`--from-default-profile` 落到了默认 `desktop`，试图**替换**它 | 永远显式 `--profile <名字>`；别用 `desktop`/`web` 当目标 |
| 设了 `$env:DSH_HOME` 却仍写 `~/.dsh` | `dsh.cmd` 第 5 行硬编码 | 用 `deploy\bin\dsh-local.cmd` 或直接调 `DSH NEXT.exe` |
| `dsh-superagent: ValidationError … $.stateDir expect string to match regexp /^\//` | `stateDir` schema 是 POSIX 绝对路径 | 见 §3.5：换 WSL2，或打 `windows-absolute-path.patch` |
| `The agent GitHub CLI was not found. / gh is not an executable file on PATH` | 找可执行文件时不补 `.exe` | 给**绝对路径** `C:\Program Files\GitHub CLI\gh.exe`（本机实测会前进到下一个错误） |
| `The agent GitHub CLI cannot read its account. / spawn env ENOENT` | setup 用 `env` 包装进程，Windows 无 `env` | 无小补丁；换运行时 |
| `Error: Cannot find module 'G:\Agent-workspace\DSH'`（启动即死） | `Start-Process -ArgumentList` 用空格拼接**且不加引号**，含空格的路径被拆断（`DSH NEXT`） | 传单个已加引号的参数字符串；`deploy/start.ps1` 已修 |
| `Both dsh and tmux must be on PATH.` | 官方脚本硬依赖 tmux | Windows 上用 `deploy/start.ps1` |
| `ModuleNotFoundError: No module named 'fcntl'` | 官方脚本 `import fcntl` | 同上 |
| `status` 退出 3 | 服务在跑，等 setup | 看 `setup.problem.place/code`，去面板补配置 |
| `status` 退出 1 | 没跑 / 跑了两份 / 不响应 / runtime 报错 | 看最新 `deploy\run\*.err.log` |
| 面板根路径 **401** | 少了 `?token=…` | 从日志第一行取完整 URL |
| `/orchestrator/api/state` **404** | 插件没挂载（本机 = stateDir 校验失败） | 回到 §3.5，看 `.err.log` 里那条 ValidationError |
| `EADDRINUSE` 或 3082 被占 | 上一份没退干净 | `deploy\stop.ps1`；必要时 `Get-NetTCPConnection -LocalPort 3082 -State Listen` 找 PID 后 `Stop-Process` |
| `ERR_PNPM_UNSUPPORTED_ENGINE` | Node 不在 `^22.19 || >=24` | 切 Node |

---

## 5. 出路：推荐 → 备选 → 研究旁路 → 放弃 A

四个方案**按推荐度排序**，不要跳级选。

### 5.1 【推荐】WSL2（Ubuntu）— 官方支持面内

tmux / fcntl / POSIX 绝对路径三条约束天然满足，是唯一不需要改上游代码就能走完的路。

```powershell
wsl -d Ubuntu -- bash -lc "cd ~ && sudo apt-get install -y tmux python3 && curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs && sudo npm i -g pnpm && git clone --depth 1 https://github.com/deepseek-ai/dsh-superagent-prototype && cd dsh-superagent-prototype && pnpm i && pnpm build"
```

然后在 **WSL 内**照 006:71-131 走：`npm install -g @deepseek-ai/dsh@0.2.1-rc.3` → `dsh --profile superagent --from-default-profile web --dump-config` → `dsh plugin --profile superagent add "link:$PWD"` → 复制 `profile.cordis.patch.yml`（`stateDir: '/home/<u>/.dsh/state/superagent'`）→ `./scripts/dsh-superagent start`（**这里官方脚本能直接跑**）。

代价：WSL 里要重装 node+pnpm+gh+python；Windows 侧 `gh` 登录态不共享，要在 WSL 里重新 `gh auth login`；跑在 `/mnt/g` 会慢，建议 clone 到 WSL 家目录；面板 3082 需在 WSL 内监听（WSL2 的 localhost 转发默认可用）。

`[未实测]`（本机 Ubuntu 处于 Stopped，本轮未在其中执行）。

### 5.2 【备选】Docker 容器 — 也属于官方支持面，但上游没给镜像

```powershell
docker build -t dsa .          # 需自写 Dockerfile：node:24 + tmux + python3 + pnpm + gh
docker run --rm -p 3082:3082 -v "%CD%/state:/state" dsa
```

代价：Dockerfile 要自己写；`dsh` 与模型凭据要挂进去；`stateDir` 必须是容器内 POSIX 路径并挂到宿主卷。`[未实测]`（上游无现成镜像）。

### 5.3 【研究旁路】2 行补丁让原生 Windows 能挂载 — 偏离上游

见 §3.5 与 §7.5。**定位：偏离上游、仅用于本机验证架构、升级即失效、不建议生产。**

它能给你的：证明插件本体在 Windows 上能挂载、管理面 API 能起来、能建 SQLite 库（`[已实测通过]`）。
它给不了你的：部署自检。setup 探针经 `env` 包装（`src/deployment.ts:75`），Windows 无 `env` → `spawn env ENOENT`（`[已实测失败]`）。**所以这条路走不到首个工单，只能到「面板 + API + 建库」。**

### 5.4 【放弃 A】B 方案：自建 `local-superagent/`

不依赖 dsh、不依赖 POSIX，原生 Windows 直接跑。能力是复刻不是等价：GitHub Source / 面板 / 预设体系都要自己实现，不承诺与原型行为一致。

判据：**只要能接受「机制等价、实现不同」，就选这条。** 见 `local-superagent/README`、`docs/04-local-implementation.md`、`docs/05-validation-report.md`。

### 5.5 一句话选型

| 你的目的 | 选哪个 |
| --- | --- |
| 研究官方原型本身的行为 | 5.1 WSL2 |
| 已有容器化流水线 | 5.2 Docker |
| 只想在本机确认「卡点是工程缺陷而非配置错误」 | 5.3 补丁旁路（只看不动） |
| 要一个自己机器上长期能用的 Super-agent | 5.4 B 方案 |

---

## 6. 回滚与清理

```powershell
# 1) 停服务
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\stop.ps1

# 2) 还原上游 checkout（若打过补丁）
git -C deploy\upstream\dsh-superagent-prototype checkout -- src/deployment.ts src/policy.ts
Push-Location deploy\upstream\dsh-superagent-prototype; pnpm build; Pop-Location

# 3) 删项目内 profile 与 state（数据库、worker 目录都在 state 下）
Remove-Item -Recurse -Force deploy\dsh-home, deploy\state

# 4) 确认没碰用户的 ~/.dsh
(Get-ChildItem -Force "$env:USERPROFILE\.dsh\profiles" | Select-Object -ExpandProperty Name | Sort-Object) -join ','
# 预期回到 desktop,node_modules,web
```

**关于 `~/.dsh` 的实情（必须写清）**：本轮早期用 PATH 上的 `dsh` 跑 `--profile superagent --from-default-profile web --dump-config` 时，因为 `dsh.cmd` 硬编码，**在 `~/.dsh\profiles\superagent` 建了一份新的 web 模板副本**。它此前**不存在**（`Test-Path` 已确认 `False`），所以没有覆盖任何用户配置。备份留在 `deploy/backup/dsh-profiles-superagent/`。要恢复原状：`Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\superagent"`。**风险点：任何 `dsh --from-default-profile` 都会替换目标 profile 并删除其 `cordis.patch.yml`（006:87），先备份再执行。**

`deploy/` 里哪些是临时产物、可以删：

| 路径 | 性质 | 能删吗 |
| --- | --- | --- |
| `deploy/upstream/` | 上游 checkout + 依赖 + 构建产物（体积最大） | 能，重 clone 即可 |
| `deploy/dsh-home/` | 项目内 DSH_HOME（含 `profiles/superagent`、`node_modules`） | 能，但要重跑 §3.4-3.5 |
| `deploy/state/` | 运行时 SQLite + WAL | 能，**会丢工单历史** |
| `deploy/run/*.log`、`*.pid` | 启动日志与 pid | 能 |
| `deploy/logs/` | 本轮实测原始输出（证据） | 建议留，文档引用它 |
| `deploy/backup/` | `~/.dsh\profiles\superagent` 的备份 | 确认不需要后能删 |
| `deploy/bin/dsh-local.cmd`、`*.ps1`、`profile.cordis.patch.yml`、`patches/` | 交付物 | **别删** |

---

## 7. 附录

### 7.1 `deploy/*.ps1` 用法

```text
deploy\start.ps1  [-Profile superagent] [-Port 3082] [-DshHome <dir>] [-DshExe <DSH NEXT.exe>] [-TimeoutSec 120]
deploy\status.ps1 [-Profile superagent] [-Port 3082]
deploy\stop.ps1   [-Profile superagent] [-Port 3082] [-TimeoutSec 30]
```

- `start.ps1` 幂等：已在跑就不会再起第二份；端口上已有服务会拒绝启动。日志写在 `deploy/run/dsh-superagent-<profile>-<时间戳>.{out,err}.log`。
- `stop.ps1` **是强制终止**（TerminateProcess）。Windows 没有可移植办法给分离的控制台进程投递 SIGINT，所以跑着的 Executor Session 会丢当前一步；工单留在 SQLite 里，下次 `start` 继续。本机实测：强杀后重启正常，`orchestrator.sqlite` + WAL 可恢复。
- `status.ps1` 输出一行 JSON（pids/profile/url）+ 健康树 + setup + load。

### 7.2 退出码（与 006:113-120 一致）

| 码 | 含义 | 处理 |
| --- | --- | --- |
| 0 | 正常 | 无需动作 |
| 1 | 没跑 / 跑了两份 / 不响应 / runtime 报错 | 重启可能修好；看 `.err.log` |
| 2 | 在跑，但某个非 runtime 部件报错（Source、`sync:*`） | 重启修不好，要人处理 |
| 3 | 在跑，等 setup | 去面板补配置；重启修不好 |

### 7.3 两个直答

**Q1：3082 面板到底起没起过？**
**起过，而且是被我主动停掉的，不是自己退出的。**判断依据三条：
1. `deploy/run/superagent-20261102-184514.out.log` 打印了 `dsh web: http://127.0.0.1:3082/?token=…`（端口已绑定才会打印）；
2. 紧接着请求 `/orchestrator/api/state` 拿到 **HTTP 200** 与完整 JSON，其中 `health.*.at` 是 `2026-11-02T10:47:36Z`（UTC）= 本地 18:47:36，说明进程当时活着；
3. 随后停止探测打印 `matching procs: 27028` → `killed 27028` → `port 3082 free`。

现在端口不监听，是因为之后没人再起；另一次 `start.ps1` 尝试因含空格路径被拆断而 `MODULE_NOT_FOUND` 秒退（该 bug 已修）。日志 0 字节的那份是**修好前**的失败启动，不是全部证据。

**Q2：`orchestrator.sqlite` + 177 KB WAL 说明插件初始化成功了吗？**
**是，插件真的初始化了，不是 dsh web 侧建的空库。**判断依据：
1. `stateDir` 是 **dsh-superagent 独有**的配置项，dsh web 本身不读它；
2. 只读打开该库，表是插件自己的数据模型：`decision, disposition, effect, kv, outbox, thread, ticket, trigger, trigger_thread`——这是 trigger/ticket 编排模型，不属于 dsh web；
3. `/state` 返回 `masterId = orchestrator-537d5fa5…`，以及 `relay/notice/launch/delivery/assessment/reply/evals/github` 这些插件注册的健康项；
4. 时机对得上：库是在**打过 `stateDir` 补丁、`pnpm build` 之后**那次启动里出现的。

准确表述：**「模块挂载 + 插件初始化 + 管理面 API」`[已实测通过]`，「部署自检 setup」`[已实测失败:spawn env ENOENT]`，整体启动链路仍算未跑通。**

### 7.4 仍未实测的清单（不要当成已完成）

- WSL2 / Ubuntu 内的完整走通（本机 Ubuntu 处于 Stopped）。
- Docker 镜像方案（上游无 Dockerfile）。
- agent 专用 GitHub 账号 → 部署自检通过 → 面板里配 Source / Policy / Executor / Prompts。
- 首个工单（Issue 里 `@<agent> <请求>`）→ Worker 执行 → PR 交付 → 订阅直通。
- 面板 UI 的人工点击走查。
- `pnpm typecheck` / `pnpm test`（`pnpm check` 的后两步）未跑。
- 官方「每小时巡检」的 schedule（006:133-141），脚本依赖 POSIX，Windows 上要用 `deploy/status.ps1` 另写计划任务。

### 7.5 upstream 补丁的真实 diff（`git diff --stat` 原始输出）

```text
$ git -C deploy/upstream/dsh-superagent-prototype diff --stat
 src/deployment.ts | 2 +-
 src/policy.ts     | 2 +-
 2 files changed, 2 insertions(+), 2 deletions(-)

$ git -C deploy/upstream/dsh-superagent-prototype status --short -- src
 M src/deployment.ts
 M src/policy.ts
```

补丁全文见 `deploy/patches/windows-absolute-path.patch`，内容只有两处：

```diff
-const absolute = (description: string) => s.string().pattern(/^\//).description(...)
+const absolute = (description: string) => s.string().pattern(/^(\/|[A-Za-z]:[\\/])/).description(...)

-  directory: z.string().trim().refine(path => path === '' || path.startsWith('/'), ...)
+  directory: z.string().trim().refine(path => path === '' || /^(\/|[A-Za-z]:[\\/])/.test(path), ...)
```

⚠ 再次强调：这是**研究旁路**。还原后 `pnpm build` 一次即可回到与上游一致的行为（此时原生 Windows 会重新出现 `stateDir` ValidationError，属预期）。


### 7.6 安全与授权要点（部署前必须读）

- **Router / Worker 两个预设都以 `danger-full-access` 跑在操作者的 OS 用户下**（006:19）。Worker 能按路径执行任意程序、能读操作者家目录。要隔离就用**独立 OS 账号**，只放 agent 自己的凭据。
- Source 的 CLI 字段必须是 agent 账号的 wrapper，**不要用你自己的账号**；agent 写的一切都以那个名字出现。
- 白名单从**最窄**开始：Policy 的 `allowed` 先只放你自己一个 login；名单为空时任何请求都成不了工单。
- `accept` 默认 `observe`（只记录、不执行）。**先 observe 观察几轮再放宽**。
- **不要让 agent 自动合并**（`auto-merge` 默认 No）。人工合并，直到它的 PR 连续一段时间都对。
- 只支持 `github.com` 上的仓库，**不支持 GHES**（006:25）。
