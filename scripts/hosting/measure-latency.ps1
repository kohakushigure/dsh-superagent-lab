<#
.SYNOPSIS
  Measure local-superagent throughput and concurrency behaviour under a synthetic
  model latency, using scripts/hosting/fake-llm.mjs as the OpenAI-compatible stub.

.DESCRIPTION
  For each MAX_CONCURRENCY value it starts a fresh 5-process pair (stub + agent),
  submits N @superagent events on N distinct threads, samples /api/state every 100 ms
  for peak inflight / peak queued, waits for every task to reach a terminal status,
  and records the wall time.

  It also asserts the real adapter path was used: metrics.llm.mode must be "openai",
  llm.calls > 0 and llm.mockCalls == 0.

  With -FailureRun it does one extra pass against a stub that always fails, to prove a
  failing model is recorded as a failed task and does not take the process down.

.EXAMPLE
  pwsh -File scripts/hosting/measure-latency.ps1
  pwsh -File scripts/hosting/measure-latency.ps1 -Caps 1,2,4 -Events 8 -DelayMs 1500
#>
[CmdletBinding()]
param(
  [int]$DelayMs = 1500,
  [int]$JitterMs = 0,
  [string]$Caps = '1,2,4',
  [int]$Events = 8,
  [int]$WorkerSteps = 1,
  [int]$StubPort = 18900,
  [int]$FirstPanelPort = 18901,
  [int]$TimeoutSec = 300,
  [string]$OutDir = 'local-superagent\evidence\hosting',
  [switch]$SkipFailure,
  [switch]$SkipMain
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot
$agentDir = Join-Path $repoRoot 'local-superagent'
$outPath = Join-Path $repoRoot $OutDir
New-Item -ItemType Directory -Force -Path $outPath | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Test-PortFree([int]$port) {
  -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Http([string]$url, [int]$seconds = 30) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-RestMethod -Uri $url -TimeoutSec 2 -ErrorAction Stop
      if ($r) { return $true }
    } catch { Start-Sleep -Milliseconds 200 }
  }
  return $false
}

function Get-State([string]$base) {
  try { return Invoke-RestMethod -Uri ($base + '/api/state') -TimeoutSec 5 -ErrorAction Stop } catch { return $null }
}

function Count-Status($state, [string]$name) {
  if (-not $state -or -not $state.metrics -or -not $state.metrics.tasks) { return 0 }
  $row = @($state.metrics.tasks | Where-Object { $_.status -eq $name })
  if ($row.Count -eq 0) { return 0 }
  return [int]$row[0].n
}

function Stop-Agent([System.Diagnostics.Process]$proc, [string]$base) {
  try { Invoke-RestMethod -Uri ($base + '/api/stop') -Method Post -TimeoutSec 3 -ErrorAction Stop | Out-Null } catch { }
  $deadline = (Get-Date).AddSeconds(20)
  while (-not $proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200; $proc.Refresh() }
  if (-not $proc.HasExited) { try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { } }
}

$capList = @()
foreach ($c in $Caps.Split(',')) { if ($c.Trim() -ne '') { $capList += [int]$c.Trim() } }
if ($capList.Count -eq 0) { throw 'no MAX_CONCURRENCY values given' }

$results = @()
$failures = @()

