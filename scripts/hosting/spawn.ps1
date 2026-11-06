<#
  spawn.ps1 - 在 PowerShell 5.1 里可靠地起后台进程。

  背景：当环境变量里同时存在 NO_PROXY 和 no_proxy（大小写不同的两个键）时，
  Start-Process 会抛 "Item has already been added. Key in dictionary: NO_PROXY"。
  这个坑会让计划任务在开机后启动失败（lastResult=1），loop 直接起不来。
  [System.Diagnostics.Process]::Start 不重建环境字典，因此不受影响。
#>
function Start-LoopProcess {
  param(
    [Parameter(Mandatory=$true)][string]$NodeArgs,
    [Parameter(Mandatory=$true)][string]$WorkDir,
    [string]$OutLog,
    [string]$ErrLog
  )
  $redir = ""
  if ($OutLog) { $redir = $redir + " >> " + (Quote-Arg $OutLog) }
  if ($ErrLog) { $redir = $redir + " 2>> " + (Quote-Arg $ErrLog) }
  $line = "/c cd /d " + (Quote-Arg $WorkDir) + " && start " + (Quote-Arg "") + " /b node " + $NodeArgs + $redir
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = $line
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = "Hidden"
  return [System.Diagnostics.Process]::Start($psi)
}

function Quote-Arg([string]$s) {
  return (([char]34) + $s + ([char]34))
}