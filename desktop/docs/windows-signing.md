# Windows code signing

Signing is **opt-in**. `npm run build:bundle` is unchanged and produces an unsigned
installer with no credentials present. `npm run build:signed` merges
`src-tauri/tauri.signing.conf.json`, which routes every artifact through
`src-tauri/sign-windows.cmd`.

Nothing account-specific is committed. The wrapper reads everything from the environment,
so the repository never contains an endpoint, an account name, a certificate profile, or a
credential.

---

## One-time setup

### 1. Install the signing tool

```powershell
cargo install trusted-signing-cli
```

Confirm it resolves:

```powershell
where.exe trusted-signing-cli
```

### 2. Create a service principal and grant it signing rights

In the Azure portal, for the Trusted Signing account:

1. **Microsoft Entra ID → App registrations → New registration.** Name it anything;
   single tenant is fine. Record the **Application (client) ID** and **Directory (tenant) ID**.
2. **Certificates & secrets → New client secret.** Record the **Value** immediately —
   it is shown once.
3. On the **Trusted Signing account → Access control (IAM) → Add role assignment**,
   grant that app registration the **Trusted Signing Certificate Profile Signer** role.
   Signing fails with an authorization error without this role, and that is the step
   most easily missed.

### 3. Collect the three account values

From the Trusted Signing account in the portal:

| Value | Where |
|---|---|
| Account endpoint URI | Account **Overview**, e.g. `https://eus.codesigning.azure.net` |
| Account name | Account **Overview** |
| Certificate profile name | **Certificate profiles** blade |

---

## Setting the credentials

Six variables. Set them in the shell you build from.

```powershell
$env:MODUS_SIGN_ENDPOINT     = "https://<region>.codesigning.azure.net"
$env:MODUS_SIGN_ACCOUNT      = "<trusted-signing-account-name>"
$env:MODUS_SIGN_CERT_PROFILE = "<certificate-profile-name>"
$env:AZURE_TENANT_ID         = "<directory-tenant-id>"
$env:AZURE_CLIENT_ID         = "<application-client-id>"
$env:AZURE_CLIENT_SECRET     = "<client-secret-value>"
```

To persist them for your user instead of one shell, use
`[Environment]::SetEnvironmentVariable("NAME", "value", "User")` for each and open a new
terminal.

**Do not put these in any file inside this repository.** There is no `.env` for them by
design — the wrapper reads the environment precisely so nothing has to be written down
where it could be committed.

---

## Building signed

```powershell
cd desktop
npm run build:signed
```

The wrapper **refuses to run** if any of the six variables is unset or if
`trusted-signing-cli` is not on PATH. That is deliberate: a signing step that silently does
nothing yields an unsigned installer that looks like a successful build, which is worse
than a failed one.

Before building, copy the existing installer to a descriptive name — the artifact filename
is version-derived, so consecutive builds overwrite it and it is your rollback:

```powershell
cd src-tauri\target\release\bundle\nsis
copy Modus_0.1.0_x64-setup.exe Modus_0.1.0_x64-setup-preSigning-<date>.exe
```

---

## Verifying the result

```powershell
Get-AuthenticodeSignature .\src-tauri\target\release\bundle\nsis\Modus_0.1.0_x64-setup.exe |
  Format-List Status, StatusMessage, SignerCertificate
```

`Status` must be `Valid`. Also check the signer's subject and that a timestamp is present —
a signature without one stops validating when the certificate expires. Trusted Signing
timestamps by default, so an absent timestamp means something is wrong.

Then confirm the UAC prompt: run the installer and check the publisher line reads
**dotsimulate** rather than "Unknown publisher".

---

## Things to know before the first attempt

- **`bundle.publisher` is set to `dotsimulate` in `tauri.conf.json`.** It should match the
  subject on your certificate. If Trusted Signing issued the certificate under a different
  legal name, change `publisher` to match — a mismatch between the manifest publisher and
  the certificate subject looks wrong in the UAC prompt.
- **Tauri signs every binary it bundles, not just the installer**, calling the wrapper once
  per artifact. Expect several `[sign]` lines. The bundled `bun.exe` sidecar is among them.
- **Signing the installer is not the same as signing an update.** The Tauri updater uses its
  own signature, and its real switch is compile-time: `updates.rs` reads
  `option_env!("MODUS_UPDATER_ENDPOINT")` and `option_env!("MODUS_UPDATER_PUBKEY")`. The
  `plugins.updater` block in `tauri.conf.json` is inert, and `bundle.createUpdaterArtifacts`
  is absent so it defaults to `false`. Configuring signing here does nothing for the updater.
- **Reputation is not instant.** A newly signed publisher can still draw a SmartScreen
  warning until enough installs accumulate. A valid signature is necessary, not sufficient.

---

## Status

The configuration, wrapper, and this guide are written and reviewed. **None of it has been
executed** — at the time of writing `trusted-signing-cli`, `az`, `signtool`, and
`AzureSignTool` were all absent from the build machine, and no credentials existed. The
first real run is the first test of this path.
