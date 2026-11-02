<#
.SYNOPSIS
  Start the dsh-superagent service for one DeepSeek Harness profile on Windows.

.DESCRIPTION
  Drop-in replacement for the official POSIX-only scripts/dsh-superagent (Python +
  fcntl + tmux + ps, none of which exist on Windows). Starts the DSH web host for a
  profile with DSH_HOME pinned to the project, waits for the management API at
  /orchestrator/api/state, and prints health and setup problems.

  Exit codes follow docs/006-deployment.md:
    0 = runs normally
    1 = does not run / runs twice / does not answer / runtime reports an error
    2 = runs, but a component other than runtime reports an error
    3 = runs and waits for setup

.PARAMETER Profile
  DSH profile name. Default: superagent
.PARAMETER Port
  Panel port, must match the webserver entry in the profile's cordis.patch.yml.
  Default: 3082
.PARAMETER DshHome
  Directory used as DSH_HOME. Default: <repo>\\deploy\\dsh-home
.PARAMETER DshExe
  Path to the DSH desktop executable. Default: read from %USERPROFILE%\\.dsh\\bin\\dsh.cmd
.PARAMETER TimeoutSec
  Startup wait. Default: 120

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\\start.ps1
#>
[CmdletBinding()]
param(
  [string]$Profile = 'superagent',
  [int]$Port = 3082,
  [string]$DshHome,
  [string]$DshExe,
  [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DshHome) { $DshHome = Join-Path $RepoRoot 'deploy\dsh-home' }
$RunDir = Join-Path $RepoRoot 'deploy\run'
$PidFile = Join-Path $RunDir "$Profile.pid"
$ApiBase = "http://127.0.0.1:$Port/orchestrator/api"
$Headers = @{ 'x-orchestrator-request' = '1' }

function Get-DshLauncher {
  param([string]$Explicit)
  if ($Explicit) {
    if (-not (Test-Path -LiteralPath $Explicit)) { throw "DshExe not found: $Explicit" }
    return (Resolve-Path -LiteralPath $Explicit).Path
  }
  $shim = Join-Path $env:USERPROFILE '.dsh\bin\dsh.cmd'
  if (Test-Path -LiteralPath $shim) {
    $line = Select-String -LiteralPath $shim -Pattern 'set "DSH_DESKTOP_APP_EXECUTABLE=(.+)"' | Select-Object -First 1
    if ($line) {
      $exe = $line.Matches[0].Groups[1].Value.TrimEnd('"')
      if (Test-Path -LiteralPath $exe) { return $exe }
    }
  }
  $fallback = Join-Path (Split-Path -Parent $RepoRoot) 'DSH NEXT\DSH NEXT.exe'
  if (Test-Path -LiteralPath $fallback) { return $fallback }
  throw 'Cannot locate the DSH executable. Pass -DshExe <path to DSH NEXT.exe>.'
}

function Get-ServiceProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'DSH NEXT.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*desktop-cli.js*' -and $_.CommandLine -match ('--profile\s+' + [regex]::Escape($Profile) + '(\s|$)') }
}

function Get-State {
  try {
    $raw = Invoke-RestMethod -Uri "$ApiBase/state" -Headers $Headers -TimeoutSec 5 -ErrorAction Stop
    return $raw
  } catch { return $null }
}

function Show-Outcome {
  param($State)
  $runtime = $State.health.runtime
  'health.runtime = ' + $runtime.state + ' (' + $runtime.detail + ')'
  $errors = @($State.health.PSObject.Properties | Where-Object { $_.Value.state -eq 'error' -and $_.Name -ne 'runtime' })
  foreach ($e in $errors) { 'ERROR   ' + $e.Name + ': ' + $e.Value.detail }
  if ($State.setup.problem) { 'SETUP   ' + $State.setup.problem.place + '/' + $State.setup.problem.code + ': ' + $State.setup.problem.detail }
  if ($State.setup.feishuProblem) { 'FEISHU  ' + $State.setup.feishuProblem.detail }
  'load    running=' + $State.load.running + ' queued=' + $State.load.queued + ' maxWorkers=' + $State.load.maxWorkers + ' paused=' + $State.paused
  if ($State.setup.problem) { return 3 }
  if ($errors.Count -gt 0) { return 2 }
  if (@('ready','paused') -notcontains $runtime.state) { return 1 }
  return 0
}

New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
New-Item -ItemType Directory -Force -Path $DshHome | Out-Null

$existing = @(Get-ServiceProcess)
if ($existing.Count -gt 1) { Write-Error "Multiple dsh-superagent processes for profile '$Profile': $($existing.ProcessId -join ', ')"; exit 1 }

if ($existing.Count -eq 1) {
  Write-Host "already running: PID $($existing[0].ProcessId)"
  $existing[0].ProcessId | Set-Content -LiteralPath $PidFile
} else {
  if (Get-State) { Write-Error "Something already answers at $ApiBase; refusing duplicate startup."; exit 1 }
  $exe = Get-DshLauncher -Explicit $DshExe
  $boot = Join-Path (Split-Path -Parent $exe) 'resources\app.asar\lib\desktop-cli.js'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $outLog = Join-Path $RunDir "dsh-superagent-$Profile-$stamp.out.log"
  $errLog = Join-Path $RunDir "dsh-superagent-$Profile-$stamp.err.log"
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:DSH_HOME = $DshHome
  Write-Host "launcher : $exe"
  Write-Host "DSH_HOME : $DshHome"
  Write-Host "log      : $outLog"
  # Start-Process joins an ArgumentList array with spaces and does not quote elements,
  # so a path containing a space (DSH NEXT) must be quoted here or the child receives a
  # truncated path and dies with MODULE_NOT_FOUND. Measured on 2026-11-02.
  $argLine = '--expose-internals "' + $boot + '" --profile ' + $Profile + ' --no-open'
  $proc = Start-Process -FilePath $exe -ArgumentList $argLine -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
  $proc.Id | Set-Content -LiteralPath $PidFile
  Write-Host "started  : PID $($proc.Id)"
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$state = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $state = Get-State
  if ($state -and @('ready','paused') -contains $state.health.runtime.state) { break }
}

if (-not $state) {
  Write-Error "Startup timed out after $TimeoutSec s: $ApiBase/state did not answer. Check the newest log under $RunDir."
  exit 1
}

'--- panel ---'
Get-Content -LiteralPath $outLog -TotalCount 1
'--- state ---'
$code = Show-Outcome -State $state
exit $code