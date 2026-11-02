@echo off
REM SuperAgent.cmd - 没有 .NET 时的回退入口（exe 版见 SuperAgent.exe）
setlocal
set "ROOT=%~dp0"
set "PORT=3082"
if /i "%~1"=="--stop" goto stop
if /i "%~1"=="--status" goto status
echo starting loop + selfcheck + watchdog ...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\hosting\start-all.ps1" -Port %PORT%
powershell.exe -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{$r=Invoke-RestMethod 'http://127.0.0.1:%PORT%/api/health' -TimeoutSec 2; if($r.ok){break}}catch{}; Start-Sleep -Milliseconds 500}"
if /i not "%~1"=="--no-open" start "" "http://127.0.0.1:%PORT%/"
echo up: http://127.0.0.1:%PORT%/
goto :eof
:stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\hosting\start-all.ps1" -Port %PORT% -Stop
goto :eof
:status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\hosting\start-all.ps1" -Port %PORT% -Status
goto :eof
