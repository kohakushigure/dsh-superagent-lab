<#
  start-all.ps1 - 一条命令拉起整套托管：常驻 loop + 自检巡检 + 进程外看门狗。
  幂等：已经在跑的不会重复起；-Status 看状态；-Stop 全停。
#>
[CmdletBinding()]
param(
  [int]$Port = 3082,
  [int]$Cap = 2,
  [int]$SelfcheckSeconds = 300,
  [string]$ProjectRoot = "",
  [switch]$Status,
  [switch]$Stop,
  # the scheduled task passes -Hidden; accept it so parameter binding cannot fail
  [switch]$Hidden
)
$ErrorActionPreference = "Stop"
$root = if ($ProjectRoot) { $ProjectRoot } else { Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$sa = Join-Path $root "local-superagent"
$out = Join-Path $sa "evidence\hosting"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$pidFile = Join-Path $out "pids.json"
. (Join-Path $PSScriptRoot "spawn.ps1")

function Get-NodeProc([string]$pattern) {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } |
    Select-Object ProcessId, CommandLine
}
function Get-LoopPid() {
  $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.OwningProcess }
  return $null
}

if ($Status) {
  $loop = Get-LoopPid
  "[loop      ] " + $(if ($loop) { "pid=$loop  http://127.0.0.1:$Port" } else { "not running" })
  $sc = Get-NodeProc "selfcheck\.mjs"
  "[selfcheck ] " + $(if ($sc) { "pid=" + (($sc | ForEach-Object { $_.ProcessId }) -join ",") } else { "not running" })
  $wd = Get-NodeProc "watchdog-ext\.mjs"
  "[watchdog  ] " + $(if ($wd) { "pid=" + (($wd | ForEach-Object { $_.ProcessId }) -join ",") } else { "not running" })
  if (Test-Path $pidFile) { "[pidfile   ] " + (Get-Content $pidFile -Raw) }
  return
}

if ($Stop) {
  & node (Join-Path $sa "bin\superagent.mjs") stop --port $Port 2>&1 | Out-Null
  Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Get-NodeProc "selfcheck\.mjs" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-NodeProc "watchdog-ext\.mjs" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
  "stopped: loop + selfcheck + watchdog"
  return
}

# 0) 可选：加载 local-superagent/.env.local（KEY=VALUE 每行一条，已 gitignore）
$envFile = Join-Path $sa ".env.local"
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match "^\s*#" -or $line -notmatch "=") { continue }
    $k, $v = $line.Split("=", 2)
    [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim())
  }
  "env      : loaded " + $envFile
}

# 1) loop
$loop = Get-LoopPid
if (-not $loop) {
  if (-not $env:PROJECTS) { $env:PROJECTS = "self/=" + $root }
  if (-not $env:MAX_CONCURRENCY) { $env:MAX_CONCURRENCY = "$Cap" }
  $sp = @{ FilePath = "node"; ArgumentList = @("bin/superagent.mjs","start","--port","$Port"); WorkingDirectory = $sa; WindowStyle = "Hidden"; PassThru = $true;
           RedirectStandardOutput = (Join-Path $out "loop.out.log"); RedirectStandardError = (Join-Path $out "loop.err.log") }
  $p = Start-LoopProcess -NodeArgs ("bin/superagent.mjs start --port " + $Port) -WorkDir $sa -OutLog (Join-Path $out "loop.out.log") -ErrLog (Join-Path $out "loop.err.log")
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 250; try { $null = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2; break } catch {} }
  $loop = Get-LoopPid
  "loop     : started pid=$loop"
} else { "loop     : already running pid=$loop" }

# 2) selfcheck watcher
$sc = Get-NodeProc "selfcheck\.mjs"
if (-not $sc) {
  $sp2 = @{ FilePath = "node"; ArgumentList = @("scripts\hosting\selfcheck.mjs","--port","$Port","--interval","$SelfcheckSeconds"); WorkingDirectory = $root; WindowStyle = "Hidden"; PassThru = $true;
            RedirectStandardOutput = (Join-Path $out "selfcheck.out.log"); RedirectStandardError = (Join-Path $out "selfcheck.err.log") }
  $p2 = Start-LoopProcess -NodeArgs ("scripts\hosting\selfcheck.mjs --port " + $Port + " --interval " + $SelfcheckSeconds) -WorkDir $root -OutLog (Join-Path $out "selfcheck.out.log") -ErrLog (Join-Path $out "selfcheck.err.log")
  "selfcheck: started pid=$($p2.Id) every ${SelfcheckSeconds}s"
} else { "selfcheck: already running pid=" + (($sc | ForEach-Object { $_.ProcessId }) -join ",") }

# 3) external watchdog
$wd = Get-NodeProc "watchdog-ext\.mjs"
if (-not $wd) {
  $sp3 = @{ FilePath = "node"; ArgumentList = @("scripts\hosting\watchdog-ext.mjs","--port","$Port"); WorkingDirectory = $root; WindowStyle = "Hidden"; PassThru = $true;
            RedirectStandardOutput = (Join-Path $out "watchdog-ext.out.log"); RedirectStandardError = (Join-Path $out "watchdog-ext.err.log") }
  $p3 = Start-LoopProcess -NodeArgs ("scripts\hosting\watchdog-ext.mjs --port " + $Port) -WorkDir $root -OutLog (Join-Path $out "watchdog-ext.out.log") -ErrLog (Join-Path $out "watchdog-ext.err.log")
  "watchdog : started pid=$($p3.Id)"
} else { "watchdog : already running pid=" + (($wd | ForEach-Object { $_.ProcessId }) -join ",") }

@{ loop = $loop; at = (Get-Date).ToString("o") } | ConvertTo-Json | Set-Content $pidFile -Encoding UTF8
"all up on port $Port"