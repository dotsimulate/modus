# Windows code signing

Unsigned Windows installers trigger a SmartScreen warning and show "Unknown publisher" in the
UAC prompt. This document describes how signing is wired into the Modus desktop build.

Signing is **opt-in**. `bun run build:bundle` is unchanged and produces an unsigned installer
with no credentials present, so contributors and CI can build without any signing setup.
`bun run build:signed` merges `src-tauri/tauri.signing.conf.json`, which routes each unsigned
Modus artifact through `src-tauri/sign-windows.cmd`.

No account-specific value is committed. The wrapper reads everything from the environment, so
the repository contains no endpoint, account name, certificate profile, or credential.

---

## How it is wired

| File | Role |
|---|---|
| `src-tauri/tauri.signing.conf.json` | Config overlay setting `bundle.windows.signCommand`. Merged only by `build:signed`. |
| `src-tauri/sign-windows.cmd` | Wrapper Tauri invokes once per artifact. Reads credentials from the environment. |
| `package.json` → `build:signed` | Runs the host-path-sanitizing desktop build wrapper in signed mode; the wrapper invokes `tauri build --config src-tauri/tauri.signing.conf.json`. |

Tauri replaces `%1` with the path of each binary to sign. It signs the Modus CLI sidecar, patched
main executable, and installer. It verifies external sidecars first and skips one that already has
a valid signature, so the upstream-signed `bun.exe` should retain its existing publisher.

The reference implementation targets **Azure Artifact Signing** (formerly Trusted Signing) via `trusted-signing-cli`. The
wrapper is the only file that knows that; swapping to `signtool`, `AzureSignTool`, or another
service means rewriting `sign-windows.cmd` and nothing else.

---

## Prerequisites

### 1. Signing tool

```powershell
cargo install trusted-signing-cli
where.exe trusted-signing-cli
```

### 2. A service principal with signing rights

In the Azure portal, for the Artifact Signing account:

1. **Microsoft Entra ID → App registrations → New registration.** Single tenant is fine. Record
   the **Application (client) ID** and **Directory (tenant) ID**.
2. **Certificates & secrets → New client secret.** Record the **Value** immediately; it is shown
   once.
3. **Artifact Signing account → Access control (IAM) → Add role assignment.** Grant the app
   registration the **Artifact Signing Certificate Profile Signer** role.

Step 3 is the one most easily missed. Without it, signing fails with an authorization error even
though every credential is correct.

### 3. Account values

From the Artifact Signing account:

| Value | Where |
|---|---|
| Account endpoint URI | Account **Overview**, e.g. `https://<region>.codesigning.azure.net` |
| Account name | Account **Overview** |
| Certificate profile name | **Certificate profiles** blade |

---

## Environment

Six variables, set in the shell the build runs from:

```powershell
$env:MODUS_SIGN_ENDPOINT     = "https://<region>.codesigning.azure.net"
$env:MODUS_SIGN_ACCOUNT      = "<artifact-signing-account-name>"
$env:MODUS_SIGN_CERT_PROFILE = "<certificate-profile-name>"
$env:AZURE_TENANT_ID         = "<directory-tenant-id>"
$env:AZURE_CLIENT_ID         = "<application-client-id>"
$env:AZURE_CLIENT_SECRET     = "<client-secret-value>"
```

**Set these in the build shell only, and let them die with it.** Do not persist them with
`[Environment]::SetEnvironmentVariable("NAME", "value", "User")`. Modus spawns provider CLIs as
child processes that inherit the environment, and the credential filter in
`harness/providers/child-env.ts` strips only Modus' own credentials (`HARNESS_TOKEN`,
`HARNESS_PIN`, `MODUS_SESSION_MCP_TOKEN`, and similar). Nothing removes `AZURE_*`, so a
user-scoped `AZURE_CLIENT_SECRET` is handed to every agent subprocess Modus starts, for as long
as it is set. A session-scoped variable is gone when the terminal closes.

In CI, supply them as masked secrets scoped to the signing job.

**These belong only in the environment.** There is deliberately no `.env` file for them — the
wrapper reads the environment precisely so no value has to be written somewhere it could be
committed.

---

## Building

```powershell
cd desktop
bun run build:signed
```

The wrapper refuses to run when any variable is unset or `trusted-signing-cli` is not on PATH.
That is deliberate: a signing step that silently does nothing produces an unsigned installer that
looks like a successful build, which is worse than a failed one.

The installer filename is version-derived, so consecutive builds overwrite it. Copy the previous
artifact to a descriptive name first if it is needed as a rollback:

```powershell
cd src-tauri\target\release\bundle\nsis
copy Modus_0.2.0_x64-setup.exe Modus_0.2.0_x64-setup-<what-it-predates>-<date>.exe
```

---

## Verifying

```powershell
$artifacts = @(
  ".\src-tauri\target\release\bundle\nsis\Modus_0.2.0_x64-setup.exe"
  ".\src-tauri\target\release\modus-desktop.exe"
  ".\src-tauri\target\release\modus.exe"
  ".\src-tauri\target\release\bun.exe"
)
Get-AuthenticodeSignature $artifacts |
  Format-Table Path, Status, StatusMessage, SignerCertificate
```

Every `Status` must be `Valid`. The first three should name the expected Modus publisher; Bun
should retain its valid upstream signature. Check the signer subjects, and confirm timestamps are
present — a signature without one stops validating when the certificate expires. Artifact Signing
timestamps by default, so a missing timestamp indicates a problem.

Then run the installer and confirm the UAC prompt names the expected publisher rather than
"Unknown publisher".

---

## Notes

- **`bundle.publisher` does not have to match the certificate subject.** It is set in
  `tauri.conf.json` and is the NSIS manifest publisher, which keys the install location and the
  uninstall registry entry — changing it breaks upgrade and uninstall detection for existing
  installs. The UAC prompt names the *certificate* subject, which the signing service issues and
  the manifest cannot influence. Leave `bundle.publisher` alone when the certificate subject
  differs from it.
- **Installer signing is not updater signing.** The Tauri updater carries its own signature, and
  its switch is compile-time: `src/updates.rs` reads `option_env!("MODUS_UPDATER_ENDPOINT")` and
  `option_env!("MODUS_UPDATER_PUBKEY")`. The `plugins.updater` block in `tauri.conf.json` is
  inert, and `bundle.createUpdaterArtifacts` is absent so it defaults to `false`. Configuring
  signing here does nothing for updates.
- **A valid signature is necessary, not sufficient.** A newly signed publisher can still draw
  SmartScreen warnings until reputation accumulates across installs.
