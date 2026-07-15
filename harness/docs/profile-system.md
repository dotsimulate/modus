---
title: Profile System
lastUpdated: 2026-07-07
lastCommit: a9adf68
covers: harness/modus-home.ts harness/profiles.ts harness/profile-schemas.ts harness/templates/profiles/
---

# Profile System

Profiles are the harness config layer. User-owned config and runtime state live
under `~/.modus/profiles/`. Project-local agent profiles live under
`<project>/.modus/profiles/agents/` and override user-home profiles of the same
name. Shipped templates live in `harness/templates/profiles/` and are seeded into
the user home on first boot; runtime code does not write profile state inside
the harness tree.

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
```

## Agent Profiles (`~/.modus/profiles/agents/*.json`)

Define how an agent behaves. Every field except `prompt` and `description` is optional.

```json
{
  "description": "One-line description for UI display and subagent selection",
  "prompt": "System prompt. Supports {{templateVars}} from _users.json / user profile.",
  "provider": "litellm",
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

**`provider`**: Execution backend. Registered providers are `"claude-code"`,
`"claude-code-pty"`, `"codex"`, `"cursor"`, `"antigravity"`, `"opencode"`,
`"litellm"`, `"ollama"`, and `"openrouter"`.

**`additionalDirectories`**: Extra workspace roots to grant alongside the primary cwd.
Passed to the Claude Agent SDK as `additionalDirectories`.

**`ui.panelWidgets`**: Widget types shown in the LeftPanel when this profile is active.

**`effort`**: Reasoning/thinking level. Values: `"off"`, `"low"`,
`"medium"`, `"high"`, `"xhigh"`, `"max"`. Provider-specific normalization
lives in each provider.

**`promptMode`**: `"append"` layers your prompt on top of PI's default system prompt.
`"custom"` replaces it entirely — you own the whole prompt.

**`loadProjectSettings`**: Whether to load `CLAUDE.md` files from the working directory.

**`tools`**: Allowlist of tool names. Omit to inherit all available tools for the provider.
Tool names differ between providers — see `docs/pi-agent-system.md` § Tool Namespaces.

**`compaction`**: Override compaction thresholds per-agent. See `docs/config-resolution.md`.

**`permissionPolicy`**: `"bypass"` (no checks), `"ask"` (approve every tool call),
or an object with `autoApprove`/`requireApproval` lists for granular control.

**`providerControls.antigravity`**: Optional documented Antigravity headless
flags: `{ "mode": "accept-edits" | "plan", "sandbox": boolean,
"printTimeout": "1h" }`.

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

**`agentProfiles`**: Which agent profiles appear in the UI sidebar. Omit for all.

**`projects`**: Working directories available in the CWD picker.

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
