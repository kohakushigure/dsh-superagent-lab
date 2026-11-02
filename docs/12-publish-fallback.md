# 12 发布通道与回退方案（当前阻塞点）

> 状态：**本机 `git push` / `gh api` 的写请求被 HTTP 代理卡住**，读请求正常。
> 本地已有 8 个提交未推送，最新 `15b69e9`；远端仍停在 `6ee2f64`。

## 1. 证据

| 动作 | 结果 |
| --- | --- |
| `git ls-remote`（经代理） | 1.1 s 返回（读正常） |
| `git ls-remote`（`-c http.proxy=` 直连） | 1.1 s 返回（读正常） |
| `git push`（经代理） | 握手后 401，随后挂起 |
| `git push`（`-c http.proxy=` 直连，URL 内嵌 token） | 挂起（>60 s，无输出） |
| `git push --dry-run`（直连） | 同样挂起 |
| `gh api -X PATCH`（仓库描述） | 挂起 |
| `gh api repos/...`（GET） | 正常 |

代理配置：`git config --get http.proxy` → **`127.0.0.1:7078`**。
凌晨 23:0x 时推送是通的（`240a380..6ee2f64` 由 CI 提交那次），之后写请求开始挂起，读请求一直正常。

## 2. 三种补推办法（任选其一）

### A. 你在自己的终端里推（最省事）

```powershell
cd G:\Agent-workspace\dsh-superagent
git -c http.proxy= push origin main      # 直连；GCM 会弹一次登录
```

### B. 用打好的 bundle（不需要本机 git 网络）

仓库里已经生成 `dist/dsh-superagent.bundle`（516 KB，包含完整历史，tip = `15b69e9`）：

```powershell
git clone dist\dsh-superagent.bundle C:\tmp\superagent-push
cd C:\tmp\superagent-push
git remote set-url origin https://github.com/kohakushigure/dsh-superagent-lab.git
git push origin main
```

### C. 走 GitHub Web 上传（最笨但一定能成）

把 `dist/dsh-superagent.bundle` 之外的关键文件（`docs/`、`local-superagent/`、`scripts/`）打包成 zip，在网页端上传提交。
不推荐，会把历史压平。

## 3. 补推之后会自动发生什么

`.github/workflows/ci.yml` 会在 ubuntu-latest / windows-latest 上跑：

- `node --test`（当前 32 例）
- `node bin/demo.mjs`（30 条断言）
- 一条 smoke：起服务 → 投递 → 断言工单 → 优雅停

## 4. 为什么不再继续尝试

连续三轮（goal round 1/2/3）同一阻塞点，已排除：凭据问题（URL 内嵌 token 同样挂）、代理问题（直连同样挂）、锁与残留进程（清理后重试同样挂）、仓库体积（bundle 仅 516 KB）。
剩下的可能都不在代码侧：本机出网策略/杀软对 git 的 receive-pack 做了拦截。

代码侧的活不受影响：本地提交、测试、CI 配置都在仓库里，补推即生效。
