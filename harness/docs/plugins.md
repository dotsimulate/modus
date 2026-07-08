---
title: Plugins
lastUpdated: 2026-07-07
covers: harness/modus-plugins.ts harness/modus-home.ts harness/index.ts harness/move-runner.ts harness/action-runner.ts harness/pages.ts harness/client-extensions.ts
---

# Plugins

A plugin is any directory that contains a `.modus/` folder, registered
machine-wide. When enabled, its moves, actions, pages, and client extensions
are merged into every project's resolution. A plugin is effectively a
shareable `.modus`: publish a repo of capabilities, clone it anywhere,
register it once, and its contents are available across all projects.

Plugins are user-scoped, not project-scoped. Registration lives in
`~/.modus/plugins.json` (see `modus-home.ts`), never in the repo or a
project's `.modus/`.

## Registration

`~/.modus/plugins.json` shape:

```json
{
  "plugins": [
    { "id": "my-toolkit", "path": "~/plugins/my-toolkit", "enabled": true }
  ]
}
```

- `path` — plugin root (the directory containing `.modus/`). `~` expands to
  the home directory; paths are resolved absolute.
- `id` — normalized to lowercase kebab-case. Falls back to the manifest id,
  then the directory basename.
- `enabled` — defaults to true; disabled plugins are skipped everywhere.

Registration validates that the path exists and contains a `.modus/`
directory (`registerModusPlugin` in modus-plugins.ts).

### Manifest (optional)

A plugin may describe itself in `.modus/plugin.json`:

```json
{ "id": "my-toolkit", "name": "My Toolkit", "description": "What it provides" }
```

All fields optional. Registration values override manifest values.

## What Plugins Contribute

| Capability | Plugin dir | How it merges |
|------------|-----------|---------------|
| Moves | `.modus/moves/<name>/` | Resolution order: project → plugin → built-in (first match wins; see [Moves](./moves.md)) |
| Actions | `.modus/actions/<name>/` | Merged into the action scan after known project actions; plugin actions run with the plugin's own path as their project cwd and are tagged as project-origin runtime actions |
| Pages | `.modus/pages/<name>.json` | Scanned between project standalone pages and harness pages, tagged with origin `plugin` |
| Client extensions | `.modus/ui/extensions/` | Merged into extension discovery (see [Client Extensions](./client-extensions.md) for precedence) |

Plugin moves can ship their own `package.json`; dependencies install on first
activation, scoped to the move directory. This is what makes plugin-distributed
moves portable — see [Moves: Per-Move Dependencies](./moves.md).

## HTTP API

Defined in `harness/index.ts`:

- `GET /api/plugins` — list registrations (with manifest data)
- `POST /api/plugins` — register: `{ path, id?, name?, enabled? }`
- `PATCH /api/plugins/:id` — update: `{ enabled?, path?, name? }`
- `DELETE /api/plugins/:id` — unregister (does not delete files)

The `extensions` widget exposes plugin registration, enable/disable, and
unregister controls on top of these API routes.

## Trust

Plugin code runs with full harness privileges, exactly like project-local
moves and actions — registering a plugin is equivalent to adding its code to
every project. Only register sources you trust. Capability gating on
HarnessContext methods (builtin/reviewed/experimental trust) applies to plugin
moves and actions the same way it does to project-local ones.
