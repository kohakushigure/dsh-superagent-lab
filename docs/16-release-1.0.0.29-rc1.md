# 16 真机发布：v1.0.0.29-rc.1 打包上线记录

> 对象：`kohakushigure/llm-patent-batch-generator` → Gitee `desktop-release-hub`
> 结论：**已构建、已签名、已发布为预发布（prerelease）**，自动检查不会推送它。

## 1. 一条命令的构建（他们的既有管线）

```
powershell -NoProfile -ExecutionPolicy Bypass -File build/release.ps1 -Version v1.0.0.29-rc1 -SkipTests
```

| 产物 | 值 |
| --- | --- |
| EXE | 17,582,306 B |
| EXE SHA-256 | `0920C47F34A6D628C3BD9DE6E6CC6BCF3C4124EBD4FE1670C745172DFD913FE1` |
| frozen E2E | 35/35 通过 |
| 证据 | `build/_evidence/release-v1.0.0.29-rc1.json` |

构建前做了一次版本 bump（`APP_VERSION` 1.0.0.27 → 1.0.0.29、`version_info.txt` 同步），
并**顺带修掉第 2 个同类漂移**：`backend/tests/unit/test_ota_core.py` 把 `1.0.0.27` 和 `filevers=(1, 0, 0, 27)` 写死，bump 后必然红。

## 2. 打包与签名

```
python build/ota_package.py --dist dist/PatentTool --out build/_ota_dist/pkg-1.0.0.29 \
  --version 1.0.0.29 --key <patenttool-release-2026.private.json>
```

- ZIP 73,986,384 B，1198 个文件，SHA-256 `1164c415…2794`
- `manifest.json` 用 Ed25519 私钥签名，`key_id=patenttool-release-2026`，`ota_publish.py verify` 通过

## 3. 发布到指定位置（Gitee）

```
python build/ota_upload.py --host gitee --dir build/_ota_dist/pkg-1.0.0.29 --tag v1.0.0.29-rc.1 --commit
```

- release：`https://gitee.com/kohakushigure/desktop-release-hub/releases/tag/v1.0.0.29-rc.1`（**prerelease=true**，id 1268539）
- 资产：ZIP / `manifest.json` / `SHA256SUMS.txt`
- 消费者视角复核：manifest 可匿名拉到（696 B，version=1.0.0.29），ZIP HEAD 200、长度 73,986,384

## 4. 踩到的三个坑（都会复现）

| # | 现象 | 根因 | 处理 |
| --- | --- | --- | --- |
| 1 | `ota_upload --commit` 报 `HTTP 400 验证失败，用户名或密码错误` | 该工具先自己创建 release，创建调用失败；但**同一个 token 直接调 API 能创建成功** | 先用 API 建 release（id 1268539），再跑 uploader，就正常了 |
| 2 | 清单里的 `package_url` 指向 `v1.0.0.29`，实际资产在 `v1.0.0.29-rc.1` → 下载 404 | `ota_package.py` 把 URL 固定写成 `/download/v<4段版本>/` | 用 `ota_publish.py payload --package-url …` 重新生成 payload 并重签 manifest，再覆盖上传 |
| 3 | `SHA256SUMS.txt` 覆盖不生效（一直显示 already_present） | uploader 按 name+size 判重 | 改内容长度（加一行注释）后 `--replace` 才真正替换 |

第 2 条是**上游真实缺口**：RC 想可安装，`package_url` 必须带 `-rc.M` tag。已在 #39 里建议给 `ota_package.py` 加 `--tag`。

## 5. 未做/需人工确认

- **没有**把它标成正式版（`prerelease` 保持 true，不晋升 `main`）。
- **没有**在真机上跑「客户端检查更新 → 下载 → 验签 → 安装 → 回滚」这条端到端链路；这一步需要一台装有旧版的机器。
- 构建用了 `-SkipTests`（测试已单独跑过：根级 255 passed、OTA 单测全绿）。
## 6. 正式版推送（v1.0.0.29，稳定通道）

用户要求「直接推 OTA」，于是走了第二次发布：

```
# 1) 重新按 4 段 tag 生成 payload 并签名（默认就是 v<version>）
python build/ota_publish.py payload --zip ... --version 1.0.0.29 --out payload.json
python build/ota_publish.py sign   --payload payload.json --key <private> --out manifest.json
# 2) 先用 API 建 release（uploader 自己建会 400），再上传
python build/ota_upload.py --host gitee --dir build/_ota_dist/pkg-1.0.0.29 --tag v1.0.0.29 --commit
```

| 复核项 | 结果 |
| --- | --- |
| `/releases/latest` | `v1.0.0.29`，prerelease=false |
| manifest | version=1.0.0.29，签名 key_id `patenttool-release-2026` |
| package_url | `…/download/v1.0.0.29/PatentTool_1.0.0.29_win-x64.zip` |
| ZIP HEAD | 200，73,986,384 B |
| 签名校验 | `verify --current-version 1.0.0.28` → ok |

含义：**1.0.0.28 的客户端下次检查更新即可看到 1.0.0.29 并安装**。
RC 那份（`v1.0.0.29-rc.1`，prerelease=true）保留作历史，自动检查不会推送它。

## 7. 仍需真机确认的一步

客户端侧的完整链路（检查→下载→验签→关窗替换→健康握手→失败回滚）我这边没有真机可跑。
服务器侧已用与客户端相同的匿名路径验证：latest 指向正确、manifest 可拉、签名可验、ZIP 可下载。
