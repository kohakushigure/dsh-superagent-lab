<#
.SYNOPSIS
  Register (or remove / inspect) per-user autostart for local-superagent, three-tier fallback:
    1. Scheduled Task  (most robust; needs admin on many machines)
    2. Startup folder shim (no admin, runs at logon)
    3. HKCU Run value  (no admin, simplest)
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/hosting/install-autostart.ps1
  powershell -ExecutionPolicy Bypass -File scripts/hosting/install-autostart.ps1 -Status
  powershell -ExecutionPolicy Bypass -File scripts/hosting/install-autostart.ps1 -Remove
#>
param(
  [string]$TaskName = 'local-superagent',
  [int]$Port = 3082,
  [switch]$Remove,
  [switch]$Status,
  [switch]$SkipScheduledTask,   # test/escape hatch: force the fallback chain
  [switch]$SkipStartupFolder
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$starter = Join-Path $PSScriptRoot 'start-hosted.ps1'
$startupDir = [Environment]::GetFolderPath('Startup')
$startupCmd = Join-Path $startupDir 'superagent-host.cmd'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'local-superagent'
$cmdLine = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $starter + '" -Port ' + $Port + ' -Hidden'

function Get-TaskState {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $t) { return $null }
  return $t
}
function Get-RunValue {
  $p = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $null }
  $prop = $p.PSObject.Properties[$runName]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

function Get-PresentLevels {
  $levels = @()
  if (Get-TaskState) { $levels += 'scheduled-task' }
  if (Test-Path $startupCmd) { $levels += 'startup-folder' }
  if (Get-RunValue) { $levels += 'hkcu-run' }
  return $levels
}

# Unconditionally clear all three levels; never depends on which one is ACTIVE.
function Remove-AllLevels {
  $lines = @()
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    try {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
      $lines += 'scheduled-task: removed'
    } catch {
      $again = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      if (-not $again) { $lines += 'scheduled-task: removed' }
      else { $lines += ('scheduled-task: FAILED - ' + $_.Exception.Message) }
    }
  } else { $lines += 'scheduled-task: already-absent' }

  if (Test-Path $startupCmd) {
    Remove-Item $startupCmd -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $startupCmd)) { $lines += 'startup-folder: removed' }
    else { $lines += 'startup-folder: FAILED' }
  } else { $lines += 'startup-folder: already-absent' }

  # delete the Run value unconditionally: a leftover from an earlier tier must not survive
  try {
    Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop
    $lines += 'hkcu-run: removed'
  } catch { $lines += 'hkcu-run: already-absent' }

  if (Get-RunValue) { $lines += 'hkcu-run: STILL PRESENT' }
  return $lines
}

function Show-Status {
  $task = Get-TaskState
  $cmd = if (Test-Path $startupCmd) { $startupCmd } else { $null }
  $run = Get-RunValue
  Write-Host 'autostart status'
  Write-Host ('  [1] scheduled task : ' + $(if ($task) { 'PRESENT (' + $task.State + ') - ' + $TaskName } else { 'absent' }))
  Write-Host ('  [2] startup folder : ' + $(if ($cmd) { 'PRESENT - ' + $cmd } else { 'absent' }))
  Write-Host ('  [3] HKCU Run       : ' + $(if ($run) { 'PRESENT - ' + $runName + ' = ' + $run } else { 'absent' }))
  $levels = @()
  if ($task) { $levels += 'scheduled-task' }
  if ($cmd) { $levels += 'startup-folder' }
  if ($run) { $levels += 'hkcu-run' }
  if ($levels.Count -gt 1) { Write-Host ('WARN: multiple levels present (' + ($levels -join ', ') + ') - run -Remove for a clean state') -ForegroundColor Yellow }
  $active = if ($levels.Count -gt 0) { $levels[0] } else { 'none' }
  Write-Host ('ACTIVE: ' + $active)
  return $active
}

if ($Status) { Show-Status | Out-Null; exit 0 }

if ($Remove) {
  foreach ($line in (Remove-AllLevels)) { Write-Host ('  ' + $line) }
  $left = Show-Status
  if ($left -ne 'none') { Write-Host ('WARNING: residue still present: ' + $left) -ForegroundColor Red; exit 1 }
  Write-Host 'remove: clean (all three levels absent)' -ForegroundColor Green
  exit 0
}

if (-not (Test-Path $starter)) { throw "missing $starter" }

# ---- pre-clean: an idempotent install must not stack tiers ----
Write-Host 'pre-clean (idempotent install):'
foreach ($line in (Remove-AllLevels)) { Write-Host ('  ' + $line) }

# ---- tier 1: Scheduled Task ----
$mode = $null
if ($SkipScheduledTask) { Write-Host '  [1] scheduled task: skipped by -SkipScheduledTask' -ForegroundColor Yellow }
else { try {
  $arg = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $starter + '" -Port ' + $Port + ' -Hidden'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'local-superagent resident loop (Router/Worker/Watchdog + panel)' -Force | Out-Null
  $mode = 'scheduled-task'
  Write-Host ('  [1] scheduled task: OK -> ' + $TaskName) -ForegroundColor Green
} catch {
  Write-Host ('  [1] scheduled task: FAILED (needs admin?) -> ' + $_.Exception.Message) -ForegroundColor Yellow
} }

# ---- tier 2: Startup folder shim ----
if ($SkipStartupFolder) { Write-Host '  [2] startup folder: skipped by -SkipStartupFolder' -ForegroundColor Yellow }
elseif (-not $mode) {
  try {
    $lines = @(
      '@echo off',
      'rem local-superagent autostart shim (generated by scripts/hosting/install-autostart.ps1)',
      $cmdLine
    )
    Set-Content -Path $startupCmd -Value $lines -Encoding ascii
    $mode = 'startup-folder'
    Write-Host ('  [2] startup folder: OK -> ' + $startupCmd) -ForegroundColor Green
  } catch {
    Write-Host ('  [2] startup folder: FAILED -> ' + $_.Exception.Message) -ForegroundColor Yellow
  }
}

# ---- tier 3: HKCU Run ----
if (-not $mode) {
  try {
    New-ItemProperty -Path $runKey -Name $runName -Value $cmdLine -PropertyType String -Force | Out-Null
    $mode = 'hkcu-run'
    Write-Host ('  [3] HKCU Run: OK -> ' + $runName) -ForegroundColor Green
  } catch {
    Write-Host ('  [3] HKCU Run: FAILED -> ' + $_.Exception.Message) -ForegroundColor Red
  }
}

if (-not $mode) { Write-Host 'autostart: could not register any of the three tiers' -ForegroundColor Red; exit 1 }
Write-Host ('autostart registered via: ' + $mode + '  (port ' + $Port + ')') -ForegroundColor Green
Write-Host 'verify: install-autostart.ps1 -Status   remove: install-autostart.ps1 -Remove'
