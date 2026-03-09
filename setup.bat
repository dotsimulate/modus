@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"
set "ROOT=%cd%"

:: ── Prereqs ─────────────────────────────────────────────────────
echo checking prerequisites...

where bun >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('bun --version 2^>nul') do echo   + bun %%v
) else (
    echo   bun not found — installing...
    powershell -Command "irm bun.sh/install.ps1 | iex"
    if %errorlevel% neq 0 (
        echo   X failed to install bun
        exit /b 1
    )
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
    echo   + bun installed
)

where uv >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('uv --version 2^>nul') do echo   + %%v
) else (
    echo   uv not found — installing...
    powershell -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
    if %errorlevel% neq 0 (
        echo   X failed to install uv
        exit /b 1
    )
    set "PATH=%USERPROFILE%\.local\bin;%PATH%"
    echo   + uv installed
)

:: ── Install JS deps (skip if already installed) ──────────────
echo.
if exist "%ROOT%\harness\node_modules\.package-lock.json" (
    echo   harness deps already installed, skipping
) else (
    echo installing harness dependencies...
    cd /d "%ROOT%\harness"
    call bun install
)

echo.
if exist "%ROOT%\harness\ui\node_modules\.package-lock.json" (
    echo   UI deps already installed, skipping
) else (
    echo installing UI dependencies...
    cd /d "%ROOT%\harness\ui"
    call bun install
)

:: ── Sync Python deps (skip if venv exists) ───────────────────
echo.
if exist "%ROOT%\agent_memory\.venv\Scripts\python.exe" (
    echo   agent-memory Python deps already synced, skipping
) else (
    echo syncing agent-memory Python deps...
    cd /d "%ROOT%\agent_memory"
    call uv sync
)

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

:: ── Launch ────────────────────────────────────────────────────
echo.
echo setup complete! launching...
echo   API :3777  ^|  UI :5180
echo.
cd /d "%ROOT%\harness"
call bun run dev

endlocal
