# Profiles — moved

User-owned profile state no longer lives in this directory. It was relocated
to `~/.modus/profiles/` so the repo (and any compiled distribution of the
harness) stays read-only at runtime, and personal data never gets committed.

## Where things live now

```
~/.modus/
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
boot, `rehydrateHome()` seeds any missing entries in `~/.modus/profiles/`
from those templates — user data is never overwritten.

## Canonical docs

See `harness/docs/profile-system.md` for the full profile schema reference and
`harness/modus-home.ts` for the single source of truth on `~/.modus/` paths.
