---
title: Release, Signing, and Packaging
audience: dev
lastUpdated: 2026-08-21
covers: desktop/stage-managed-backend.ts desktop/tests/packaged-lifecycle-smoke.ps1 desktop/src-tauri/tauri.conf.json desktop/src-tauri/tauri.windows.conf.json desktop/src-tauri/tauri.signing.conf.json desktop/src-tauri/src/updates.rs desktop/package.json .github/workflows/ci.yml .github/scripts/classify-ci-paths.ps1 desktop/cli-launcher/Cargo.toml
---

# Release, Signing, and Packaging

How a Modus desktop build is produced, signed, and qualified. The policy that
governs which builds may be published lives in `RELEASES.md` at the repository
root; the day-to-day build recipe and lifecycle detail live in
`desktop/README.md`; Windows signing has its own step-by-step in
`desktop/docs/windows-signing.md`. This document is the map, and it is the piece
that was missing from the agent-facing corpus — searching it for "installer",
"notarization", or "updater" used to return nothing.

Nothing here contains account identifiers, certificate values, or endpoints.
Every credential is supplied through the environment at build time and none is
committed, which is what makes the procedure publishable at all. If publishing a
step would leak something, the design is wrong rather than the documentation.

## Build commands

All from `desktop/`:

| Command | Produces |
|---|---|
| `bun run stage:backend` | staged resources only — the fastest way to prove a staging change |
| `bun run build` | host-path-sanitized `tauri build --no-bundle` — a runnable executable plus adjacent sidecar and resources |
| `bun run build:bundle` | host-path-sanitized Tauri build plus the platform package |
| `bun run build:signed` | the same wrapper merged with `src-tauri/tauri.signing.conf.json` |

Staging runs automatically as Tauri's `beforeBuildCommand`, so `stage:backend`
is not a required separate step before a build — it exists so staging can be
exercised on its own.

All three release build scripts run through `desktop/build-desktop.ts`. The
wrapper passes encoded `--remap-path-prefix` flags to Cargo so the executable
does not disclose the builder's checkout, Cargo home, Rustup home, or user-home
paths. It rejects lower-priority Rust flag environment variables instead of
silently overriding a custom build configuration.

For core UI work, use the source-development loop instead of rebuilding an
installer after every edit:

- `modus dev` from the checkout (or root `bun run dev`) starts the
  standalone Tauri app. Its `beforeDevCommand` stages the managed backend and
  starts Vite, so the native window, backend, and frontend share one command
  lifecycle. Frontend changes hot-reload; backend changes require a restart to
  restage the bundle.
- `modus dev --browser` keeps the browser-oriented harness available for work
  that explicitly does not need the native shell. It is local-only and never
  changes Tailscale Serve state.
- `bun run preview` from `harness/ui/` serves the most recent production UI
  build; it is not the normal product-development surface.

Development commands exercise the checkout. If the installed console launcher
wins command resolution, it delegates `dev`, `setup`, and `update` back to a
recognized checkout at or above the current directory. An installed application
remains the frozen staged snapshot described below; source edits do not hot-reload
into it.

**Check the artifact, not the exit code.** A pipeline that ends in `| tail`
reports the pipeline's status, not the build's, and a failed Tauri build has
been read as a success that way. Redirect to a log, check the exit code
explicitly, and confirm the artifact's size and mtime actually moved.

## What gets staged

`stage-managed-backend.ts` production-builds the UI, bundles the Bun server, and
copies the authored resource tree. Two consequences that produce failures no
test can see:

- **An installed build is a frozen snapshot.** Nothing in `harness/` reaches it
  without a rebuild. The one exception is client-extension `.js`, which is
  served from disk per request and therefore hot-swaps in place.
- **Bundling inlines JavaScript and leaves native artifacts behind.** Any
  dependency with a native binary is a staging risk: the JS compiles in and the
  `.dll`/`.so`/`.dylib` is silently absent at runtime. That class of failure is
  invisible to the build, the typechecks, and the suite, and is reached only by
  using the feature.

Staging handles the two current native cases explicitly: `bun-pty` contributes
its ConPTY library, and Pi's Photon image resizing contributes
`photon_rs_bg.wasm`. Bun also turns dependency-local `__dirname` values into
build-host paths, so staging rewrites the known Photon and resvg declarations
to the runtime resource directory and fails if a checkout or user-home path
survives in a JavaScript bundle.