if (-not $SkipMain) {
  $panelPort = $FirstPanelPort
  foreach ($cap in $capList) {
    $panelPort += 1
    $base = 'http://127.0.0.1:' + $panelPort
    $tag = 'cap' + $cap
    Write-Host ''
    Write-Host ('=== run ' + $tag + '  (MAX_CONCURRENCY=' + $cap + ', delay=' + $DelayMs + 'ms, events=' + $Events + ') ===')

    if (-not (Test-PortFree $StubPort)) { throw ('stub port ' + $StubPort + ' is already in use') }
    if (-not (Test-PortFree $panelPort)) { throw ('panel port ' + $panelPort + ' is already in use') }

    $stubLog = Join-Path $outPath ($stamp + '-' + $tag + '-stub.jsonl')
    $stubSum = Join-Path $outPath ($stamp + '-' + $tag + '-stub-summary.json')
    $agentOut = Join-Path $outPath ($stamp + '-' + $tag + '-agent.out.log')
    $agentErr = Join-Path $outPath ($stamp + '-' + $tag + '-agent.err.log')
    $samples = Join-Path $outPath ($stamp + '-' + $tag + '-samples.jsonl')

    $stubArgs = @('scripts/hosting/fake-llm.mjs', '--port', "$StubPort", '--delay-ms', "$DelayMs", '--jitter-ms', "$JitterMs", '--fail-rate', '0', '--worker-steps', "$WorkerSteps", '--log', $stubLog, '--summary', $stubSum)
    $stub = Start-Process -FilePath 'node' -ArgumentList $stubArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $outPath ($stamp + '-' + $tag + '-stub.out.log')) -RedirectStandardError (Join-Path $outPath ($stamp + '-' + $tag + '-stub.err.log'))
    if (-not (Wait-Http ('http://127.0.0.1:' + $StubPort + '/__stats') 30)) { Stop-Process -Id $stub.Id -Force; throw 'stub did not come up' }
    Write-Host ('  stub pid ' + $stub.Id + ' on ' + $StubPort)

    $stateDir = Join-Path $outPath ('state-' + $tag + '-' + $stamp)
    $env:OPENAI_BASE_URL = 'http://127.0.0.1:' + $StubPort + '/v1'
    $env:OPENAI_API_KEY = 'sk-fake-hosting-measurement'
    $env:MODEL_ROUTER = 'fake-slow-model'
    $env:MODEL_WORKER = 'fake-slow-model'
    $env:MAX_CONCURRENCY = "$cap"
    $env:PANEL_PORT = "$panelPort"
    $env:SUPERAGENT_STATE_DIR = $stateDir
    $env:WORKER_MAX_STEPS = 6
    $env:WORKER_SHELL_PROBE = 'false'
    $env:PASSTHROUGH_ENABLED = 'true'
    $env:WATCHDOG_AUTO_RESTART = 'true'
    $env:LLM_TIMEOUT_MS = '60000'
    $env:LLM_MAX_RETRIES = '1'

    $agent = Start-Process -FilePath 'node' -ArgumentList @('bin/superagent.mjs', 'start', '--port', "$panelPort") -WorkingDirectory $agentDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $agentOut -RedirectStandardError $agentErr
    if (-not (Wait-Http ($base + '/api/health') 40)) { Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue; Stop-Process -Id $stub.Id -Force -ErrorAction SilentlyContinue; throw 'agent did not come up' }
    Write-Host ('  agent pid ' + $agent.Id + ' on ' + $panelPort + '  db ' + $stateDir)

    $before = Get-State $base
    Write-Host ('  llm mode before submit: ' + $before.llmMode + '  cap=' + $before.concurrency.cap)

    $peakInflight = 0
    $peakQueued = 0
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $accepted = 0
    for ($i = 1; $i -le $Events; $i++) {
      $payload = @{
        text   = ('@superagent synthetic request ' + $i + ': write the deliverable for measurement run ' + $tag)
        source = 'http'
        thread = ('thread_' + $tag + '_' + $i)
        author = 'alice'
      } | ConvertTo-Json -Compress
      try {
        $res = Invoke-RestMethod -Uri ($base + '/api/triggers') -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 10 -ErrorAction Stop
        if ($res.ok) { $accepted += 1 }
      } catch {
        Write-Warning ('  submit ' + $i + ' failed: ' + $_.Exception.Message)
      }
    }
    $submitMs = [int]$sw.ElapsedMilliseconds
    Write-Host ('  submitted ' + $accepted + '/' + $Events + ' in ' + $submitMs + ' ms; sampling…')

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $done = 0
    $failed = 0
    $lastLog = (Get-Date).AddSeconds(-1)
    while ((Get-Date) -lt $deadline) {
      $s = Get-State $base
      if ($s) {
        if ($s.concurrency.inflight -gt $peakInflight) { $peakInflight = [int]$s.concurrency.inflight }
        if ($s.concurrency.queued -gt $peakQueued) { $peakQueued = [int]$s.concurrency.queued }
        $done = Count-Status $s 'done'
        $failed = Count-Status $s 'failed'
        $line = '{"t":' + [int]$sw.ElapsedMilliseconds + ',"inflight":' + [int]$s.concurrency.inflight + ',"queued":' + [int]$s.concurrency.queued + ',"done":' + $done + ',"failed":' + $failed + ',"llmCalls":' + [int]$s.metrics.llm.calls + '}'
        Add-Content -LiteralPath $samples -Value $line
        if (($done + $failed) -ge $accepted -and $accepted -gt 0 -and [int]$s.concurrency.inflight -eq 0 -and [int]$s.concurrency.queued -eq 0) { break }
      }
      Start-Sleep -Milliseconds 100
    }
    $sw.Stop()
    $totalMs = [int]$sw.ElapsedMilliseconds
    $after = Get-State $base
    if (-not $after) { $after = $before }

    $adapterOk = ($after.metrics.llm.mode -eq 'openai') -and ([int]$after.metrics.llm.calls -gt 0) -and ([int]$after.metrics.llm.mockCalls -eq 0)
    $avgTaskMs = 0
    if ($done -gt 0) { $avgTaskMs = [int]($totalMs / $done) }
    $row = [ordered]@{
      run          = $tag
      cap          = $cap
      delayMs      = $DelayMs
      events       = $Events
      accepted     = $accepted
      peakInflight = $peakInflight
      peakQueued   = $peakQueued
      totalMs      = $totalMs
      submitMs     = $submitMs
      done         = $done
      failed       = $failed
      avgTaskMs    = $avgTaskMs
      decisions    = [int]$after.metrics.router.decisions
      llmMode      = $after.metrics.llm.mode
      llmCalls     = [int]$after.metrics.llm.calls
      mockCalls    = [int]$after.metrics.llm.mockCalls
      llmErrors    = [int]$after.metrics.llm.errors
      adapterOk    = $adapterOk
      samples      = (Split-Path -Leaf $samples)
    }
    $results += [pscustomobject]$row
    if (-not $adapterOk) { $failures += ('adapter assertion failed in ' + $tag + ': mode=' + $after.metrics.llm.mode + ' calls=' + $after.metrics.llm.calls + ' mockCalls=' + $after.metrics.llm.mockCalls) }
    Write-Host ('  peak inflight=' + $peakInflight + ' queued=' + $peakQueued + ' total=' + $totalMs + 'ms done=' + $done + ' failed=' + $failed + ' llmCalls=' + $after.metrics.llm.calls + ' adapterOk=' + $adapterOk)

    Stop-Agent $agent $base
    try { Invoke-RestMethod -Uri ('http://127.0.0.1:' + $StubPort + '/__shutdown') -Method Post -TimeoutSec 3 | Out-Null } catch { }
    Start-Sleep -Milliseconds 500
    if (-not $stub.HasExited) { try { Stop-Process -Id $stub.Id -Force -ErrorAction SilentlyContinue } catch { } }
    $stub.Refresh()
    if (-not $stub.HasExited) { Stop-Process -Id $stub.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 300
    if (-not (Test-PortFree $panelPort)) { Write-Warning ('  port ' + $panelPort + ' still listening after stop') }
    if (-not (Test-PortFree $StubPort)) { Write-Warning ('  stub port ' + $StubPort + ' still listening after stop') }
  }
}

