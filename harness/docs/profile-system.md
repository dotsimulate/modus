---
title: Profile System
lastUpdated: 2026-08-17
lastCommit: a9adf68
covers: harness/modus-home.ts harness/profiles.ts harness/profile-schemas.ts harness/templates/profiles/ harness/skills.ts harness/app-paths.ts
---

# Profile System

Profiles are the harness config layer. User-owned config and runtime state live
under `~/.modus/profiles/`. Project-local profiles live under
`<project>/.modus/profiles/agents/`, and plugin profiles live under
`<plugin>/.modus/profiles/agents/`. Same-named profiles coexist under qualified
runtime identities instead of shadowing one another.

The entire profile tree, including `profiles/state/`, is machine-shared across
Vaults. A Vault scopes backend data and capability enablement; it does not copy
or select a separate profile catalog. See [Vaults](./vaults.md).

## Directory Structure

```
~/.modus/profiles/
  _global.json          Shared config: MCP servers, provider defaults
  _users.json           Template variable defaults (name, stack, etc.)
  agents/               Agent profile definitions
    dev-agent.json
    creative.json
    web-ui.json
    ...
  users/                User profile definitions (scoped views)
    harness-dev.json
    3d-printing.json
  ui/
    agents/             Agent UI sidecars
    users/              User UI sidecars
  state/                Runtime UI state (gitignored, app-managed)
    harness-dev.json

<project>/.modus/
  profiles/agents/      Project-local agent profiles
  ui/profiles/agents/   Project-local agent UI sidecars

<plugin>/.modus/
  profiles/agents/      Plugin-merged agent profiles
  ui/profiles/agents/   Read-only plugin profile UI sidecars
```

## Identity and Resolution

The API and session runtime use collision-free keys:

- `user:<name>`
- `project:<name>`
- `plugin:<plugin-id>/<name>`

Picker labels remain clean and display a source marker. A plugin manifest's
`integration.agentProfiles` list controls picker visibility only; other
plugin-shipped profiles still resolve for that plugin's automation.

An unqualified plugin action reference checks its own plugin first. An
unqualified project reference checks project then user. Explicit qualified keys
select an exact source. Legacy unqualified user/project preferences remain
accepted by the UI.

Plugin profiles may use `${pluginDir}` in `cwd`, `additionalDirectories`, and
`cwdSuggestions`. The plugin root is automatically appended to
`additionalDirectories`.

## Agent Profiles (`~/.modus/profiles/agents/*.json`)

Define how an agent behaves. Every field except `prompt` and `description` is optional.

```json
{
  "description": "One-line description for UI display and subagent selection",
  "prompt": "System prompt. Supports {{templateVars}} from _users.json / user profile.",
  "provider": "openai-compat",
  "model": "glm-4.7-flash",
  "promptMode": "append",
  "loadProjectSettings": true,
  "effort": "low",
  "maxTurns": 30,
  "additionalDirectories": ["/home/alex/shared-notes"],
  "tools": ["Read", "Edit", "Bash"],
  "contextWindow": 65536,
  "maxOutputTokens": 2048,
  "compaction": { "enabled": true, "reserveTokens": 16384 },
  "mcpServers": { ... },
  "permissionPolicy": "bypass",
  "ui": { "showThinking": true, "placeholder": "Ask me anything...", "panelWidgets": ["session-info"] }
}
```

### Key Fields

**`provider`**: Execution backend. The built-ins are `"claude-code"`,
`"claude-code-pty"`, `"codex"`, `"cursor"`,
`"grok-build"`, `"opencode"`, `"openai-compat"`, `"ollama"`, and
`"openrouter"`. User-global and plugin declarative providers extend this set at
runtime. Legacy `"litellm"` remains accepted as an alias of
`"openai-compat"`. `"antigravity"` and `"gemini-cli"` are also valid here but do
not appear in any picker — see `providers.md` § Hidden providers.

