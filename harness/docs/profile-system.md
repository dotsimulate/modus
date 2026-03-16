---
title: Profile System
audience: agents
lastUpdated: 2026-03-16
lastCommit: a9adf68
covers: harness/profiles/ harness/profile-schemas.ts harness/profiles.ts
---

# Profile System

Profiles are the harness config layer. Everything is JSON files in `harness/profiles/`.
No database, no admin UI — edit the files directly.

## Directory Structure

```
profiles/
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
  state/                Runtime UI state (gitignored, app-managed)
    harness-dev.json
```

## Agent Profiles (`profiles/agents/*.json`)

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
  "additionalDirectories": ["/home/dot/shared-notes"],
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

**`provider`**: Execution backend. `"claude-code"` uses the Claude Agent SDK.
Everything else (`"anthropic"`, `"openai"`, `"litellm"`, `"ollama"`, `"openrouter"`) uses PI AgentSession.

**`additionalDirectories`**: Extra workspace roots to grant alongside the primary cwd.
Passed to the Claude Agent SDK as `additionalDirectories`.

**`ui.panelWidgets`**: Widget types shown in the LeftPanel when this profile is active.

**`effort`**: Reasoning/thinking level. Values: `"off"` (disables thinking), `"low"`, `"medium"`, `"high"`, `"max"`. Provider-specific: claude-code maps `"off"` to no thinking; codex maps `"off"`/`"max"` to no reasoning effort.

**`promptMode`**: `"append"` layers your prompt on top of PI's default system prompt.
`"custom"` replaces it entirely — you own the whole prompt.

**`loadProjectSettings`**: Whether to load `CLAUDE.md` files from the working directory.

**`tools`**: Allowlist of tool names. Omit to inherit all available tools for the provider.
Tool names differ between providers — see `docs/pi-agent-system.md` § Tool Namespaces.

**`compaction`**: Override compaction thresholds per-agent. See `docs/config-resolution.md`.

**`permissionPolicy`**: `"bypass"` (no checks), `"ask"` (approve every tool call),
or an object with `autoApprove`/`requireApproval` lists for granular control.

## User Profiles (`profiles/users/*.json`)

Scoped views of the harness. Filter which projects, agents, and schedules a user sees.

```json
{
  "displayName": "dot",
  "templateVars": { "stack": "TypeScript, Bun, Hono, React" },
  "projects": ["/home/dot/dev/infra/agent_dev_zone"],
  "agentProfiles": ["dev-agent", "web-ui", "research"],
  "schedules": ["*"],
  "showAllProjectPaths": true,
  "provider": "claude-code",
  "model": "claude-opus-4-6",
  "effort": "low"
}
```

**`provider`** / **`model`** / **`effort`**: User-level defaults. Used when no session
override or agent profile value is set. `effort` accepts the same values as agent profiles
(`"off"`, `"low"`, `"medium"`, `"high"`, `"max"`).

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

## Global Config (`_global.json`)

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
{ "name": "dot", "stack": "TypeScript, Bun, Hono, React" }
```

Referenced in agent prompts as `{{name}}`, `{{stack}}`, etc.

## Runtime State (`profiles/state/`)

Gitignored. Stores transient UI state per user profile — sidebar collapse state,
last selected agent, last CWD, last session ID. Managed by the app, not edited by hand.

## Type Definitions

All types live in `profiles.ts`:
- `Profile` — agent profile shape
- `UserProfile` — user profile shape
- `GlobalConfig` — `_global.json` shape
- `CompactionConfig` — compaction tuning fields
- `ProviderDefaults` — per-provider defaults (contextWindow, maxOutputTokens, compaction)
- `PermissionPolicy` — tool execution gating
- `McpServerConfig` — MCP server connection config

Schema validation (for the API) lives in `profile-schemas.ts` using TypeBox.
