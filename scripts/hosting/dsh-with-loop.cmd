@echo off
rem dsh-with-loop.cmd - launch DSH, but first kick the hosting loop (idempotent, fire-and-forget).
rem Usage: dsh-with-loop.cmd "C:\path\to\DSH.exe" [args...]
setlocal
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0start-all.ps1" -Port 3082 -Hidden >nul 2>&1
if "%~1"=="" (
  echo usage: dsh-with-loop.cmd ^<dsh exe^> [args...]
  exit /b 2
)
start "" %*