`targetTriple()` resolves all six Windows/macOS/Linux x64 and arm64 triples and
gates the executable suffix, so staging itself is portable; it prefers
`TAURI_ENV_TARGET_TRIPLE` when Tauri supplies it.

## Notices and SBOM

`bun run notices:generate` (from `harness/`) rewrites three tracked files from the
installed dependency graph:

| File | What it is |
|---|---|
| `THIRD-PARTY-NOTICES.md` | every license the package redistributes, full text |
| `sbom.cdx.json` | the same inventory as CycloneDX 1.6 |
| `desktop/installer-license.txt` | what the installer's license page shows |

Scope is what ships, resolved for one target. npm covers the transitive closure of each
workspace's `dependencies`; cargo covers normal and build dependency kinds whose `cfg`
holds for the target. `devDependencies`, `dev` crate kinds, and crates that only apply to
another platform are excluded — target filtering is not cosmetic, it also keeps the output
deterministic, since a crate that never applies here is never unpacked into the local
registry and would otherwise resolve its license text differently per machine.

Drift is a red test, split by where the inputs live. `notices.test.ts` verifies the
JavaScript half in the Bun job; the Rust job runs `bun run notices:check rust`, because it
is the only job with a populated cargo registry. Each half is triggered by the paths that
can move it.

Two SBOMs exist and are not interchangeable. The committed one omits `serialNumber` and
`metadata.timestamp` so it can be drift-checked, which also means it cannot describe a
specific artifact. `bun run release:sbom` (from `desktop/`, after a bundle build) produces
the stamped one: source commit, toolchain versions, staged Bun version and digest, and a
SHA-256 per shipped file.

**A package whose only payload is a native binary ships nothing unless staging copies it
by name.** Bundling inlines JavaScript and leaves native artifacts behind, so
`harness/notices/not-redistributed.json` records the installed-but-unshipped packages with
the evidence for each. The largest is `@anthropic-ai/claude-agent-sdk-win32-x64` — 322 MB
of `claude.exe` that never enters the package, because the `claude-code` provider passes
`pathToClaudeCodeExecutable` pointing at the user's own Claude Code install.

## Platform targets

`bundle.targets` is **not** in `tauri.conf.json` — it is
`["nsis"]` in `tauri.windows.conf.json`, which Tauri merges only on Windows.
That separation is what makes a `.dmg` or an AppImage possible at all; a
`targets` key in the shared config would pin every platform to NSIS.

`bundle.macOS` is absent entirely: there is no `signingIdentity`,
`hardenedRuntime`, `entitlements`, `minimumSystemVersion`, or `dmg` block. A
macOS package is first contact, not a regression when it misbehaves.

The source CI workflow (`.github/workflows/ci.yml`) is a tree-coherence gate,
not package qualification. A green run does not authorize an installer.
Triggers:

- `push` to `main` — post-push alarm. It cannot stop the commit from landing.
  Publication-boundary, harness tests, and harness/UI typechecks always run.
  The production UI build and the desktop Rust job (src-tauri plus
  `desktop/cli-launcher`) run only when their inputs change. Changes under
  `.github/` fail toward running those extras.
- `pull_request` and `workflow_dispatch` — full job set. Use
  `workflow_dispatch` for a clean-runner source qualification.

**Verification jobs are `windows-latest`**, so no Linux or macOS build has ever
run in automation. Treat any non-Windows build result accordingly. The workflow
declares `contents: read` and references no secrets.

## Signing

Signing is **opt-in and additive**. `build:bundle` is unchanged and produces an
unsigned package; `build:signed` merges `tauri.signing.conf.json`, which sets
only `bundle.windows.signCommand` to invoke `sign-windows.cmd` with Tauri's
`%1` binary-path placeholder.

`signCommand` accepts a string or a `{cmd, args[]}` object. Use the object form
whenever a path may contain whitespace — the string form is split naively on
spaces. Read field names from the shipped
`desktop/node_modules/@tauri-apps/cli/config.schema.json` rather than from
memory.

`sign-windows.cmd` reads six environment variables and commits none of them:

