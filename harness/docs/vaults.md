---
title: Vaults
lastUpdated: 2026-08-19
covers: harness/app-paths.ts harness/modus-home.ts harness/vault-types.ts harness/vault-policy.ts harness/vault-registry.ts harness/vault-api.ts harness/cli-vault.ts harness/cli.ts harness/index.ts harness/secrets.ts harness/storage-migration.ts harness/sdk/client.ts harness/sdk/types.ts harness/ui/src/components/DesktopVaultManager.tsx harness/ui/src/desktopBridge.ts desktop/src-tauri/src/backend.rs desktop/src-tauri/src/main.rs desktop/src-tauri/src/vaults.rs
audience: dev
---

# Vaults

A named Vault is an independently chosen local folder and the process-level
data/configuration boundary for one Modus backend. Main owns its own existing
Modus home plus a registry of pointers to named folders. A Vault is not a user
profile, project, move instance, session, encrypted container, or OS sandbox.

## Identity and root handoff

`MODUS_INSTANCE=<slug>` is process identity. An unset value and the reserved
value `default` select Main. Slugs use letters, numbers, dots, underscores, and
hyphens; `.` and `..` are rejected. They canonicalize to lowercase, while the
optional registry `name` carries display casing.

A slug never determines a filesystem location. A trusted launcher must pass an
absolute `MODUS_VAULT_ROOT` for a named process. Starting a named process without
it is an error. For that process:

```text
APP_PATHS.modusHome == APP_PATHS.writableRoot == MODUS_VAULT_ROOT
```

Main's `MODUS_HOME` is not a fallback. The desktop and CLI also set
`MODUS_HOME` to the registered root in the named child environment. Global
`MODUS_DATA_DIR`, `MODUS_LOGS_DIR`, `MODUS_RUNTIME_DIR`, and `MODUS_CACHE_DIR`
values are removed by the launchers; a direct named process may supply an
override only when its resolved target is a strict descendant of the root.

All Modus-managed named material lives below the chosen folder:

```text
<VAULT_ROOT>/
  vault-manifest.json         versioned folder identity marker
  vault.json                  execution and egress policy
  profiles/                   agents, users, global config, UI state, prompt cache
  projects.json               this Vault's external project references
  plugins.json                this Vault's external plugin references
  providers/                  this Vault's declarative providers
  skills/                     this Vault's user skills
  secrets.env                 secrets and optional browser PIN
  data/                       SQLite databases and backend identity
  logs/                       backend/provider logs
  runtime/                    readiness, PID/port/token, supervisor state
  cache/                      disposable cache
  tmp/                        named-process temporary files
  history/                    workspace-history shadows and indexes
  checkpoints/                managed checkpoints
  modus-feedback.jsonl        Modus Brain feedback
```

Provider executables and their native authentication, explicitly registered
project folders, plugin folders, packaged read-only resources, and environment
variables deliberately supplied by the user remain external capabilities. That
does not permit a named process to read Main's profiles, projects, plugins,
skills, settings, secrets, databases, or runtime state.

A new root may independently receive shipped built-in profile templates during
rehydration. It never copies Main-authored configuration, and its project and
plugin registries start empty.

## Main registry and folder marker

Only Main owns `<MAIN_MODUS_HOME>/vaults.json`:

```ts
type VaultRegistryEntry = {
  slug: string;
  name?: string;
  root: string;          // canonical absolute folder pointer
  createdAt: number;
  autostart?: boolean;
  lastOpenedAt?: number;
};
```

The root must be outside Main's Modus home. Two slugs cannot point at the same
canonical folder. The implicit Main Vault has no row and appears as
`{ slug: null, name: "Main", root: <MAIN_MODUS_HOME> }` in Main listings.

Creating with mode `initialize` accepts only an empty folder, then writes a
versioned `vault-manifest.json` and deny-all `vault.json`. Mode `register`
accepts an existing folder only when its marker is valid and names the same
slug; it preserves the folder contents. A non-empty unmarked folder is refused.
Unregistering removes only the pointer row and never deletes the folder.

Registry mutation uses the cross-language `vaults.json.lock` protocol and a
same-directory temporary file followed by atomic replacement. Rust and
TypeScript canonicalize and validate the same schema.

### Legacy slug-only rows

