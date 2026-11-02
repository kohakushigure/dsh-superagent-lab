<#
.SYNOPSIS
  H5 - autostart acceptance for scripts/hosting/install-autostart.ps1 (three-tier fallback).
.DESCRIPTION
  AUTHORITY RULE (after the -Remove defect): the script's own -Status is advisory only.
  Every assertion is made against the three real artifacts:
     [1] Get-ScheduledTask -TaskName local-superagent
     [2] <Startup>\superagent-host.cmd
     [3] HKCU:\...\Run :: local-superagent
  -Status is only cross-checked for consistency, so a lying self-report fails loudly
  instead of silently passing.
  Also proves single-tier behaviour (two consecutive installs must not leave two tiers
  active) and that nothing is left behind at the end.
.OUTPUT
  One PROBE_RESULT {json} line (same protocol as the .mjs probes).
#>
[CmdletBinding()]
param(
    [string]$Port = 3987,
    [string]$CleanDir   # accepted for symmetry with the node probes; unused here
)

$ErrorActionPreference = 'Continue'
$proj = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$installer = Join-Path $proj 'scripts\hosting\install-autostart.ps1'
$schedProbe = Join-Path $proj 'scripts\hosted\schtasks-probe.ps1'
$baseline = Join-Path $proj 'verify-out\h5-schtasks-baseline.json'
$startupDir = [Environment]::GetFolderPath('Startup')
$startupCmd = Join-Path $startupDir 'superagent-host.cmd'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'local-superagent'
$taskName = 'local-superagent'

$checks = New-Object System.Collections.ArrayList
function Check([string]$name, [bool]$ok, $detail) {
    [void]$checks.Add([pscustomobject]@{ name = $name; ok = $ok; detail = $detail })
    $tag = if ($ok) { '  PASS  ' } else { '  FAIL  ' }
    $d = if ($null -eq $detail) { '' } else { '  ::  ' + ($detail | ConvertTo-Json -Compress -Depth 5) }
    Write-Host ($tag + $name + $d)
}

# ---- the three artifacts: the ONLY source of truth -------------------------
function Test-Task { $t = $null; try { $t = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch { $t = $null }; return [bool]$t }
function Test-Shim { return (Test-Path $startupCmd) }
function Test-Run { $v = $null; try { $v = (Get-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop).$runName } catch { $v = $null }; return [bool]$v }
function Get-TierSet {
    return [pscustomobject]@{ task = (Test-Task); startup = (Test-Shim); hkcu = (Test-Run) }
}
function Get-LevelCount($set) { return @($set.task, $set.startup, $set.hkcu | Where-Object { $_ }).Count }
function Get-ActiveFromSet($set) {
    if ($set.task) { return 'scheduled-task' }
    if ($set.startup) { return 'startup-folder' }
    if ($set.hkcu) { return 'hkcu-run' }
    return 'none'
}
function Wait-Condition([scriptblock]$Condition, [int]$TimeoutMs = 6000, [int]$IntervalMs = 150) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
        if (& $Condition) { return [pscustomobject]@{ ok = $true; ms = [int]$sw.ElapsedMilliseconds } }
        Start-Sleep -Milliseconds $IntervalMs
    }
    return [pscustomobject]@{ ok = $false; ms = [int]$sw.ElapsedMilliseconds }
}
function Invoke-Installer([string[]]$psArgs) {
    # never name this parameter $args: it shadows PowerShell's automatic $args and silently drops flags
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer @psArgs 2>&1 | Out-String
    return [pscustomobject]@{ code = $LASTEXITCODE; out = $out }
}
function Get-StatusLine {
    $r = Invoke-Installer @('-Status')
    $active = ''
    foreach ($line in ($r.out -split "`r?`n")) { if ($line -match '^ACTIVE:\s*(\S+)') { $active = $Matches[1] } }
    return [pscustomobject]@{ code = $r.code; out = $r.out; active = $active }
}
function Get-Tier([string]$text) { if ($text -match 'autostart registered via:\s*(\S+)') { return $Matches[1] } return '' }

