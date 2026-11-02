<#
.SYNOPSIS
    One-command acceptance replay for local-superagent (T5).

.DESCRIPTION
    Builds a CLEAN COPY of local-superagent/ under verify-out/ (excluding state/, .work/, evidence/,
    state-test/), then runs, inside that copy only:
        1. node --test          (author test suite)
        2. node bin/demo.mjs    (author end-to-end demo)
        3. node scripts/probes/run-all.mjs  (independent probes A-F)
    The original local-superagent/ is never executed against or written to.
    Exit code is 0 only if all three stages pass.

.EXAMPLE
    # this host runs Windows PowerShell 5.1 and has no pwsh.exe on PATH
    powershell.exe -NoProfile -File scripts\verify.ps1
    powershell.exe -NoProfile -File scripts\verify.ps1 -CleanDir verify-out\clean-manual
    pwsh -NoProfile -File scripts\verify.ps1        # works too, if PowerShell 7+ is installed
#>
[CmdletBinding()]
param(
    [string]$CleanDir,
    [int]$DemoPanelPort = 31829
)

$ErrorActionPreference = 'Continue'
$proj = Split-Path -Parent $PSScriptRoot
$vo   = Join-Path $proj 'verify-out'
New-Item -ItemType Directory -Force -Path $vo | Out-Null

$ts  = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $vo ('verify-' + $ts + '.log')
if (-not $CleanDir) { $CleanDir = Join-Path $vo ('clean-' + $ts) }
$CleanDir = [System.IO.Path]::GetFullPath($CleanDir)

function Emit([string]$text) {
    Write-Host $text
    Add-Content -Path $log -Value $text -Encoding UTF8
}
function Stage([string]$name) {
    Emit ''
    Emit ('=' * 78)
    Emit ('>> ' + $name)
    Emit ('=' * 78)
}

Emit ('verify.ps1 start ' + (Get-Date -Format 'o'))
Emit ('project   : ' + $proj)
Emit ('clean copy: ' + $CleanDir)
Emit ('log       : ' + $log)
Emit ('node      : ' + (& node -v))

# ---------- stage 0: clean copy ----------
Stage 'STAGE 0/3  clean copy (state/, .work/, evidence/, state-test/ excluded)'
if (Test-Path $CleanDir) { Remove-Item -Recurse -Force $CleanDir }
New-Item -ItemType Directory -Force -Path $CleanDir | Out-Null
$src = Join-Path $proj 'local-superagent'
$robo = robocopy $src $CleanDir /E /XD state .work evidence state-test /NFL /NDL /NJH /NJS /NP
$roboExit = $LASTEXITCODE
Emit ('robocopy exit=' + $roboExit + '  (0-7 = success)')
$copyOk = ($roboExit -lt 8)
if (-not $copyOk) { Emit 'clean copy failed'; exit 2 }
Emit 'copied tree:'
Get-ChildItem $CleanDir -Recurse -File | ForEach-Object { Emit ('  ' + $_.FullName.Replace($CleanDir + '\', '')) }

$fail = @()

# ---------- stage 1: author test suite ----------
Stage 'STAGE 1/3  node --test  (author suite, run inside the clean copy)'
Push-Location $CleanDir
$tOut = & node --test 2>&1 | Out-String
$tExit = $LASTEXITCODE
Pop-Location
Emit $tOut
Emit ('TEST_EXIT=' + $tExit)
if ($tExit -ne 0) { $fail += 'node --test' }

# ---------- stage 2: author demo ----------
Stage 'STAGE 2/3  node bin/demo.mjs  (author demo, run inside the clean copy)'
$env:PANEL_PORT = [string]$DemoPanelPort
Push-Location $CleanDir
$dOut = & node bin/demo.mjs 2>&1 | Out-String
$dExit = $LASTEXITCODE
Pop-Location
Remove-Item Env:\PANEL_PORT -ErrorAction SilentlyContinue
Emit $dOut
Emit ('DEMO_EXIT=' + $dExit)
if ($dExit -ne 0) { $fail += 'bin/demo.mjs' }

$demoRun = Join-Path $CleanDir 'evidence\demo-run.json'
if (Test-Path $demoRun) {
    $r = Get-Content $demoRun -Raw | ConvertFrom-Json
    Emit ('DEMO_REPORT passed=' + $r.passed + ' failed=' + $r.failed +
          ' ablation.on.decisions=' + $r.ablation.on.decisions + ' ablation.off.decisions=' + $r.ablation.off.decisions +
          ' bypass=' + $r.ablation.on.bypass)
} else { Emit 'DEMO_REPORT missing'; $fail += 'demo-run.json' }

# ---------- stage 3: independent probes ----------
Stage 'STAGE 3/3  independent probes A-F  (node scripts/probes/run-all.mjs)'
$probeRunner = Join-Path $proj 'scripts\probes\run-all.mjs'
$pOut = & node $probeRunner $CleanDir $vo 2>&1 | Out-String
$pExit = $LASTEXITCODE
Emit $pOut
Emit ('PROBES_EXIT=' + $pExit)
if ($pExit -ne 0) { $fail += 'probes A-F' }

# ---------- verdict ----------
Stage 'VERDICT'
if ($fail.Count -eq 0) {
    Emit 'RESULT: PASS  (test + demo + probes A-G, O, H1-H5 all green)'
    Emit ('log: ' + $log)
    exit 0
} else {
    Emit ('RESULT: FAIL  stages=' + ($fail -join ', '))
    Emit ('log: ' + $log)
    exit 1
}
