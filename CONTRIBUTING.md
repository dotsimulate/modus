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
provider integration testing. Then run the repository setup command:

```bash
bun run setup
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
bun install --cwd desktop --frozen-lockfile
```

The repository uses Bun lockfiles for every JavaScript package. Do not introduce
a second package-manager lockfile for the same manifest.

Run the native development product from the repository root:

```bash
modus dev
```

`bun run dev` is the checkout-bound fallback. Both launch Tauri, stage its managed
backend, and start Vite in one command lifecycle. The explicit browser-only escape
hatch is `modus dev --browser`.

If a dependency change intentionally updates a lockfile, explain why in the
pull request and include relevant audit results.

## Verification

Run checks proportionate to the change. The baseline CI commands are:

```bash
bun test
node harness/node_modules/typescript/bin/tsc -p harness/tsconfig.json --noEmit
node harness/ui/node_modules/typescript/bin/tsc -p harness/ui/tsconfig.app.json --noEmit
node harness/ui/node_modules/typescript/bin/tsc -p harness/ui/tsconfig.node.json --noEmit
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
cargo build --manifest-path desktop/cli-launcher/Cargo.toml --locked
bun run --cwd harness notices:check rust
```

Changing a dependency means regenerating the third-party notices, from `harness/`:

```bash
bun run notices:generate
```

That rewrites `THIRD-PARTY-NOTICES.md`, `sbom.cdx.json`, and
`desktop/installer-license.txt` from the installed dependency graph, so run it with all
four workspaces installed. `notices.test.ts` fails when the JavaScript half drifts and the
Rust job fails when the crate half does. If the generator throws because a package
publishes no usable license field, read its published license and record it in
`harness/notices/overrides.json` with the source — never drop the package to make the
build pass. See `harness/docs/third-party-notices.md`.

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

## Continuous integration

`.github/workflows/ci.yml` is a source-tree gate, not release qualification.
Packaging, signing, installer launch, upgrade/rollback, and platform
qualification remain separate; see [RELEASES.md](RELEASES.md).

On `main` pushes, CI is a post-push alarm: it cannot stop the commit from
landing. Pull requests and `workflow_dispatch` run the full job set. Push
alarms always run the publication-boundary check, harness tests, and harness
and UI typechecks. They skip the production UI build and the desktop Rust job
when those trees are untouched. Changes under `.github/` fail toward running
the extra checks.

Trigger a full clean-runner source qualification from Actions with
`workflow_dispatch`. The workflow is secret-free and uses read-only
`GITHUB_TOKEN` permissions.

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

By submitting a change, you confirm that you have the right to contribute it
under the repository `LICENSE` (FSL-1.1-ALv2, including its automatic Apache
2.0 future grant). There is no separate Contributor License Agreement.
