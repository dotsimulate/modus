@echo off
:: Launch Modus with watchdog from anywhere.
:: Usage: modus.bat [open [path]|init [path]|watch|watch:dev|start|dev]
set SCRIPT_DIR=%~dp0
set ORIG_DIR=%CD%
cd /d "%SCRIPT_DIR%harness"
bun install
if "%1"=="setup" (
    bun run setup.ts
) else if "%1"=="init" (
    bun run cli-init.ts %2 %ORIG_DIR%
) else if "%1"=="open" (
    if "%2"=="" (
        set TARGET=%ORIG_DIR%
    ) else (
        pushd "%ORIG_DIR%"
        cd /d "%2"
        set TARGET=%CD%
        popd
    )
    if not exist "%TARGET%\.modus" (
        echo No .modus/ found — initializing project in %TARGET%
        bun run cli-init.ts "" "%TARGET%"
    )
    echo Opening project: %TARGET%
    set AGENT_CWD=%TARGET%
    bun run watchdog.ts
) else if "%1"=="watch:dev" (
    set MODUS_WATCH_FILES=1
    bun run watchdog.ts
) else if "%1"=="" (
    bun run watch
) else (
    bun run %*
)
