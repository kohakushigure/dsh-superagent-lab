# 17 运维事故：开机自启静默失败（2026-11-04）

## 现象

机器 19:36 重启，计划任务 `local-superagent` 20:02 跑过一次，`LastTaskResult=1`，两个 loop（3082 / 3091）都没起来。
整整一天无人值守是空转的。

## 两个独立原因

### 1) 计划任务传了一个不存在的参数

任务动作是：

```
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass
  -File "...\start-all.ps1" -Port 3082 -Hidden
```

而 `start-all.ps1` 的 param 块里**没有 `-Hidden`** → 参数绑定失败 → 退出码 1，脚本一行都没执行。

修法：param 块加 `[switch]$Hidden`（无实际作用，只为不报绑定错误）。

### 2) Start-Process 被环境变量大小写重复打崩

把参数修好后手动跑，又报：

```
Start-Process : Item has already been added.
  Key in dictionary: 'NO_PROXY'  Key being added: 'no_proxy'
```

本机环境里同时存在 `NO_PROXY` 和 `no_proxy`，PS 5.1 的 `Start-Process` 在重建环境字典时炸掉。
`[System.Diagnostics.Process]::Start` 不重建字典，实测正常。

修法：新增 `scripts/hosting/spawn.ps1`，提供 `Start-LoopProcess`（ProcessStartInfo + `cmd /c` 重定向日志），
`start-all.ps1` 的三处启动（loop / selfcheck / watchdog）与 `loop-patent.ps1` 全部改用它。

## 验证

```
Start-ScheduledTask -TaskName local-superagent
Get-ScheduledTaskInfo  → LastTaskResult = 0
3082 llm=openai ；3091 llm=openai
node --test → 39/39
```

## 教训

- 计划任务的退出码要看，别只看到进程在跑就以为没事——这次是「进程根本没起」。
- `.ps1` 必须 UTF-8 **带 BOM**（PS 5.1 否则按 ANSI 读，中文注释会把后面几行吃掉）。我中途就是因为重写文件丢了 BOM，任务又变回 result=1。
- 环境变量大小写重复是 Windows 上的常见雷，任何 `Start-Process` 都可能踩。
