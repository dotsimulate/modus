@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"
set "ROOT=%cd%"

:: ── Prereqs ─────────────────────────────────────────────────────
echo checking prerequisites...

set "MISSING=0"

where bun >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('bun --version 2^>nul') do echo   + bun %%v
) else (
    echo   X bun not found
    set "MISSING=1"
)

where uv >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('uv --version 2^>nul') do echo   + %%v
) else (
    echo   X uv not found
    set "MISSING=1"
)

if "%MISSING%"=="1" (
    echo.
    echo install missing tools before continuing:
    echo   bun  - https://bun.sh
    echo   uv   - https://docs.astral.sh/uv/
    exit /b 1
)

:: ── Install JS deps ────────────────────────────────────────────
echo.
echo installing harness dependencies...
cd /d "%ROOT%\harness"
call bun install

echo.
echo installing UI dependencies...
cd /d "%ROOT%\harness\ui"
call bun install

:: ── Sync Python deps ───────────────────────────────────────────
echo.
echo syncing agent-memory Python deps...
cd /d "%ROOT%\agent_memory"
call uv sync

:: ── MCP config ─────────────────────────────────────────────────
cd /d "%ROOT%"
if not exist ".mcp.json" (
    echo.
    echo creating .mcp.json from example...
    copy ".mcp.json.example" ".mcp.json" >nul

    :: Patch relative path to absolute
    set "ABS_MEM=%ROOT%\agent_memory"
    :: Use PowerShell for reliable string replacement
    powershell -Command "(Get-Content '.mcp.json') -replace '\./agent_memory','!ABS_MEM:\=\\!' | Set-Content '.mcp.json'"
    echo   created .mcp.json ^(agent-memory path set to %ROOT%\agent_memory^)
) else (
    echo   .mcp.json already exists, skipping
)

:: ── Done ────────────────────────────────────────────────────────
echo.
echo setup complete!
echo.
echo   start:  cd harness; bun run dev    (PowerShell)
echo           cd harness ^&^& bun run dev  (cmd)
echo   ports:  API :3777  ^|  UI :5180
echo.
echo   first launch will prompt you to set a PIN.

endlocal