if (-not (Test-Path $installer)) { Write-Host ('missing ' + $installer); exit 2 }

# ================= setup: full clean, then assert on artifacts ==============
$pre = Invoke-Installer @('-Remove', '-Port', "$Port")
$cleaned = Wait-Condition { (Get-LevelCount (Get-TierSet)) -eq 0 } 10000
$set0 = Get-TierSet
$s0 = Get-StatusLine
Check 'setup: -Remove exits 0' ($pre.code -eq 0) @{ code = $pre.code; out = $pre.out.Trim() }
Check 'setup: all three artifacts are gone after the cleanup sweep' $cleaned.ok @{ settleMs = $cleaned.ms; artifacts = $set0 }
Check 'setup: -Status agrees with the artifacts (none)' ($s0.active -eq 'none') @{ status = $s0.active; artifacts = (Get-ActiveFromSet $set0) }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $schedProbe -Action baseline -Filter '*superagent*' -Snapshot $baseline | Out-Null
$bj = $null
try { $bj = (Get-Content $baseline -Raw | ConvertFrom-Json) } catch { $bj = $null }
Check 'setup: scheduled-task baseline captured and empty' ([bool]$bj -and $bj.count -eq 0) @{ snapshot = $baseline; count = if ($bj) { $bj.count } else { $null } }

