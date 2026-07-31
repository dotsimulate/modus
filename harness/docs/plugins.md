---
title: Plugins
lastUpdated: 2026-07-30
covers: harness/modus-plugins.ts harness/plugin-settings.ts harness/profiles.ts harness/modus-home.ts harness/index.ts harness/move-runner.ts harness/action-runner.ts harness/pages.ts harness/client-extensions.ts harness/skills.ts harness/providers/provider-definitions.ts
---

# Plugins

A plugin is a directory containing `.modus/`, registered machine-wide. When
enabled, its profiles, moves, actions, pages, provider definitions, global config, and client
extensions merge into every project. Plugin registration is user-scoped and
lives in `~/.modus/plugins.json`; plugin content remains at its source path and
is never copied into a project.

## Registration

```json
{
  "plugins": [
    { "id": "my-toolkit", "path": "~/plugins/my-toolkit", "enabled": true }
  ]
}
```

- `path` is the plugin root. `~` expands and the path resolves absolute.
- `id` normalizes to lowercase kebab-case and is unique.
- `enabled` defaults to true; disabled plugins are skipped.
- `settings` is machine-wide storage for manifest fields scoped `global`.

Registration requires the path and its `.modus/` directory to exist.

## Manifest

`.modus/plugin.json` describes identity, public integration, settings, and
content semantics:

```json
{
  "id": "my-toolkit",
  "name": "My Toolkit",
  "description": "What it provides",
  "about": "ABOUT.md",
  "integration": {
    "agentProfiles": ["toolkit-reviewer"],
    "pages": ["toolkit"],
    "pageNav": "auto"
  },
  "settings": [
    { "key": "endpoint", "type": "string", "scope": "global" },
    { "key": "projects", "type": "project-list", "scope": "global" }
  ],
  "contents": {
    "profiles": { "mode": "merge" },
    "moves": { "mode": "merge" },
    "providers": { "mode": "merge" },
    "skills": { "mode": "merge" }
  }
}
```

`integration` is the public UI surface. Only listed profiles and pages appear
globally; unlisted profiles remain resolvable by plugin-local automation.
`about` points to a readable disclosure file inside the plugin root, with
`.modus/ABOUT.md` and `ABOUT.md` as fallbacks. Registration values override
manifest identity values. Plugin content supports merge semantics only.

## What plugins contribute

| Capability | Plugin path | Merge behavior |
|---|---|---|
| Agent profiles | `.modus/profiles/agents/<name>.json` | Qualified key `plugin:<id>/<name>`; manifest integration controls picker visibility only |
| Moves | `.modus/moves/<name>/` | Project → plugin → built-in |
| Actions | `.modus/actions/<name>/` | Project → plugin → built-in; plugin actions default to the plugin root and carry `origin: "plugin"` |
| Pages | `.modus/pages/<name>.json` | Manifest-listed pages scan between project and built-in pages |
| Provider definitions | `.modus/providers/<name>.json` | User-home definitions win plugin collisions; built-in names and aliases cannot be shadowed |
| Skills | `.modus/skills/<name>/SKILL.md` | Project → user home → plugin; shipping one is not the same as attaching it |
| Global config | `.modus/_global.json` | Merges after user-home config and before project config |
| Client extensions | `.modus/ui/extensions/` | Uses client-extension discovery and precedence |

Plugin moves may ship a `package.json`; dependencies install into the move
directory on first activation.

A shipped skill is instructions that can land in an agent's context, so a plugin
carrying skills ships *behavior*, not only capability. Consistent with disclosing
rather than capping plugin authority, `GET /api/plugins` reports each plugin's
`providedSkills` and the extensions panel lists them in the plugin's details.
Shipping a skill does not make it available — a profile, move, or action still
has to attach it by name. See `skills`.

Plugin profiles and actions can use `${pluginDir}` in path-bearing values.
Profiles expand it in `cwd`, `additionalDirectories`, and `cwdSuggestions`.
Actions expand it recursively in `cwd` and `inputs`. Every plugin profile also
receives the plugin root in `additionalDirectories`.

## Profile identity and automation

Profiles do not shadow one another. Their collision-free runtime keys are:

```
user:reviewer
project:reviewer
plugin:my-toolkit/reviewer
```

The UI keeps the clean label and adds a source marker. An unqualified reference
inside a plugin action checks that plugin first. A project reference checks the
project and then user home. Explicit qualification selects an exact source.

A missing action or mission profile logs `automation_profile_missing`, records
a warning on the automation run, and continues with session fallback defaults.

## Settings

Manifest field types are `string`, `number`, `toggle`, `select`,
`project-list`, and `secret-name`. Scope defaults to `user`.

| Scope | Storage |
|---|---|
| `user` | User-profile UI client-extension settings key `plugin:<id>` |
| `project` | `<cwd>/.modus/_global.json` under `pluginSettings.<id>` |
| `global` | Plugin registration in `~/.modus/plugins.json` |

`project-list` values must exist in the Modus project registry.
`secret-name` stores only a Modus secret identifier, never secret material.
Moves, actions, and plugin API handlers read resolved settings through
`ctx.pluginSettings.get(key)` and `ctx.pluginSettings.all()`.

Settings appear in the plugins widget and in the Plugins tab of user settings.

## HTTP API

- `GET /api/plugins`
- `POST /api/plugins` with `{ path, id?, name?, enabled? }`
- `PATCH /api/plugins/:id` with `{ enabled?, path?, name? }`
- `DELETE /api/plugins/:id`
- `GET /api/plugins/:id/settings?cwd=...&userProfile=...`
- `PATCH /api/plugins/:id/settings?cwd=...&userProfile=...`

The always-enabled `modus-core` entry describes the existing built-in resource
tier in place. It is inspectable but cannot be disabled or unregistered.

## Trust

Plugin code runs with full harness privileges, like project-local moves and
actions. Only register trusted sources. HarnessContext capability gating still
applies according to the plugin operation's effective trust level. Plugin
profiles are not permission-capped; the profile and its declared tools remain
visible in the session UI.
