@echo off
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-tailscale.ps1" %*
exit /b %ERRORLEVEL%