try {
    # =============== phase 1: default chain, single tier, clean remove =========
    $p1 = Invoke-Installer @('-Port', "$Port")
    $tier1 = Get-Tier $p1.out
    Check 'phase1: install exits 0 and names a tier' (($p1.code -eq 0) -and ($tier1 -in @('scheduled-task', 'startup-folder', 'hkcu-run'))) @{ code = $p1.code; tier = $tier1 }
    $appeared1 = Wait-Condition { (Get-LevelCount (Get-TierSet)) -ge 1 } 8000
    $set1 = Get-TierSet
    Check 'phase1: exactly one tier is active (no two-tier coexistence)' ((Get-LevelCount $set1) -eq 1) @{ settleMs = $appeared1.ms; artifacts = $set1; levelCount = (Get-LevelCount $set1) }
    Check 'phase1: the artifact that exists is the tier the script claims' ((Get-ActiveFromSet $set1) -eq $tier1) @{ claimed = $tier1; artifacts = $set1 }
    $s1 = Get-StatusLine
    Check 'phase1: -Status matches the artifacts' ($s1.active -eq (Get-ActiveFromSet $set1)) @{ status = $s1.active; artifacts = (Get-ActiveFromSet $set1) }

    $r1 = Invoke-Installer @('-Remove', '-Port', "$Port")
    $cleared1 = Wait-Condition { (Get-LevelCount (Get-TierSet)) -eq 0 } 10000
    Check 'phase1: -Remove clears ALL tiers, not only the active one' $cleared1.ok @{ code = $r1.code; settleMs = $cleared1.ms; artifacts = (Get-TierSet); out = $r1.out.Trim() }

    # =============== phase 2: forced Startup-folder tier ======================
    $p2 = Invoke-Installer @('-Port', "$Port", '-SkipScheduledTask')
    $tier2 = Get-Tier $p2.out
    $appeared2 = Wait-Condition { (Get-LevelCount (Get-TierSet)) -ge 1 } 8000
    $set2 = Get-TierSet
    Check 'phase2: -SkipScheduledTask lands on startup-folder only' (($tier2 -eq 'startup-folder') -and $set2.startup -and (-not $set2.task) -and (-not $set2.hkcu)) @{ tier = $tier2; artifacts = $set2; settleMs = $appeared2.ms }
    if (Test-Shim) {
        $shim = Get-Content $startupCmd -Raw
        Check 'phase2: the shim calls start-hosted.ps1 with our port' (($shim -match 'start-hosted\.ps1') -and ($shim -match ([string]$Port))) @{ shim = $shim.Trim() }
    }
    $s2 = Get-StatusLine
    Check 'phase2: -Status matches the artifacts' ($s2.active -eq (Get-ActiveFromSet $set2)) @{ status = $s2.active; artifacts = (Get-ActiveFromSet $set2) }
    $r2 = Invoke-Installer @('-Remove', '-Port', "$Port")
    $cleared2 = Wait-Condition { (Get-LevelCount (Get-TierSet)) -eq 0 } 10000
    Check 'phase2: -Remove clears all tiers' $cleared2.ok @{ code = $r2.code; settleMs = $cleared2.ms; artifacts = (Get-TierSet) }

    # =============== phase 3: forced HKCU Run tier ============================
    $p3 = Invoke-Installer @('-Port', "$Port", '-SkipScheduledTask', '-SkipStartupFolder')
    $tier3 = Get-Tier $p3.out
    $appeared3 = Wait-Condition { (Get-LevelCount (Get-TierSet)) -ge 1 } 8000
    $set3 = Get-TierSet
    Check 'phase3: skipping tiers 1+2 lands on hkcu-run only' (($tier3 -eq 'hkcu-run') -and $set3.hkcu -and (-not $set3.task) -and (-not $set3.startup)) @{ tier = $tier3; artifacts = $set3; settleMs = $appeared3.ms }
    $runVal = $null
    try { $runVal = (Get-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop).$runName } catch { $runVal = $null }
    Check 'phase3: the Run value points at the starter' ([bool]$runVal -and ($runVal -match 'start-hosted\.ps1')) @{ value = $runVal }
    $s3 = Get-StatusLine
    Check 'phase3: -Status matches the artifacts' ($s3.active -eq (Get-ActiveFromSet $set3)) @{ status = $s3.active; artifacts = (Get-ActiveFromSet $set3) }
    $r3 = Invoke-Installer @('-Remove', '-Port', "$Port")
    $cleared3 = Wait-Condition { (Get-LevelCount (Get-TierSet)) -eq 0 } 10000
    Check 'phase3: -Remove clears all tiers' $cleared3.ok @{ code = $r3.code; settleMs = $cleared3.ms; artifacts = (Get-TierSet) }

    # =============== phase 4: double install must stay single-tier ============
    $d1 = Invoke-Installer @('-Port', "$Port")
    $d2 = Invoke-Installer @('-Port', "$Port")
    $afterDouble = Wait-Condition { (Get-LevelCount (Get-TierSet)) -ge 1 } 8000
    $set4 = Get-TierSet
    $s4 = Get-StatusLine
    Check 'phase4: two consecutive installs both exit 0' (($d1.code -eq 0) -and ($d2.code -eq 0)) @{ first = $d1.code; second = $d2.code }
    Check 'phase4: after two installs still exactly one tier is active' ((Get-LevelCount $set4) -eq 1) @{ artifacts = $set4; levelCount = (Get-LevelCount $set4); settleMs = $afterDouble.ms }
    Check 'phase4: -Status matches the artifacts after the double install' ($s4.active -eq (Get-ActiveFromSet $set4)) @{ status = $s4.active; artifacts = (Get-ActiveFromSet $set4) }
    $noisy = (($d1.out + $d2.out) -match 'WARN|residue|FAILED')
    Check 'phase4: no WARN / residue / FAILED in either install output' (-not $noisy) @{ first = $d1.out.Trim(); second = $d2.out.Trim() }
    $r4 = Invoke-Installer @('-Remove', '-Port', "$Port")
    $cleared4 = Wait-Condition { (Get-LevelCount (Get-TierSet)) -eq 0 } 10000
    Check 'phase4: -Remove clears all tiers after the double install' $cleared4.ok @{ code = $r4.code; settleMs = $cleared4.ms; artifacts = (Get-TierSet) }

    # =============== phase 5: a leftover lower tier must be warned about and removed ===
    # Build a genuine multi-level state the way a real upgrade would: tier 1 installed plus a
    # leftover Startup shim from an older setup. -Status must WARN, and -Remove must clear the
    # level that is NOT active (this is the D1 regression).
    $null = Invoke-Installer @('-Port', "$Port")
    $null = Wait-Condition { (Get-LevelCount (Get-TierSet)) -ge 1 } 8000
    $leftoverShim = '@echo off' + [Environment]::NewLine + 'rem leftover tier from an older install' + [Environment]::NewLine
    Set-Content -Path $startupCmd -Value $leftoverShim -Encoding ascii
    $multi = Wait-Condition { (Get-LevelCount (Get-TierSet)) -ge 2 } 5000
    $set5 = Get-TierSet
    Check 'phase5: two tiers coexist (simulated leftover)' ($multi.ok -and (Get-LevelCount $set5) -ge 2) @{ artifacts = $set5; levelCount = (Get-LevelCount $set5) }
    $sWarn = Get-StatusLine
    Check 'phase5: -Status warns about multiple levels' ($sWarn.out -match 'WARN:\s*multiple levels present') @{ status = $sWarn.active; out = $sWarn.out.Trim() }
    $r5 = Invoke-Installer @('-Remove', '-Port', "$Port")
    $cleared5 = Wait-Condition { (Get-LevelCount (Get-TierSet)) -eq 0 } 10000
    Check 'phase5: -Remove clears the NON-active level too (D1 regression)' ($cleared5.ok -and ($r5.out -match 'startup-folder: removed')) @{ code = $r5.code; settleMs = $cleared5.ms; artifacts = (Get-TierSet); out = $r5.out.Trim() }
    Check 'phase5: -Remove reports a clean state' ($r5.out -match 'remove: clean') @{ out = $r5.out.Trim() }

    # =============== final: artifacts + baseline, self-report advisory =======
    $diffRaw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $schedProbe -Action diff -Snapshot $baseline 2>&1 | Out-String
    $dj = $null
    try { $dj = $diffRaw | ConvertFrom-Json } catch { $dj = $null }
    Check 'final: scheduled-task set identical to the pre-install baseline' ([bool]$dj -and $dj.identical -eq $true) @{ diff = $dj }
    $finalSet = Get-TierSet
    Check 'final: no scheduled task' (-not $finalSet.task) @{ artifacts = $finalSet }
    Check 'final: no Startup-folder shim' (-not $finalSet.startup) @{ path = $startupCmd }
    Check 'final: no HKCU Run value' (-not $finalSet.hkcu) @{ value = (Test-Run) }
    $s5 = Get-StatusLine
    Check 'final: -Status also says none (consistency, not authority)' ($s5.active -eq 'none') @{ status = $s5.active }
} finally {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Remove -Port "$Port" 2>&1 | Out-Null
    $null = Wait-Condition { (Get-LevelCount (Get-TierSet)) -eq 0 } 8000
    $left = Get-TierSet
    if ((Get-LevelCount $left) -gt 0) {
        Write-Host ('WARNING: autostart residue after cleanup: ' + ($left | ConvertTo-Json -Compress)) -ForegroundColor Red
    }
}

$passed = @($checks | Where-Object { $_.ok }).Count
$failed = $checks.Count - $passed
$rec = [pscustomobject]@{
    case   = 'H5'
    label  = 'autostart: artifact-verified single-tier install/status/remove, zero residue'
    checks = $checks.Count
    passed = $passed
    failed = $failed
    detail = $checks
}
Write-Host ('PROBE_RESULT ' + ($rec | ConvertTo-Json -Depth 6 -Compress))
if ($failed -gt 0) { exit 1 } else { exit 0 }
