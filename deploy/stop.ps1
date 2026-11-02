<#
.SYNOPSIS
  Stop the dsh-superagent service for one DeepSeek Harness profile on Windows.

.DESCRIPTION
  Counterpart of the official POSIX-only scripts/dsh-superagent stop. Windows has no
  portable way to deliver SIGINT to a detached console application, so this stops the
  process with TerminateProcess (Stop-Process) after closing the panel URL. Any
  Executor Session in the middle of a turn is lost; its Ticket stays queued in the
  SQLite state database and is picked up again on the next start.

.PARAMETER Profile
  DSH profile name. Default: superagent
.PARAMETER Port
  Panel port used only for the final reachability report. Default: 3082
.PARAMETER TimeoutSec
  How long to wait for the process to exit. Default: 30

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\\stop.ps1
#>
[CmdletBinding()]
param(
  [string]$Profile = 'superagent',
  [int]$Port = 3082,
  [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'
$RunDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy\run'
$PidFile = Join-Path $RunDir "$Profile.pid"

function Get-ServiceProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'DSH NEXT.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*desktop-cli.js*' -and $_.CommandLine -match ('--profile\s+' + [regex]::Escape($Profile) + '(\s|$)') }
}

if (Test-Path -LiteralPath $PidFile) {
  $recorded = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  Write-Host "recorded pid: $recorded"
} else {
  Write-Host 'no pid file; scanning processes'
}

$targets = @(Get-ServiceProcess)
if ($targets.Count -eq 0) {
  Write-Host "no dsh-superagent process for profile '$Profile' is running"
  Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
  exit 0
}

Write-Host "stopping : $($targets.ProcessId -join ', ')"
foreach ($p in $targets) {
  try { Stop-Process -Id $p.ProcessId -ErrorAction Stop } catch { Write-Warning "could not stop $($p.ProcessId): $($_.Exception.Message)" }
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if (@(Get-ServiceProcess).Count -eq 0) { break }
}

$left = @(Get-ServiceProcess)
if ($left.Count -gt 0) {
  Write-Warning "still running after $TimeoutSec s: $($left.ProcessId -join ', ')"
  foreach ($p in $left) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { } }
  Start-Sleep -Seconds 2
  $left = @(Get-ServiceProcess)
}

Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue

if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
  Write-Warning "port $Port is still listening"
} else {
  Write-Host "port $Port free"
}

if ($left.Count -gt 0) { Write-Error "stop failed for $($left.ProcessId -join ', ')"; exit 1 }
Write-Host 'dsh-superagent stopped (abrupt; queued Tickets survive in the state database)'
exit 0