---
title: Vaults
lastUpdated: 2026-08-19
covers: harness/app-paths.ts harness/modus-home.ts harness/vault-types.ts harness/vault-policy.ts harness/vault-registry.ts harness/vault-api.ts harness/cli-vault.ts harness/cli.ts harness/index.ts harness/harness-context.ts harness/modus-plugins.ts harness/action-runner.ts harness/notify.ts harness/sdk/client.ts harness/sdk/types.ts harness/ui/src/components/DesktopVaultManager.tsx harness/ui/src/vault-targets.ts desktop/src-tauri/src/backend.rs
audience: dev
---

# Vaults

A Vault is the process-level data and capability boundary for one Modus backend.
It isolates durable runtime data while keeping machine-authored configuration
available for reuse. A Vault is not a user profile, project, move instance, or
session.

## Identity and paths

`MODUS_INSTANCE=<slug>` selects a named Vault. An unset value and the reserved
value `default` both select the implicit default Vault. Slugs may contain only
letters, numbers, dots, underscores, and hyphens; `.` and `..` are rejected.
Identity is canonical lowercase before any path, registry, CLI-state, API, or
desktop-supervisor derivation. `Private`, `PRIVATE`, and `private` therefore
name the same Vault, while display casing belongs in the optional registry
`name`. The reserved `default` name is also case-insensitive.

`AppPaths.writableRoot` is `MODUS_HOME` for the default Vault and
`<MODUS_HOME>/<slug>` for a named Vault. These paths are Vault-scoped:

```
<writableRoot>/
  vault.json       execution and egress policy
  data/            harness, activity, terminal, alert, and identity databases
  logs/            backend and desktop logs
  runtime/         ready and supervisor records
  cache/           disposable runtime cache
  history/         workspace-history shadow repositories and indexes
  checkpoints/     managed checkpoints
```

The system temp root is also scoped as `<temp>/modus/<slug-or-default>`.
`MODUS_DATA_DIR`, `MODUS_LOGS_DIR`, `MODUS_RUNTIME_DIR`, and `MODUS_CACHE_DIR`
override those four resolved roots after Vault selection; they do not relocate
`vault.json`, history, or checkpoints.

Machine-authored configuration remains shared under `MODUS_HOME`: profiles,
skills, `plugins.json`, `projects.json`, and `vaults.json`. Plugin registration
is therefore shared, while plugin execution is filtered by each Vault's policy.
The default secrets file is also shared and lives outside `MODUS_HOME` at
`~/.config/agent-dev-zone/secrets.env` unless `HARNESS_SECRETS_FILE` overrides
it. Vaults are not a credential-isolation boundary.

## Registry

`<MODUS_HOME>/vaults.json` contains named Vault metadata:

```ts
type VaultRegistryEntry = {
  slug: string;
  name?: string;
  createdAt: number;
  autostart?: boolean;
  lastOpenedAt?: number;
};
```

The implicit default Vault has no registry row and is represented by
`{ slug: null }` in API listings. A malformed registry is treated as empty and
logged rather than failing backend import. Registry removal is an internal
metadata operation only; it never removes a Vault directory or its data. No
public deletion API or deletion semantics exist yet.

Registry mutations serialize across backend and CLI processes through
`vaults.json.lock`. A bounded stale-lock recovery prevents a crashed writer
from parking the registry permanently, and each completed mutation publishes a
same-directory temporary file with an atomic rename. Lock-free readers therefore
see the complete old or new registry, never an in-place partial write.

Creating through `POST /api/vaults` registers the row and writes an explicit
deny-all policy. Starting an unregistered slug through the CLI registers it
with `autostart: false`; if no policy file exists, the named-Vault fallback is
still deny-all.

## Fail-closed policy

`<writableRoot>/vault.json` has three independently replaceable rules:

```json
{
  "plugins": { "mode": "deny", "allow": ["calendar"] },
  "projectAutomation": { "mode": "deny", "allow": ["D:/work/project"] },
  "channels": { "mode": "allow-all" }
}
```

A rule is either `{ "mode": "allow-all" }` or
`{ "mode": "deny", "allow": [...] }`. Plugin values are registered plugin
IDs, project-automation values are normalized absolute working directories,
and channel values are configured channel names.

Policy resolution is deliberately asymmetric:

- A missing default-Vault file preserves compatibility with allow-all.
- A missing named-Vault file is deny-all.
- An unreadable, malformed, or invalid file is deny-all for every Vault.
- A missing key in a partial named policy is deny for that key; a partial
  default policy uses the default-Vault allow fallback.
