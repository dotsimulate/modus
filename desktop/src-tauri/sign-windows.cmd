@echo off
setlocal

rem Windows code-signing wrapper for Tauri's bundle.windows.signCommand.
rem
rem Tauri replaces %1 with the path of each binary to sign and invokes this once
rem per artifact. Everything account-specific is read from the environment, so no
rem endpoint, account name, certificate profile, or credential is ever committed.
rem
rem See docs/windows-signing.md for how to set these.
rem
rem Required:
rem   MODUS_SIGN_ENDPOINT       Trusted Signing account endpoint URI
rem   MODUS_SIGN_ACCOUNT        Trusted Signing account name
rem   MODUS_SIGN_CERT_PROFILE   Certificate profile name
rem   AZURE_TENANT_ID           \
rem   AZURE_CLIENT_ID            > service principal, read by the Azure SDK
rem   AZURE_CLIENT_SECRET       /

set "TARGET=%~1"
if "%TARGET%"=="" (
  echo [sign] no target passed; Tauri substitutes the binary path for %%1 1>&2
  exit /b 1
)

rem Fail loudly on a missing variable. A signing step that silently does nothing
rem produces an unsigned installer that looks successful, which is worse than a
rem failed build.
for %%V in (MODUS_SIGN_ENDPOINT MODUS_SIGN_ACCOUNT MODUS_SIGN_CERT_PROFILE AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET) do (
  if not defined %%V (
    echo [sign] %%V is not set - refusing to produce an unsigned artifact 1>&2
    echo [sign] see desktop/docs/windows-signing.md 1>&2
    exit /b 1
  )
)

where trusted-signing-cli >nul 2>&1
if errorlevel 1 (
  echo [sign] trusted-signing-cli not found on PATH 1>&2
  echo [sign] install it with: cargo install trusted-signing-cli 1>&2
  exit /b 1
)

echo [sign] signing "%TARGET%"
trusted-signing-cli ^
  -e "%MODUS_SIGN_ENDPOINT%" ^
  -a "%MODUS_SIGN_ACCOUNT%" ^
  -c "%MODUS_SIGN_CERT_PROFILE%" ^
  "%TARGET%"

if errorlevel 1 (
  echo [sign] signing failed for "%TARGET%" 1>&2
  exit /b 1
)

echo [sign] signed "%TARGET%"
exit /b 0
