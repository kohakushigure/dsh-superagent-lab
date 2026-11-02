$ErrorActionPreference = "Stop"
$REPO = "kohakushigure/dsh-superagent-lab"
$ROOT = "G:\Agent-workspace\dsh-superagent"
Set-Location $ROOT
$nl=[char]10; $inp="protocol=https"+$nl+"host=github.com"+$nl+$nl
$out=$inp | git credential fill 2>&1
foreach ($l in $out) { if ($l -like "password=*") { $env:GH_TOKEN=$l.Substring(9) } }
$head = (git rev-parse HEAD).Trim()
$remote = (gh api ("repos/" + $REPO + "/git/ref/heads/main") --jq ".object.sha").Trim()
"remote=" + $remote.Substring(0,7) + " local=" + $head.Substring(0,7)
if ($remote -eq $head) { "already in sync"; exit 0 }
$names = (git diff --name-only ($remote + ".." + $head)) -split "`n" | Where-Object { $_ }
"files=" + $names.Count
$entries = @()
$tmp = Join-Path $env:TEMP "gh-payload.json"
foreach ($n in $names) {
  $abs = Join-Path $ROOT ($n -replace "/", "\")
  if (-not (Test-Path $abs)) { continue }
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($abs))
  @{ content = $b64; encoding = "base64" } | ConvertTo-Json -Compress | Set-Content $tmp -Encoding ascii
  $blob = gh api ("repos/" + $REPO + "/git/blobs") --input $tmp | ConvertFrom-Json
  $entries += @{ path = $n; mode = "100644"; type = "blob"; sha = $blob.sha }
}
$treeBody = @{ base_tree = (gh api ("repos/" + $REPO + "/git/commits/" + $remote) --jq ".tree.sha").Trim(); tree = $entries } | ConvertTo-Json -Depth 6 -Compress
$treeBody | Set-Content $tmp -Encoding ascii
$tree = gh api ("repos/" + $REPO + "/git/trees") --input $tmp | ConvertFrom-Json
$msg = (git log -1 --pretty=%s) + $nl + $nl + (git log -1 --pretty=%b)
$commitBody = @{ message = $msg; tree = $tree.sha; parents = @($remote) } | ConvertTo-Json -Compress
$commitBody | Set-Content $tmp -Encoding ascii
$commit = gh api ("repos/" + $REPO + "/git/commits") --input $tmp | ConvertFrom-Json
$refBody = @{ sha = $commit.sha; force = $false } | ConvertTo-Json -Compress
$refBody | Set-Content $tmp -Encoding ascii
gh api -X PATCH ("repos/" + $REPO + "/git/refs/heads/main") --input $tmp | Out-Null
"published " + $commit.sha.Substring(0,7) + " -> " + $commit.html_url