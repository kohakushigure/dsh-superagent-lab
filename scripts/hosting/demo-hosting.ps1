<#
  demo-hosting.ps1 - 演示「把一个小项目交给常驻 loop 托管」。
  建 projects/demo-blog 与 projects/demo-guest，用 PROJECTS 绑定前缀，投 3 条事件，
  观察并发上限、落盘位置、项目之间是否互不污染。
#>
[CmdletBinding()]
param(
  [int]$Port = 3099,
  [int]$Cap = 2
)
$ErrorActionPreference = 'Stop'
$root = 'G:\Agent-workspace\dsh-superagent'
$sa   = Join-Path $root 'local-superagent'
$proj = Join-Path $root 'projects'
$out  = Join-Path $sa 'evidence\hosting'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log  = Join-Path $out ('demo-hosting-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
function Say($m) { $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $m); $line | Tee-Object -FilePath $log -Append }

Say 'step 1: build two tiny projects'
$a = Join-Path $proj 'demo-blog'; $b = Join-Path $proj 'demo-guest'
foreach ($d in @($a,$b)) { if (Test-Path $d) { Remove-Item $d -Recurse -Force }; New-Item -ItemType Directory -Force -Path (Join-Path $d "src") | Out-Null; New-Item -ItemType Directory -Force -Path (Join-Path $d "docs") | Out-Null }
Set-Content (Join-Path $a 'README.md') -Value '# demo-blog' -Encoding UTF8
Set-Content (Join-Path $a 'src\app.js') -Value 'export const hello = () => "blog";' -Encoding UTF8
Set-Content (Join-Path $a 'docs\notes.md') -Value 'notes' -Encoding UTF8
Set-Content (Join-Path $b 'README.md') -Value '# demo-guest' -Encoding UTF8
Set-Content (Join-Path $b 'src\app.js') -Value 'export const hello = () => "guest";' -Encoding UTF8
Say ("  proj-a={0}" -f $a)
Say ("  proj-b={0}" -f $b)

Say 'step 2: start hosted loop with PROJECTS + MAX_CONCURRENCY'
$st = Join-Path $out 'state-demo'; if (Test-Path $st) { Remove-Item $st -Recurse -Force }
$conns = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($conns) { $conns | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 600 }
$env:PROJECTS = ('demo-blog/=' + $a + ';demo-guest/=' + $b)
$env:MAX_CONCURRENCY = "$Cap"
$env:PANEL_PORT = "$Port"
$env:SUPERAGENT_STATE_DIR = $st
$so = Join-Path $out 'demo-service.out.log'; $se = Join-Path $out 'demo-service.err.log'
$sp = @{ FilePath='node'; ArgumentList=@('bin/superagent.mjs','start','--port',"$Port"); WorkingDirectory=$sa; WindowStyle='Hidden'; PassThru=$true; RedirectStandardOutput=$so; RedirectStandardError=$se }
$p = Start-Process @sp
$ok=$false
for ($i=0;$i -lt 60;$i++){ Start-Sleep -Milliseconds 250; try { $null=Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2; $ok=$true; break } catch {} }
Say ("  health ok={0} pid={1}" -f $ok, $p.Id)

Say 'step 3: POST 3 triggers (2 demo-blog, 1 demo-guest)'
$bodies = @(
  @{ text='@superagent add a docstring to hello in demo-blog'; thread='demo-blog/issue-1' },
  @{ text='@superagent write a CHANGELOG for demo-blog'; thread='demo-blog/issue-2' },
  @{ text='@superagent summarise README of demo-guest'; thread='demo-guest/issue-1' }
)
foreach ($bd in $bodies) { $bd.source = "http"; $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/triggers" -ContentType "application/json" -Body ($bd | ConvertTo-Json -Compress) -TimeoutSec 10; Say ("  -> trigger={0} decision={1} received={2}" -f $r.triggerId, $r.decision, $r.received) }

Say 'step 4: sample concurrency for 1.5s'
$peak = 0; $sawQueue = $false
for ($i=0;$i -lt 10;$i++){ Start-Sleep -Milliseconds 150; try { $s = Invoke-RestMethod "http://127.0.0.1:$Port/api/state" -TimeoutSec 3 } catch { continue }; $c = $s.concurrency; if ($c.inflight -gt $peak) { $peak = $c.inflight }; if ($c.queued -gt 0) { $sawQueue = $true } }
Say ("  peak inflight={0} (cap={1}) sawQueue={2}" -f $peak, $Cap, $sawQueue)
Start-Sleep -Seconds 2

Say 'step 5: tasks and where they landed'
$s2 = Invoke-RestMethod "http://127.0.0.1:$Port/api/state" -TimeoutSec 5
$s2.tasks | ForEach-Object { Say ("  task={0} status={1} project={2}" -f $_.id, $_.status, $_.project) }
Say ("  metrics: received={0} dispatched={1} decisions={2} cap={3} inflight={4} queued={5}" -f $s2.metrics.router.received, $s2.metrics.router.dispatched, $s2.metrics.router.decisions, $s2.concurrency.cap, $s2.concurrency.inflight, $s2.concurrency.queued)

Say 'step 6: file inventory of both projects'
foreach ($d in @($a,$b)) { $files = Get-ChildItem $d -Recurse -File | ForEach-Object { $_.FullName.Replace($d + "\","") }; Say ("  {0}: {1}" -f (Split-Path $d -Leaf), (($files -join ", "))) }

Say 'step 7: stop'
& node (Join-Path $sa "bin\superagent.mjs") stop 2>&1 | Out-Null
Start-Sleep -Milliseconds 800
$still = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
Say ("  port released: {0}" -f (-not $still))
Say ("log: " + $log)
