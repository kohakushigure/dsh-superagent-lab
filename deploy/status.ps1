<#
.SYNOPSIS
  Report the dsh-superagent service state for one DSH profile (Windows replacement for
  scripts/dsh-superagent status). Exit codes: 0 ok, 1 down/duplicate/unreachable,
  2 a component error, 3 waiting for setup.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\\status.ps1
#>
[CmdletBinding()]
param(
  [string]$Profile = 'superagent',
  [int]$Port = 3082
)

$ErrorActionPreference = 'Continue'
$RunDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy\run'
$ApiBase = "http://127.0.0.1:$Port/orchestrator/api"

$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'DSH NEXT.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*desktop-cli.js*' -and $_.CommandLine -match ('--profile\s+' + [regex]::Escape($Profile) + '(\s|$)') })

[pscustomobject]@{ pids = @($procs | ForEach-Object { $_.ProcessId }); profile = $Profile; url = "http://127.0.0.1:$Port" } | ConvertTo-Json -Compress

if ($procs.Count -eq 0) { Write-Host 'state   : not running'; exit 1 }

$state = $null
try { $state = Invoke-RestMethod -Uri "$ApiBase/state" -Headers @{ 'x-orchestrator-request' = '1' } -TimeoutSec 5 -ErrorAction Stop }
catch { Write-Host "state   : unreachable ($ApiBase/state)"; exit 1 }

$state.health | ConvertTo-Json -Depth 4
'setup   : ' + ($(if ($state.setup.problem) { $state.setup.problem.place + '/' + $state.setup.problem.code + ' - ' + $state.setup.problem.detail } else { 'none' }))
'load    : running=' + $state.load.running + ' queued=' + $state.load.queued + ' maxWorkers=' + $state.load.maxWorkers + ' paused=' + $state.paused

$errors = @($state.health.PSObject.Properties | Where-Object { $_.Value.state -eq 'error' -and $_.Name -ne 'runtime' })
if ($procs.Count -gt 1) { exit 1 }
if ($state.setup.problem) { exit 3 }
if ($errors.Count -gt 0) { $errors | ForEach-Object { 'ERROR ' + $_.Name + ': ' + $_.Value.detail }; exit 2 }
if (@('ready','paused') -notcontains $state.health.runtime.state) { exit 1 }
exit 0