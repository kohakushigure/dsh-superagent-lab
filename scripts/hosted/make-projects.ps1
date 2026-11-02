<#
.SYNOPSIS
    Create (or refresh) the two one-off project fixtures used by T7 / H3 project isolation.

.DESCRIPTION
    Builds verify-out\hosted-projects\{proj-a,proj-b} as *throw-away* mini projects.
    Each one carries a distinct canary file whose SHA-256 is recorded in manifest.json,
    so H3 can prove "project A files were only touched by A's tasks" by hash comparison
    instead of by eyeballing logs.

    Nothing here touches local-superagent/ or the user's profile.

.EXAMPLE
    powershell.exe -NoProfile -File scripts\hosted\make-projects.ps1
    powershell.exe -NoProfile -File scripts\hosted\make-projects.ps1 -Force   # recreate from scratch
#>
[CmdletBinding()]
param(
    [string]$Root,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Root) { $Root = Join-Path $proj 'verify-out\hosted-projects' }
$Root = [System.IO.Path]::GetFullPath($Root)

function Write-Utf8([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

$tenants = @(
    @{ id = 'proj-a'; label = 'Tenant A'; threadPrefix = 'proj-a/' },
    @{ id = 'proj-b'; label = 'Tenant B'; threadPrefix = 'proj-b/' }
)

$manifest = [ordered]@{
    generatedAt = (Get-Date -Format 'o')
    root        = $Root
    tenants     = @()
}

foreach ($t in $tenants) {
    $dir = Join-Path $Root $t.id
    if ($Force -and (Test-Path $dir)) { Remove-Item -Recurse -Force $dir }
    New-Item -ItemType Directory -Force -Path (Join-Path $dir 'src') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $dir 'docs') | Out-Null

    Write-Utf8 (Join-Path $dir 'TENANT') ($t.id + "`n")
    Write-Utf8 (Join-Path $dir 'README.md') ("# " + $t.id + "`n`nT7/H3 throw-away fixture. " + $t.label + ". Do not reuse.`n")
    Write-Utf8 (Join-Path $dir 'src\app.js') ("// " + $t.id + " fixture`nexport const tenant = '" + $t.id + "';`nexport function greet(name) { return '[' + tenant + '] hello ' + name; }`n")
    # canaries: different content per tenant so a cross-project write is visible by hash
    $canary = $t.id.ToUpper() + '-CANARY-ONLY-DO-NOT-TOUCH'
    Write-Utf8 (Join-Path $dir 'src\canary.txt') ($canary + "`n")
    Write-Utf8 (Join-Path $dir 'docs\notes.md') ("- tenant: " + $t.id + "`n- thread prefix: " + $t.threadPrefix + "`n")

    $manifest.tenants += [ordered]@{
        id           = $t.id
        path         = $dir
        threadPrefix = $t.threadPrefix
        canaryPath   = (Join-Path $dir 'src\canary.txt')
        canarySha256 = (Get-FileHash (Join-Path $dir 'src\canary.txt') -Algorithm SHA256).Hash
        files        = @(Get-ChildItem $dir -Recurse -File | ForEach-Object { $_.FullName.Substring($dir.Length + 1) + '|' + $_.Length })
    }
}

$manifestPath = Join-Path $Root 'manifest.json'
Write-Utf8 $manifestPath (($manifest | ConvertTo-Json -Depth 6))

[pscustomobject]$manifest | ConvertTo-Json -Depth 6
Write-Host ("manifest: " + $manifestPath)
