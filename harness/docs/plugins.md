---
title: Plugins
lastUpdated: 2026-08-29
covers: harness/settings-schema.ts harness/modus-plugins.ts harness/plugin-settings.ts harness/profiles.ts harness/modus-home.ts harness/index.ts harness/move-runner.ts harness/action-runner.ts harness/pages.ts harness/conversation-lenses.ts harness/client-extensions.ts harness/skills.ts harness/providers/provider-definitions.ts
---

# Plugins

A plugin is a directory containing `.modus/`, registered in the current Vault.
When enabled, its profiles, moves, actions, pages, conversation lenses and
projections, provider definitions, global config, and client extensions merge
into every project registered in that Vault. Registration lives in
`<current-home>/plugins.json`, where
`<current-home>` is Main's Modus home or a named Vault's registered folder.
Plugin content remains at its external source path and is never copied into a
project. Named Vaults do not inherit Main's plugin registrations.

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
- `settings` is Vault-local storage for manifest fields scoped `global`.

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
    "lenses": ["toolkit:reader"],
    "projections": ["toolkit-contact-sheet"],
    "pageNav": "auto"
  },
  "settings": [
    { "key": "endpoint", "type": "string", "scope": "global" },
    { "key": "projects", "type": "project-list", "scope": "global" }
  ],
  "contents": {
    "profiles": { "mode": "merge" },
    "moves": { "mode": "merge" },
    "lenses": { "mode": "merge" },
    "projections": { "mode": "merge" },
    "providers": { "mode": "merge" },
    "skills": { "mode": "merge" }
  }
}
```

`integration` is the public UI surface. Only listed profiles, pages, lenses,
and projections appear globally; unlisted profiles remain resolvable by
plugin-local automation, while unlisted lens/projection files are not
discoverable at all.
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
| Conversation lenses | `.modus/lenses/<name>.json` | Manifest-listed lenses scan after project/Vault and before harness; see `conversation-lenses` |
| Conversation projections | `.modus/projections/<name>/projection.json` | Manifest-listed trusted-local components use the same precedence and fail closed for remote backends |
| Provider definitions | `.modus/providers/<name>.json` | Current-Vault definitions win plugin collisions; built-in names and aliases cannot be shadowed |
| Skills | `.modus/skills/<name>/SKILL.md` | Project → current Vault → plugin; shipping one is not the same as attaching it |
| Global config | `.modus/_global.json` | Merges after current-Vault config and before project config |
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
`project-list`, and `secret-name`. Scope defaults to `user`. The definition
shape is `PluginSettingDefinition` in `harness/settings-schema.ts`, the same
module the client-extension setting shape lives in.

A `number` field may declare `min`, `max`, and `step`. `min`/`max` are inclusive
and are enforced when the value is written, not just rendered — `PATCH
/api/plugins/:id/settings` rejects an out-of-range value the same way it rejects
a non-number. `step` sets the stepper's granularity in the form and never
rejects a value.

| Scope | Storage |
|---|---|
| `user` | User-profile UI client-extension settings key `plugin:<id>` |
| `project` | `<cwd>/.modus/_global.json` under `pluginSettings.<id>` |
| `global` | Plugin registration in `<current-home>/plugins.json` |
| `global`, for `modus-core` | `<current-home>/profiles/_global.json` under `pluginSettings.modus-core` |

The built-in `modus-core` tier is synthesized rather than registered, so it has
no `plugins.json` row to hold Vault-scoped values. Its global settings go to the
Vault's own `_global.json` under the same `pluginSettings` field that project
scope already uses, one layer up — per-Vault, and without a file or schema
invented for a single plugin.

Two setting types are pickers over live data rather than authored `options`,
because a model name written into shipped JSON is stale by the next release:

| Type | Renders | Extra fields |
|---|---|---|
| `provider` | Registered provider names | `oneShotOnly` — restrict to providers that can answer a one-shot completion without spawning a session |
| `model` | The provider's live model list | `providerSetting` — the sibling setting key holding the provider to list models for |

Both store a plain string. A `provider` value is validated on write against the
known providers, and against the one-shot list when `oneShotOnly` is set. A
`model` value is **not** checked against a live catalogue: that would cost a
network round trip per write and would reject a model the user can see in their
own picker whenever the provider is briefly unreachable.

`project-list` values must exist in the Modus project registry.
`secret-name` stores only a Modus secret identifier, never secret material.
Moves, actions, and plugin API handlers read resolved settings through
`ctx.pluginSettings.get(key)` and `ctx.pluginSettings.all()`.

Settings appear in the plugins widget and in the Plugins tab of user settings.

## Diagnostics and self-test

A plugin that reaches an external endpoint, loads a browser API, or depends on a
credential should ship a way for the user to ask "is this actually working?".
The harness has no diagnostics primitive, so this is an authoring convention
rather than an enforced contract — but the pieces it composes are real, and a
plugin that skips it leaves a packaged user with no signal at all, since release
builds have no devtools and `console.*` output goes nowhere they can see.

**Shape.** Expose diagnostics as ops on one of the plugin's moves and render
them from a move-owned page (`page` in `move.json`). A move reached only from a
page still needs `widget.mountOnAttach: true` and an `api` declaration, because
`attachMove` is the only thing that mints an API token and it hard-requires
both. Split the ops by who performs the check:

| Op | Runs in | Answers |
|---|---|---|
| `probe` | the browser | is the API present, is this a secure context, did the worklet/module load, what did the device actually negotiate |
| `selftest` | the handler, i.e. the harness host | does the endpoint answer, does the credential work, is the resolved config what the user thinks it is |

The split matters because the two runtimes disagree in ways that produce
identical-looking failures. The harness dials an endpoint from its own host, so
a loopback URL means the *backend's* loopback; the browser is a different origin
with different permissions. A check that runs in the wrong half will pass while
the real path is broken.

**Result shape.** A handler's return value reaches the caller verbatim —
`handleMoveApiSubmit` returns it unchanged and the route serializes it with
`c.json(result, result.ok ? 200 : 400)` — so a failing check arrives as HTTP 400
with the body intact. Return `{ ok, checks: [{ name, ok, detail, elapsedMs? }] }`
rather than a bare boolean: the point of a diagnostic is which step failed and
what it saw. Report the *resolved* value the plugin will actually use, not the
one the form holds.

**Redaction.** A diagnostic exists to be pasted into a bug report, so treat
everything it returns as public:

- Report a credential with `ctx.secrets.isSet(name)`, which answers configured
  or not without reading the value. Never call `ctx.secrets.resolve` to echo,
  prefix, or length-check a secret.
- Name the *setting* that supplies the credential (a `secret-name` value is an
  identifier and is safe), never the material it resolves to.
- Report an endpoint as scheme + host + path. Strip query strings and userinfo;
  an API key in a URL is the common way one leaks into a diagnostic.
- Echo an upstream error's status and reason, not its whole body — an
  authenticating proxy routinely reflects headers back.

**Ordering.** Run a probe *after* the authorization decision, never before. A
diagnostic request added at the top of a handler turns a "refuses and sends
nothing" guarantee into an unauthenticated request to the host you just refused.

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
