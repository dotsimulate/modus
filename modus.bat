@echo off
:: Launch Modus with watchdog from anywhere.
:: Usage: modus.bat [watch|watch:dev|start|dev]
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%harness"
if "%1"=="watch:dev" (
    set MODUS_WATCH_FILES=1
    bun run watchdog.ts
) else if "%1"=="" (
    bun run watch
) else (
    bun run %*
)