if (-not $SkipFailure) {
  Write-Host ''
  Write-Host '=== failure path: stub fails every worker call (fail-rate 1, fail-role worker) ==='
  $failPort = $FirstPanelPort + 20
  $base = 'http://127.0.0.1:' + $failPort
  $tag = 'fail-worker'
  if (-not (Test-PortFree $StubPort)) { throw 'stub port busy before failure run' }
  $stubLog = Join-Path $outPath ($stamp + '-' + $tag + '-stub.jsonl')
  $stubSum = Join-Path $outPath ($stamp + '-' + $tag + '-stub-summary.json')
  $stub = Start-Process -FilePath 'node' -ArgumentList @('scripts/hosting/fake-llm.mjs', '--port', "$StubPort", '--delay-ms', '200', '--fail-rate', '1', '--fail-role', 'worker', '--log', $stubLog, '--summary', $stubSum) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $outPath ($stamp + '-' + $tag + '-stub.out.log')) -RedirectStandardError (Join-Path $outPath ($stamp + '-' + $tag + '-stub.err.log'))
  if (-not (Wait-Http ('http://127.0.0.1:' + $StubPort + '/__stats') 30)) { throw 'failure stub did not come up' }

  $stateDir = Join-Path $outPath ('state-' + $tag + '-' + $stamp)
  $env:OPENAI_BASE_URL = 'http://127.0.0.1:' + $StubPort + '/v1'
  $env:OPENAI_API_KEY = 'sk-fake-hosting-measurement'
  $env:MAX_CONCURRENCY = '2'
  $env:PANEL_PORT = "$failPort"
  $env:SUPERAGENT_STATE_DIR = $stateDir
  $env:WORKER_MAX_STEPS = '4'
  $env:LLM_MAX_RETRIES = '1'
  $env:WORKER_MAX_ATTEMPTS = '1'
  $env:WATCHDOG_AUTO_RESTART = 'false'

  $agentOut = Join-Path $outPath ($stamp + '-' + $tag + '-agent.out.log')
  $agentErr = Join-Path $outPath ($stamp + '-' + $tag + '-agent.err.log')
  $agent = Start-Process -FilePath 'node' -ArgumentList @('bin/superagent.mjs', 'start', '--port', "$failPort") -WorkingDirectory $agentDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $agentOut -RedirectStandardError $agentErr
  if (-not (Wait-Http ($base + '/api/health') 40)) { throw 'failure agent did not come up' }

  for ($i = 1; $i -le 2; $i++) {
    $payload = @{ text = ('@superagent failing-model probe ' + $i); source = 'http'; thread = ('thread_fail_' + $i); author = 'alice' } | ConvertTo-Json -Compress
    try { Invoke-RestMethod -Uri ($base + '/api/triggers') -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 10 | Out-Null } catch { Write-Warning ('  submit failed: ' + $_.Exception.Message) }
  }

  $deadline = (Get-Date).AddSeconds(90)
  $failedCount = 0
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ((Get-Date) -lt $deadline) {
    $s = Get-State $base
    if ($s) {
      $failedCount = Count-Status $s 'failed'
      if ($failedCount -ge 1 -and [int]$s.concurrency.inflight -eq 0) { break }
    }
    Start-Sleep -Milliseconds 200
  }
  $sw.Stop()
  $after = Get-State $base
  $alive = -not $agent.HasExited
  $llmErrors = 0
  $lastError = ''
  $humanPending = 0
  if ($after) {
    $llmErrors = [int]$after.metrics.llm.errors
    $lastError = $after.metrics.llm.lastError
    $humanPending = [int]$after.metrics.humanPending
  }

  $aggDone = 0
  $aggDecisions = 0
  $aggMode = ''
  $aggCalls = 0
  $aggMock = 0
  if ($after) {
    $aggDone = Count-Status $after 'done'
    $aggDecisions = [int]$after.metrics.router.decisions
    $aggMode = $after.metrics.llm.mode
    $aggCalls = [int]$after.metrics.llm.calls
    $aggMock = [int]$after.metrics.llm.mockCalls
  }
  $failAdapterOk = ($llmErrors -gt 0) -and $alive
  $failRow = [ordered]@{
    run           = $tag
    cap           = 2
    delayMs       = 200
    events        = 2
    accepted      = 2
    peakInflight  = '-'
    peakQueued    = '-'
    totalMs       = [int]$sw.ElapsedMilliseconds
    submitMs      = 0
    done          = $aggDone
    failed        = $failedCount
    avgTaskMs     = 0
    decisions     = $aggDecisions
    llmMode       = $aggMode
    llmCalls      = $aggCalls
    mockCalls     = $aggMock
    llmErrors     = $llmErrors
    adapterOk     = $failAdapterOk
    samples       = ''
  }
  $results += [pscustomobject]$failRow
  Write-Host ('  process alive=' + $alive + ' failedTasks=' + $failedCount + ' llmErrors=' + $llmErrors + ' humanPending=' + $humanPending)
  Write-Host ('  lastError=' + $lastError)
  if (-not $alive) { $failures += 'FAILURE PATH: agent process died under a failing model' }
  if ($failedCount -lt 1) { $failures += 'FAILURE PATH: no failed task recorded' }

  Stop-Agent $agent $base
  try { Invoke-RestMethod -Uri ('http://127.0.0.1:' + $StubPort + '/__shutdown') -Method Post -TimeoutSec 3 | Out-Null } catch { }
  Start-Sleep -Milliseconds 500
  $stub.Refresh()
  if (-not $stub.HasExited) { Stop-Process -Id $stub.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
  if (-not (Test-PortFree $StubPort)) { Write-Warning '  stub port still listening' }
}

# ---- summary ----
$csv = Join-Path $outPath ('latency-summary-' + $stamp + '.csv')
$json = Join-Path $outPath ('latency-summary-' + $stamp + '.json')
$latestCsv = Join-Path $outPath 'latency-summary.csv'
$latestJson = Join-Path $outPath 'latency-summary.json'
$results | Export-Csv -LiteralPath $csv -NoTypeInformation -Encoding utf8
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $json -Encoding utf8
Copy-Item $csv $latestCsv -Force
Copy-Item $json $latestJson -Force

Write-Host ''
Write-Host '=== summary ==='
$results | Format-Table run, cap, events, accepted, peakInflight, peakQueued, totalMs, done, failed, avgTaskMs, llmCalls, llmMode, adapterOk -AutoSize | Out-String -Width 220 | Write-Host
Write-Host ('csv : ' + $csv)
Write-Host ('json: ' + $json)

if ($failures.Count -gt 0) {
  Write-Host ''
  Write-Host 'ASSERTIONS FAILED:'
  foreach ($f in $failures) { Write-Host ('  - ' + $f) }
  exit 1
}
Write-Host 'all assertions passed'
exit 0