**`cwd`**: Pins the profile to a fixed working directory. Any agent profile may
set it, not just plugin profiles — it is a plain optional string
(`profile-schemas.ts`). A session started from this profile opens in that
directory regardless of which project is active, so a user-global profile in
`~/.modus/profiles/agents/` can always target one checkout. Omit it and the
session uses the active project's directory, which is what most profiles want.
Plugin profiles may additionally use `${pluginDir}` here; see Identity and
Resolution above.

**`additionalDirectories`**: Extra workspace roots to grant alongside the
primary cwd. All current providers consume them. PI-backed providers advertise
absolute extra roots in the system prompt and coding-tool descriptions; their
bash tool keeps PI's existing unrestricted behavior.

**`ui.panelWidgets`**: Widget types shown in the LeftPanel when this profile is active.

**`effort`**: Reasoning/thinking level. Values: `"off"`, `"low"`,
`"medium"`, `"high"`, `"xhigh"`, `"max"`. Provider-specific normalization
lives in each provider.

**`promptMode`**: `"append"` layers your prompt on top of PI's default system prompt.
`"custom"` replaces it entirely — you own the whole prompt.

**`loadProjectSettings`**: Whether to load `CLAUDE.md` files from the working directory.

**`env`**: Provider-specific process environment, not a universal endpoint
override. The Claude Code SDK and Grok Build providers consume it today; other
CLI providers ignore it. PI providers run in-process and instead use
declarative provider `baseUrl`, `apiKeyName`, `headers`, and Modus secrets.

**`tools`**: Allowlist of tool names. Omit to inherit all available tools for the provider.
Tool names differ between providers — see `docs/pi-agent-system.md` § Tool Namespaces.

**`compaction`**: Override compaction thresholds per-agent. See `docs/config-resolution.md`.

**`permissionPolicy`**: `"bypass"` (no checks), `"ask"` (approve every tool call),
or an object with `autoApprove`/`requireApproval` lists for granular control.

**`providerControls.antigravity`**: Optional documented Antigravity headless
flags: `{ "mode": "accept-edits" | "plan", "sandbox": boolean,
"printTimeout": "1h" }`.

**`providerControls.grokBuild`**: Optional Grok Build ACP controls. `mode` may
be `"default"`, `"auto"`, `"plan"`, or `"always-approve"`; `sandbox` names a
Grok sandbox profile. `noMemory`, `noSubagents`, and `disableWebSearch` disable
their corresponding Grok features. Launch-affecting changes apply on the next
turn by restarting the ACP child and loading the same Grok session.

**`skills`**: `string[]` of installed skill names to attach for the whole
session. Resolved from `<project>/.modus/skills/`, `~/.modus/skills/`, and
enabled plugins, most specific first. Installing a skill does not make it
available — this field (or a move/action) is what makes it reachable. Names that
resolve to nothing are logged and skipped, never fatal. Skills bundled inside a
move listed in `moves` come along transitively. See [Skills](./skills.md).

## User Profiles (`~/.modus/profiles/users/*.json`)

Scoped views of the harness. Filter which projects and agent profiles a user sees.

```json
{
  "displayName": "alex",
  "templateVars": { "stack": "TypeScript, Bun, Hono, React" },
  "projects": ["/home/alex/projects/webapp"],
  "agentProfiles": ["dev-agent", "web-ui", "research"],
  "showAllProjectPaths": true,
  "provider": "claude-code",
  "model": "claude-opus-4-6",
  "effort": "low"
}
```

**`provider`** / **`model`** / **`effort`**: User-level defaults. Used when no session
override or agent profile value is set. `effort` accepts the same values as agent profiles
(`"off"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`).

**`templateVars`**: Merged with `_users.json` defaults. Available as `{{key}}` in
agent prompts. Use for user name, preferred stack, editor, etc.

**`clientExtensions`**: Per-user `paths/enabled/disabled` config merged with global and
project layers. See `docs/client-extensions.md`.

**`agentProfiles`**: Which user-home agent profiles appear in the UI sidebar.
Project profiles always appear. Manifest-integrated plugin profiles appear
unless their qualified key is in `hiddenPluginProfiles`.

