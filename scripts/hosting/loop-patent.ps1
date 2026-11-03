# loop-patent.ps1 - dedicated loop instance for the patent repo (ASCII only on purpose:
# writing CJK through this pipeline corrupted the file once and silently broke PROJECTS JSON).
param([int]$Port = 3091, [switch]$Stop)
$ErrorActionPreference = "Stop"
$root = "G:\Agent-workspace\dsh-superagent"
$sa = Join-Path $root "local-superagent"
$out = Join-Path $sa "evidence\hosting"
$state = Join-Path $root "dist\live\state"

if ($Stop) {
  Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  "stopped loop on $Port"
  return
}

$env:SUPERAGENT_STATE_DIR = $state
$env:MAX_CONCURRENCY = "1"
$env:WORKER_MAX_STEPS = "18"
$env:WORKER_RUN_TIMEOUT_MS = "180000"
$env:FAST_ALLOWLIST = "kohakushigure"
$env:POLICY_ALLOWLIST = "kohakushigure"
$env:SUPERAGENT_AUTH_TOKEN = "loop-patent-token"
$env:PASSTHROUGH_ENABLED = "true"
$env:PROJECTS = @'
{"kohakushigure/llm-patent-batch-generator#":{"dir":"G:\\Agent-workspace\\dsh-superagent\\dist\\live\\patent","outDir":"docs/records/loop-trial","run":["git switch","git status","git add","git commit -m","git push","git diff --stat","git rev-parse","python -m pytest --collect-only"],"gh":["issue view","issue comment","pr create","pr list"],"channel":"github-pr","base":"develop","prBranch":"agent/loop-record-2","maxSteps":18,"recipe":["run: git switch -c agent/loop-record-2   (if it already exists, run: git switch agent/loop-record-2)","fs.write docs/records/loop-trial/README.md  (purpose + 3 constraints + one verification line)","run: python -m pytest --collect-only -q","run: git add -A","run: git commit -m \"docs(records): loop trial record\"","run: git push -u origin agent/loop-record-2","answer final with summary/deliverable/changes/refs/ran/notRun/blockers and branch=agent/loop-record-2"]}}
'@

Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
Start-Process -FilePath "node" -ArgumentList @("bin/superagent.mjs","start","--port","$Port") -WorkingDirectory $sa -WindowStyle Hidden -RedirectStandardOutput (Join-Path $out "loop-patent.out.log") -RedirectStandardError (Join-Path $out "loop-patent.err.log")
Start-Sleep -Seconds 6
try { $h = Invoke-RestMethod ("http://127.0.0.1:" + $Port + "/api/health") -TimeoutSec 5; "llm=" + $h.llm } catch { "loop down" }