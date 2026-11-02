<#
.SYNOPSIS
  Start local-superagent as a detached resident process (idempotent), or stop it.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/hosting/start-hosted.ps1 -Port 3082
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/hosting/start-hosted.ps1 -Port 3082 -Stop
#>
param(
  [int]$Port = 3082,
  [string]$LogDir = '',
  [switch]$Stop,
  [switch]$Hidden,
  [int]$HealthTimeoutSec = 30
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pkg = Join-Path $repo 'local-superagent'
if (-not (Test-Path (Join-Path $pkg 'bin/superagent.mjs'))) { throw "local-superagent not found under $pkg" }
if (-not $LogDir) { $LogDir = Join-Path $pkg 'evidence\hosting' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$pidFile = Join-Path $LogDir "hosted-$Port.pid"

function Get-Listener {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

if ($Stop) {
  $l = Get-Listener
  if ($l) {
    try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/stop" -TimeoutSec 5 | Out-Null } catch { }
    Start-Sleep -Seconds 2
  }
  if (Test-Path $pidFile) {
    $old = (Get-Content $pidFile -Raw).Trim()
    if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  if (Get-Listener) { Write-Host "still listening on $Port" -ForegroundColor Yellow; exit 1 }
  Write-Host "stopped (port $Port free)" -ForegroundColor Green
  exit 0
}

$existing = Get-Listener
if ($existing) {
  Write-Host "already running on 127.0.0.1:$Port (pid $($existing.OwningProcess)) - nothing to do" -ForegroundColor Green
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $LogDir "hosted-$Port-$stamp.out.log"
$errLog = Join-Path $LogDir "hosted-$Port-$stamp.err.log"
$proc = Start-Process -FilePath 'node' -ArgumentList @('bin/superagent.mjs', 'start', '--port', "$Port") -WorkingDirectory $pkg -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
Write-Host "spawned pid $($proc.Id), logs: $outLog"

$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
$ok = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    if ($h.ok) { $ok = $true; break }
  } catch { }
}
if (-not $ok) {
  Write-Host "health check failed; see $errLog" -ForegroundColor Red
  exit 1
}
if (-not $Hidden) {
  Write-Host "local-superagent host up: http://127.0.0.1:$Port  (pid $($proc.Id), llm $($h.llm))" -ForegroundColor Green
  Write-Host "  POST http://127.0.0.1:$Port/api/triggers  {\"text\":\"@superagent ...\",\"thread\":\"proj/t1\"}"
}
