# Profiles — moved

User-owned profile state no longer lives in this directory. Main stores it in
`~/.modus/profiles/`; a named Vault stores it in `<registered-root>/profiles/`.
This keeps the repo and compiled distribution read-only at runtime.

## Where things live now

```
<current-home>/
├── profiles/
│   ├── agents/             ← agent profile definitions
│   ├── users/              ← user profile definitions
│   ├── ui/{agents,users}/  ← interface-specific UI sidecars
│   ├── state/              ← runtime UI state (app-managed)
│   ├── _global.json        ← shared MCP servers + provider defaults
│   ├── _users.json         ← template variable defaults
│   └── prompt-cache.json   ← provider prompt cache
├── projects.json           ← registry of known projects (was _projects.json)
└── history/                ← workspace-history shadow repos
```

Project-local overrides still live under `<project>/.modus/` unchanged.

## Shipped templates

Default agent templates ship in `harness/templates/profiles/agents/`. On first
boot, `rehydrateHome()` seeds missing entries in `<current-home>/profiles/`
from those templates. Only Main performs the one-time migration from this
legacy directory; a named Vault never imports it. Existing data is not overwritten.

## Canonical docs

See `harness/docs/profile-system.md` for the full profile schema reference and
`harness/modus-home.ts` for the single source of truth on current-home paths.
