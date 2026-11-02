<#
.SYNOPSIS
    READ-ONLY Windows Scheduled Task inspector for T7 / H5 (autostart acceptance).

.DESCRIPTION
    Never creates, modifies, starts or deletes a task. Sub-commands:
      list/query : what the machine looks like right now (JSON)
      baseline   : store a snapshot so H5 can diff "before install" vs "after -Remove"
      diff       : compare current state with the stored snapshot (added / removed)

    Uses the ScheduledTasks module when available, otherwise `schtasks /Query` (CSV).
    Diagnostics are always echoed (moduleAvailable / moduleCount / schtasksCount / error),
    so "0 tasks" can never be mistaken for "the probe silently broke".

.EXAMPLE
    powershell.exe -NoProfile -File scripts\hosted\schtasks-probe.ps1 -Action list -Filter '*superagent*'
    powershell.exe -NoProfile -File scripts\hosted\schtasks-probe.ps1 -Action baseline -Filter '*superagent*'
    powershell.exe -NoProfile -File scripts\hosted\schtasks-probe.ps1 -Action diff
#>
[CmdletBinding()]
param(
    [ValidateSet('list', 'query', 'baseline', 'diff')]
    [string]$Action = 'list',
    [string]$Filter = '*superagent*',
    [string]$Name,
    [string]$Snapshot
)

$ErrorActionPreference = 'Continue'
$proj = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Snapshot) { $Snapshot = Join-Path $proj 'verify-out\schtasks-baseline.json' }

$diag = [ordered]@{
    moduleAvailable = $false
    moduleCount     = 0
    moduleError     = $null
    schtasksCount   = 0
    source          = $null
}

function ConvertTo-Row($task, $info) {
    # LastTaskResult is a 32-bit UINT in the OS and can exceed Int32.MaxValue: keep it as a string
    $lastResult = $null
    if ($info) { $lastResult = [string]$info.LastTaskResult }
    [pscustomobject]@{
        TaskPath       = [string]$task.TaskPath
        TaskName       = [string]$task.TaskName
        State          = [string]$task.State
        Author         = [string]$task.Author
        LastRunTime    = if ($info) { [string]$info.LastRunTime } else { $null }
        LastTaskResult = $lastResult
        NextRunTime    = if ($info) { [string]$info.NextRunTime } else { $null }
    }
}

function Get-TasksViaModule {
    $out = New-Object System.Collections.ArrayList
    if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) { return $null }
    $diag.moduleAvailable = $true
    try {
        if ($Name) { $found = @(Get-ScheduledTask -TaskName $Name -ErrorAction Stop) }
        else { $found = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -like $Filter -or $_.TaskPath -like $Filter }) }
    } catch {
        # a missing -Name is a legitimate "not found"; record it and return no rows instead of failing
        $diag.moduleError = [string]$_.Exception.Message
        if ($Name) { return @() }
        return $null
    }
    $diag.moduleCount = $found.Count
    foreach ($t in $found) {
        $info = $null
        try { $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop } catch { $info = $null }
        [void]$out.Add((ConvertTo-Row $t $info))
    }
    return $out.ToArray()
}

function Get-TasksViaSchtasks {
    $out = New-Object System.Collections.ArrayList
    $raw = @()
    try { $raw = @(schtasks.exe /Query /FO CSV /NH 2>$null) } catch { $diag.moduleError = [string]$_.Exception.Message }
    $diag.schtasksCount = $raw.Count
    foreach ($line in $raw) {
        if (-not $line) { continue }
        $cols = $line -split '","'
        if ($cols.Count -lt 2) { continue }
        $taskName = ($cols[0] -replace '^"', '') -replace '"$', ''
        $status = ($cols[1] -replace '^"', '') -replace '"$', ''
        if ($Name) { if ($taskName -notlike ('*' + $Name + '*')) { continue } }
        elseif ($Filter -and $taskName -notlike $Filter) { continue }
        [void]$out.Add([pscustomobject]@{
            TaskPath = '\'; TaskName = $taskName; State = $status; Author = $null
            LastRunTime = $null; LastTaskResult = $null; NextRunTime = $null
        })
    }
    return $out.ToArray()
}

$tasks = Get-TasksViaModule
# decide the source from what actually happened, not from a null-check: an empty result set
# unrolls to $null in PowerShell and would mislabel the path
if ($diag.moduleAvailable -and (-not $diag.moduleError)) {
    $diag.source = 'ScheduledTasks'
    if ($null -eq $tasks) { $tasks = @() }
} else {
    $tasks = Get-TasksViaSchtasks
    $diag.source = 'schtasks'
}
$tasks = @($tasks | Where-Object { $null -ne $_ } | Sort-Object TaskPath, TaskName)
$signature = @($tasks | ForEach-Object { $_.TaskPath + $_.TaskName + '|' + $_.State })

switch ($Action) {
    'list' {
        [pscustomobject]@{ action = 'list'; at = (Get-Date -Format 'o'); filter = $Filter; count = $tasks.Count; diagnostics = $diag; tasks = $tasks } | ConvertTo-Json -Depth 6
    }
    'query' {
        [pscustomobject]@{ action = 'query'; at = (Get-Date -Format 'o'); name = $Name; count = $tasks.Count; diagnostics = $diag; tasks = $tasks } | ConvertTo-Json -Depth 6
    }
    'baseline' {
        $snap = [pscustomobject]@{ at = (Get-Date -Format 'o'); filter = $Filter; count = $tasks.Count; diagnostics = $diag; tasks = $tasks; signature = $signature }
        $dir = Split-Path -Parent $Snapshot
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        [System.IO.File]::WriteAllText($Snapshot, ($snap | ConvertTo-Json -Depth 7), (New-Object System.Text.UTF8Encoding($false)))
        [pscustomobject]@{ action = 'baseline'; snapshot = $Snapshot; count = $tasks.Count; diagnostics = $diag; signature = $signature } | ConvertTo-Json -Depth 6
    }
    'diff' {
        if (-not (Test-Path $Snapshot)) {
            [pscustomobject]@{ action = 'diff'; error = ('snapshot missing: ' + $Snapshot); diagnostics = $diag; added = @(); removed = @(); identical = $false } | ConvertTo-Json -Depth 6
            break
        }
        $old = Get-Content $Snapshot -Raw | ConvertFrom-Json
        $oldSig = @($old.signature)
        $added = @($signature | Where-Object { $oldSig -notcontains $_ })
        $removed = @($oldSig | Where-Object { $signature -notcontains $_ })
        [pscustomobject]@{
            action = 'diff'; snapshot = $Snapshot; at = (Get-Date -Format 'o')
            current = $signature.Count; previous = $oldSig.Count
            added = $added; removed = $removed
            identical = (($added.Count -eq 0) -and ($removed.Count -eq 0))
            diagnostics = $diag
        } | ConvertTo-Json -Depth 6
    }
}