| Variable | Supplies |
|---|---|
| `MODUS_SIGN_ENDPOINT` | the signing service region endpoint |
| `MODUS_SIGN_ACCOUNT` | the signing account name |
| `MODUS_SIGN_CERT_PROFILE` | the certificate profile name |
| `AZURE_TENANT_ID` | service-principal tenant |
| `AZURE_CLIENT_ID` | service-principal client |
| `AZURE_CLIENT_SECRET` | service-principal secret |

It refuses to run when any is missing, so a half-configured environment fails
loudly instead of emitting an unsigned artifact that looks signed.

`bundle.licenseFile` points at `desktop/installer-license.txt`, not at `LICENSE`. It used
to point at `LICENSE`, which showed a user Apache-2.0 alone as though that covered an
artifact embedding roughly a thousand third-party components. The generated file is the
Apache-2.0 text plus a pointer to the full notices, which ship beside the packaged server.

`bundle.publisher` is set and **must match the certificate subject**; a mismatch
surfaces as a wrong or untrusted name in the UAC prompt. Verify bundle metadata
by grepping the *generated* `target/release/nsis/x64/installer.nsi` — that file
is the real check, not the source config.

macOS notarization has no scaffolding in this repository. Note that a locally
built macOS app does not need a Developer ID to run: ad-hoc signing satisfies
the arm64 signature requirement, and Gatekeeper gates binaries carrying the
quarantine attribute, which the OS attaches on download. Distribution needs
notarization; local first-contact evidence does not.

## Updater

**The updater's real switch is compile-time.** `plugins.updater.pubkey` and
`plugins.updater.endpoints` in `tauri.conf.json` are present but empty and are
not what enables it. `updates.rs` reads `option_env!("MODUS_UPDATER_ENDPOINT")`
and `option_env!("MODUS_UPDATER_PUBKEY")` at build time and:

- returns "no updater configured" when **both** are empty;
- **errors** when only one is set — they must be configured together;
- rejects a non-HTTPS endpoint outright.

`bundle.createUpdaterArtifacts` is absent and therefore defaults to `false`, so
**no `.sig` or update artifact is emitted even with both variables compiled in.**
Installer signing and updater signing are two different signatures with two
different keys; having one does not give you the other.

Update checks are opt-in and at most daily unless the user picks *Check now*.
Release urgency changes presentation only — download and installation always
require confirmation.

## Qualification

A green suite proves the tree is coherent; it proves nothing about the package.
Run the isolated lifecycle smokes from `desktop/`, which use a temporary
`MODUS_HOME`, never bind the default port, and leave a running instance alone:

```powershell
.\tests\packaged-lifecycle-smoke.ps1 -Scenario managed
.\tests\packaged-lifecycle-smoke.ps1 -Scenario remote
.\tests\packaged-lifecycle-smoke.ps1 -Scenario close-hide
.\tests\packaged-lifecycle-smoke.ps1 -Scenario job-close
.\tests\packaged-lifecycle-smoke.ps1 -Scenario tailscale
.\tests\packaged-lifecycle-smoke.ps1 -Scenario two-vault
```

`two-vault` keeps Main in its isolated home, registers two unrelated named
folders outside that home, validates both markers, starts both through
autostart, and proves profile/secrets/database/runtime canaries do not cross
between either folder or Main. This smoke must not reconstruct a root from a
slug.

`job-close` is a Windows Job Object concept with no POSIX analogue, and there is
no `sh` equivalent of this script, so **macOS and Linux qualification is
currently manual.** A package for either platform must be built and
process-group-tested on that platform.

### Proving a build actually shipped a change

Exit code zero does not prove the change is in the artifact. Compare string
markers between the staged bundle and the currently installed one:

- Pick a marker that reaches the bundle you are grepping. Minified UI
  identifiers do not survive, and a project-local move is loaded from disk and
  is not in the server bundle at all — both give a false negative.
- **A removed literal or a genuinely novel identifier is the only strong
  signal.** A flag string can already appear in a vendored SDK, so a 1→2 count
  is weak evidence; a 1→0 removal is decisive.
- Always confirm a marker from the *previous* build still reads non-zero in the
  installed artifact, or you have only proven you grepped the wrong path.

Record the package's SHA-256 with each build, per `RELEASES.md`. Package
filenames are version-derived, so consecutive builds overwrite each other —
rename the existing artifact before rebuilding, or the rollback is gone.