An old row without `root` remains visible as `requiresRepair: true`, with
autostart disabled. It is never mapped to `<MAIN_MODUS_HOME>/<slug>`, started,
or silently migrated. The old folder is untouched. The user must choose a new
empty folder to initialize or an existing marked folder to register. Importing
old contents is a separate operation and is not implied by repair.

## Fail-closed policy

`<VAULT_ROOT>/vault.json` has three independently replaceable rules:

```json
{
  "plugins": { "mode": "deny", "allow": ["calendar"] },
  "projectAutomation": { "mode": "deny", "allow": ["D:/work/project"] },
  "channels": { "mode": "allow-all" }
}
```

A rule is `{ "mode": "allow-all" }` or
`{ "mode": "deny", "allow": [...] }`. Plugin entries are IDs, project entries
are normalized absolute folders referenced by this Vault, and channel entries
are names from this Vault's global config.

- Main without a policy preserves compatibility with allow-all.
- A named Vault without a policy is deny-all.
- An unreadable, malformed, or invalid policy is deny-all.
- Missing named-policy keys deny that capability; missing Main keys use Main's
  compatibility fallback.
- Reads are uncached, so revocation applies at the next enforcement check.

Policy gates plugin execution, project automation, and notification channels.
It does not terminate a run already in progress. Storage separation is broader
than this policy: named profiles, provider definitions, registries, and secrets
are root-local even though there is no per-provider allow-list rule.

## Desktop control plane

The desktop process owns named Vault list/create/register/repair/update/status
operations against Main's registry. The installed frontend calls narrow Tauri
commands through `desktopBridge.ts`; it does not send lifecycle operations to
whichever backend is currently viewed.

The form uses the native OS folder chooser, displays the absolute selection,
keeps the derived slug editable as identity, and requires an explicit choice:

- **Initialize an empty folder** creates the marker and deny-all policy.
- **Register an existing marked Vault** validates the marker without overwrite.

Legacy rows cannot open or autostart and show a folder-repair action. Opening a
valid stopped Vault starts its backend lazily. Closing the last window leaves
desktop-owned backends alive in the tray; full Quit stops them through the job
boundary. Named Vaults have no Tailscale Serve control; Main remains the sole
serve owner.

A named backend is data plane only. Its `/api/vaults` control-plane routes
return 403 and do not open Main's registry. Main's backend may keep the same
routes for non-desktop Main clients.

## API and SDK

Main exposes:

- `GET /api/vaults` — Main plus registered rows.
- `POST /api/vaults` — `{ slug, root, mode, name? }`.
- `POST /api/vaults/:slug/repair` — `{ root, mode, name? }` for a legacy row.
- `PATCH /api/vaults/:slug` — update `name` and/or `autostart`.
- `GET|PUT /api/vaults/:slug/policy` — read or replace the complete policy;
  slug `default` addresses Main.

The SDK mirrors these as `listVaults`,
`createVault(slug, root, mode, name?)`, `repairVault`, `updateVault`,
`getVaultPolicy`, and `setVaultPolicy`. Desktop lifecycle code uses the Tauri
bridge instead of these active-backend methods.

## CLI

The named CLI commands resolve an existing Main registry row:

```text
modus start --instance private
modus start -d --instance private
modus status --instance private
modus stop --instance private
modus logs --instance private
```

Unknown, legacy-invalid, missing-marker, and mismatched-marker Vaults fail with
an instruction to register or repair them. CLI start never creates a registry
row. Named state is root-local:

```text
<VAULT_ROOT>/runtime/harness.pid
<VAULT_ROOT>/runtime/harness.port
<VAULT_ROOT>/runtime/harness-token
<VAULT_ROOT>/secrets.env
<VAULT_ROOT>/logs/harness.log
```

Main retains its existing global CLI files and Tailscale behavior. Named starts
remain local-only and reject `--remote`. Legacy database migration is Main-only.

## Authoring identity

Server-side extensions inspect `ctx.vault.slug`; it is `null` for Main and the
canonical slug for a named process. The same identity reaches
`MoveApiContext.vault`, `MoveContext.harness.vault`, and `ActionContext.vault`.
It is not a move's `instanceId`.

## Not delivered yet

- Independent desktop windows for viewing multiple Vaults at once.
- Vault-aware deep links or multi-Vault remote/Tailscale presentation.
- Vault deletion, export, content import, or hard-delete semantics.
- Per-provider capability policy.

These missing surfaces do not weaken the delivered folder ownership boundary.