- Unknown keys are ignored for forward compatibility.
- Policy reads are uncached, so an authored edit applies on the next check.

The policy is enforced at shared chokepoints. `plugins` filters enabled plugin
discovery and execution lookup without hiding machine registration management.
`projectAutomation` filters project action directories before discovery.
Loaded project and plugin actions are also filtered from runtime lookup and
rechecked at the common dispatch boundary, so an allow-to-deny edit blocks the
next manual, interval, webhook, chain, or session trigger without a reload.
Policy revocation does not terminate an action run that has already begun.
`channels` gates name resolution used by direct sends and both action
notification paths. This version has no per-Vault provider or credential rule.

## API and SDK

The backend exposes:

- `GET /api/vaults` — current slug plus implicit default and registered rows.
- `POST /api/vaults` — create `{ slug, name? }` with deny-all policy.
- `PATCH /api/vaults/:slug` — update `name` and/or `autostart`.
- `GET /api/vaults/:slug/policy` — read policy; use slug `default` for the
  implicit Vault.
- `PUT /api/vaults/:slug/policy` — replace the complete policy. All three
  current keys are required; partial API writes are rejected.

The TypeScript SDK mirrors these as `listVaults`, `createVault`, `updateVault`,
`getVaultPolicy`, and `setVaultPolicy`.
Slug inputs on these routes are case-insensitive and responses carry the
canonical lowercase identity.

## CLI

Start, inspect, and stop a named headless backend with:

```text
modus start --instance private
modus start -d --instance private
modus status --instance private
modus stop --instance private
```

`--instance default` targets the unchanged default filenames and data roots.
Named CLI state uses
`~/.config/agent-dev-zone/harness.<slug>.pid` and `.port`; the default keeps
`harness.pid` and `harness.port`. When `HARNESS_PORT` is unset and the base port
is occupied by another Modus backend, a named start scans the existing nearby
port range and records the selected port in its scoped file.
Named daemon stdout is written to `<writableRoot>/logs/harness.log`; read it
with `modus logs --instance <slug>`. The implicit default keeps its existing
CLI log location.

Named CLI Vaults are local-only in this version. `--remote` is rejected for a
named Vault, and named start/stop lifecycles never replace or clear the default
Vault's single Tailscale serve rule.

## Desktop lifecycle and switching

The desktop presents the implicit default Vault as **Main**. To create or switch
Vaults in an installed app, click the **Vault · Main** identity badge in the
bottom status bar. This opens the existing **Modus backend** selector, whose
**Local Vaults** section lists Main and every registered named Vault. The list
distinguishes the Vault being viewed, backends currently running under the
desktop supervisor, and named Vaults configured to autostart.

Under **Create restricted Vault**, enter a human-readable name, review or edit
the derived canonical slug, then choose **create, start, and enter**. Opening a
stopped Vault starts its backend lazily; `autostart: true` starts it when the
desktop launches. Closing the last window keeps desktop-owned backends alive in
the tray, while full Quit stops all of them through the process job boundary.

Creating a named Vault in the desktop derives an editable canonical slug, writes
the explicit deny-all policy, starts the new backend, and switches the current
window into it. The selector shows the actual policy receipt and the absolute,
deterministic `data/harness.db` path in local details. This path is not secret,
encrypted, or a custom storage choice. There is deliberately no deletion or
partial policy editor in this surface.

Each Vault remembers the last hash-route visited in the current window. A switch
restores that location when available and otherwise opens the Vault's home. The
target identity travels in the window URL through `modusVault` plus the existing
`modusTarget*` parameters. The preferred target and per-Vault location are also
remembered as client preferences. Named Vaults have no Tailscale Serve control. Main remains
the desktop's only serve owner.

## Authoring identity

Server-side extension code can inspect `ctx.vault.slug`; it is `null` for the
implicit default and the named slug otherwise. The same identity reaches
`MoveApiContext.vault`, `MoveContext.harness.vault`, and `ActionContext.vault`.
Do not confuse it with a move's `instanceId`, which identifies one API move
instance inside a Vault.

## Not delivered yet

- Independent desktop windows for viewing multiple Vaults at once.
- Vault-aware deep links, remote Vault routing, or multi-Vault Tailscale presentation.
- Alert-policy routing across Vaults.
- Vault deletion, export, or hard-delete semantics.
- Per-Vault provider and credential policy.

The registry, policy APIs, and delivered switch-in-place desktop lifecycle are
foundation for these remaining surfaces; they do not imply the items above are
already available.
