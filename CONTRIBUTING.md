# Contributing to Modus

Modus is an early, local-first power-user project. Contributions are welcome,
but the public API, authored primitives, desktop lifecycle, and security model
are still evolving. Please keep changes focused and describe compatibility or
migration consequences explicitly.

## Before opening an issue or pull request

- Use [SUPPORT.md](SUPPORT.md) to choose the right reporting channel.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Remove credentials, tokens, private hostnames, Tailnet names, usernames,
  personal paths, project names, session content, and database contents from
  logs, screenshots, fixtures, and examples.
- Search existing issues before filing a duplicate.

## Development setup

Install [Bun](https://bun.sh/) and at least one provider CLI if the change needs
provider integration testing. Then use the platform setup command from the
[README](README.md):

```bash
./modus.sh setup
```

```powershell
.\modus.bat setup
```

The backend is under `harness/`, the React frontend is under
`harness/ui/`, and the Tauri desktop shell is under `desktop/`. Start with
[the architecture guide](harness/docs/architecture.md) and follow its links to
the subsystem being changed.

Harness tests live under `harness/tests/`, grouped by subsystem. Run `bun test`
from `harness/` so discovery matches CI and does not collect staged desktop copies.

## Dependency installs

The committed lockfiles are release inputs. Do not refresh them incidentally.
For a verification-only install, use:

```bash
bun install --frozen-lockfile
bun install --cwd harness --frozen-lockfile
bun install --cwd harness/ui --frozen-lockfile
npm --prefix desktop ci
```

If a dependency change intentionally updates a lockfile, explain why in the
pull request and include relevant audit results.

## Verification

Run checks proportionate to the change. The baseline CI commands are:

```bash
bun test
bun x tsc -p harness/tsconfig.json --noEmit
bun x tsc -p harness/ui/tsconfig.app.json --noEmit
bun x tsc -p harness/ui/tsconfig.node.json --noEmit
bun run --cwd harness/ui build
```

For desktop changes:

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked
cargo build --manifest-path desktop/src-tauri/Cargo.toml --locked
cargo fmt --manifest-path desktop/cli-launcher/Cargo.toml --check
cargo clippy --manifest-path desktop/cli-launcher/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path desktop/cli-launcher/Cargo.toml --locked
```

Run the publication-boundary check before requesting review:

```powershell
.\.github\scripts\check-publication-boundary.ps1
```

Tests must use isolated `MODUS_HOME`, data, configuration, runtime, log, and
cache directories, plus an isolated `HARNESS_SECRETS_FILE`. Do not use a real
user database, stop an existing daemon, or modify real Tailscale Serve
configuration. Desktop lifecycle automation must use dynamic ports and the
fake-Tailscale packaged smoke harness.

The UI currently has known historical lint debt, so lint is not yet a required
baseline gate. New or modified code should nevertheless avoid introducing new
lint failures; a clean enforced baseline remains release-readiness work.

## Trust and security expectations

Moves, actions, plugins, MCP servers, provider CLIs, and project-local `.modus`
code are intentionally trusted local code. Contributions must not describe
these extension surfaces as sandboxes. Security-sensitive changes should state:

- which principal or content source is trusted;
- where authentication and authorization occur;
- what files, processes, credentials, native commands, and network targets are
  reachable;
- expected failure and cleanup behavior; and
- positive and negative tests for the boundary.

Remote backends, browser clients, provider/model output, imported content, and
downloaded packages must not silently acquire trusted-local-code authority.

## Pull requests

Keep pull requests reviewable and avoid combining unrelated refactors with
security, migration, or release changes. Include user-visible behavior,
evidence from tests, skipped checks with reasons, data migration/rollback
considerations, and platform limitations.

Do not commit generated runtime state, local TODO material, profiles, databases,
logs, credentials, build output, or personal examples. Do not attach installer
or release artifacts to a pull request unless a maintainer explicitly requests
them through a protected release process.

The project has not yet adopted a Contributor License Agreement or Developer
Certificate of Origin requirement. Any future attestation policy will be an
explicit maintainer decision and documented before enforcement.