**`projects`**: Working directories available in the CWD picker.

**`interface`**: Chat and conversation display, written by the in-app settings
rather than by hand. Resolved in `harness/ui/src/interface-settings.ts`, which
also holds the defaults.

```json
{
  "interface": {
    "chat": { "fontScale": 100, "chatWidth": 840, "spineEnabled": true },
    "conversation": {
      "showThinking": true,
      "showMeta": true,
      "toolCalls": "collapsed",
      "showGitEvents": false,
      "showFileChanges": true,
      "deferHeavyDetails": true
    },
    "configBar": { "items": ["profile", "model", "tools", "controls", "effort", "context", "overrides"] },
    "motion": "system"
  }
}
```

`conversation.showMeta` controls the per-message stats row (model, cost, tokens,
context %, timing).

`conversation.toolCalls` governs how tool calls render. In `"collapsed"` a run of
five or more consecutive calls on a *completed* turn folds into one header
showing the count and a per-tool tally; the streaming turn stays flat so work in
progress is still visible. `"expanded"` opts out of grouping entirely and
`"hidden"` suppresses tool calls.

`conversation.deferHeavyDetails` (default `true`) lets the harness withhold a
turn's thinking and tool payload when it exceeds ~32KB, sending a placeholder the
client expands on demand. Lighter turns always travel whole, so they render
identically to how they rendered live. Turning it off requests complete history
up front — reasonable on a local-first install, where the cost is browser memory
rather than bandwidth.

`configBar.items` selects which readouts the bar above the composer shows; the available ids are `profile`, `model`, `tools`, `controls`,
`effort`, `context`, `cost`, `tokens`, `overrides`, and unknown ids are ignored.
Omitting `items` uses the defaults — an explicit `[]` means show nothing. The
Claude permission-mode badge is not selectable: it only appears in a non-default
permission mode and is a safety signal.

Context percentage comes from the provider's `result` event, so it only appears
for providers that report it (the Claude and PI families). Others omit the
readout rather than showing an estimate.

**`dashboard`**: Optional layout config. `widgets?: Array<{type, ...}>` is the legacy flat list. `pages?: Array<{id, title, blocks[]}>` adds named pages; each block is one of:
- `{ kind: "widget", widget: { type, ... } }` — embeds a widget
- `{ kind: "module", module: "memory" | "actions" | "git" }` — embeds a built-in module
- `{ kind: "text", markdown: string }` — static markdown

## Global Config (`~/.modus/profiles/_global.json`)

Three purposes:

1. **MCP servers** — merged into every session (agent profiles can add more).
2. **Provider defaults** — per-provider fallbacks for `contextWindow`, `maxOutputTokens`,
   and `compaction`. See `docs/config-resolution.md` for the full resolution chain.
3. **Client extensions** — `clientExtensions.paths/enabled/disabled` configures
   global browser-side extension roots. See `docs/client-extensions.md`.
4. **Notification channels** — `notificationChannels` defines named webhook or file
   channels used by action notifications.
5. **Plugin settings** — project-scoped values live under
   `pluginSettings.<plugin-id>`.

## Template Variables (`_users.json`)

Flat key-value defaults. User profiles can override per-user.

```json
{ "name": "alex", "stack": "TypeScript, Bun, Hono, React" }
```

Referenced in agent prompts as `{{name}}`, `{{stack}}`, etc.

## Runtime State (`~/.modus/profiles/state/`)

Stores transient UI state per user profile — sidebar collapse state, last
selected agent, last CWD, last session ID. Managed by the app, not edited by
hand.

## Type Definitions

All types live in `profiles.ts`:
- `Profile` — agent profile shape
- `UserProfile` — user profile shape
- `GlobalConfig` — `_global.json` shape
- `CompactionConfig` — compaction tuning fields
- `ProviderDefaults` — per-provider defaults (contextWindow, maxOutputTokens, compaction)
- `PermissionPolicy` — tool execution gating
- `McpServerConfig` — MCP server connection config

Schema validation (for the API) lives in `profile-schemas.ts` using Zod.
