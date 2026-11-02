<#
  measure-loop.ps1 - 测量 local-superagent 作为常驻 loop 托管的可行性（只观测，不改实现）。
  输出：local-superagent/evidence/hosting/measure-<ts>.log
#>
[CmdletBinding()]
param(
  [int]$Port = 3082,
  [int]$Burst = 20,
  [int]$SoakSeconds = 60
)
$ErrorActionPreference = 'Stop'
$root = 'G:\Agent-workspace\dsh-superagent'
$sa   = Join-Path $root 'local-superagent'
$out  = Join-Path $sa 'evidence\hosting'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log  = Join-Path $out ('measure-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
function Say($m) { $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $m); $line | Tee-Object -FilePath $log -Append }

Say ('measure start; port=' + $Port + ' burst=' + $Burst + ' soak=' + $SoakSeconds + 's')

$conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($conn) { $conn | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 800; Say 'killed stale listener' }

$so = Join-Path $out 'service.out.log'; $se = Join-Path $out 'service.err.log'
$spArgs = @{
  FilePath = 'node'
  ArgumentList = @('bin/superagent.mjs','start','--port',"$Port")
  WorkingDirectory = $sa
  WindowStyle = 'Hidden'
  PassThru = $true
  RedirectStandardOutput = $so
  RedirectStandardError = $se
}
$p = Start-Process @spArgs
Say ("spawned pid={0} (detached; script exits later, service must survive)" -f $p.Id)

$ok = $false; $h = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2; $ok = $true; break } catch {}
}
Say ("health ok={0} after {1}s; llm={2}" -f $ok, [math]::Round($i*0.25,2), $h.llm)
$proc0 = Get-Process -Id $p.Id
Say ("baseline rss={0:N1}MB threads={1} handles={2}" -f ($proc0.WorkingSet64/1MB), $proc0.Threads.Count, $proc0.HandleCount)

$t0 = Get-Date
for ($k = 1; $k -le $Burst; $k++) {
  & node (Join-Path $sa 'bin\superagent.mjs') submit "implement hosting probe item $k" --thread "proj/issue-$k" --source cli 2>&1 | Out-Null
}
$submitMs = ((Get-Date) - $t0).TotalMilliseconds
Say ("submitted {0} triggers in {1:N0} ms ({2:N1} ms each)" -f $Burst, $submitMs, ($submitMs/$Burst))

$peak = 0; $samples = @()
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 400
  try { $s = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 3 } catch { continue }
  $pp = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
  $rss = if ($pp) { [math]::Round($pp.WorkingSet64/1MB,1) } else { -1 }
  if ($pp) { $peak = [math]::Max($peak, $pp.WorkingSet64/1MB) }
  $samples += [pscustomobject]@{ t=$i; inflight=$s.metrics.inflight; tasks=$s.tasks.Count; rss=$rss }
}
$maxInflight = ($samples | Measure-Object -Property inflight -Maximum).Maximum
Say ("peak inflight={0} (burst={1}) -> cap? {2}" -f $maxInflight, $Burst, ($(if ($maxInflight -lt $Burst) {"YES"} else {"NO (unbounded)"})))
Say ("rss peak={0:N1}MB" -f $peak)

$soakStart = Get-Date; $n = 0
while (((Get-Date) - $soakStart).TotalSeconds -lt $SoakSeconds) {
  $n++
  & node (Join-Path $sa 'bin\superagent.mjs') submit "soak item $n" --thread "soak/issue-$n" --source cli 2>&1 | Out-Null
  Start-Sleep -Seconds 2
}
Start-Sleep -Seconds 3
$pp = Get-Process -Id $p.Id
Say ("after soak: submitted={0} rss={1:N1}MB handles={2} uptime={3:N0}s" -f $n, ($pp.WorkingSet64/1MB), $pp.HandleCount, ((Get-Date) - $pp.StartTime).TotalSeconds)
$s2 = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state"
Say ("final: tasks={0} inflight={1} decisions={2} dispatched={3} needHuman={4}" -f $s2.tasks.Count, $s2.metrics.inflight, $s2.metrics.decisions, $s2.metrics.dispatched, $s2.metrics.needHuman)
Say ("service pid {0} alive at script end: {1}" -f $p.Id, [bool](Get-Process -Id $p.Id -ErrorAction SilentlyContinue))
Say ("log: " + $log)
