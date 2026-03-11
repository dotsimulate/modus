---
title: Profile System
audience: agents
lastUpdated: 2026-03-11
lastCommit: cf9d454
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
  "tools": ["Read", "Edit", "Bash"],
  "contextWindow": 65536,
  "maxOutputTokens": 2048,
  "compaction": { "enabled": true, "reserveTokens": 16384 },
  "mcpServers": { ... },
  "permissionPolicy": "bypass",
  "ui": { "showThinking": true, "placeholder": "Ask me anything..." }
}
```

### Key Fields

**`provider`**: Execution backend. `"claude-code"` uses the Claude Agent SDK.
Everything else (`"anthropic"`, `"openai"`, `"litellm"`, `"ollama"`) uses PI AgentSession.

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
  "showAllProjectPaths": true
}
```

**`templateVars`**: Merged with `_users.json` defaults. Available as `{{key}}` in
agent prompts. Use for user name, preferred stack, editor, etc.

**`agentProfiles`**: Which agent profiles appear in the UI sidebar. Omit for all.

**`projects`**: Working directories available in the CWD picker.

## Global Config (`_global.json`)

Two purposes:

1. **MCP servers** — merged into every session (agent profiles can add more).
2. **Provider defaults** — per-provider fallbacks for `contextWindow`, `maxOutputTokens`,
   and `compaction`. See `docs/config-resolution.md` for the full resolution chain.

## Template Variables (`_users.json`)

Flat key-value defaults. User profiles can override per-user.

```json
{ "name": "dot", "stack": "TypeScript, Bun, Hono, React" }
```

Referenced in agent prompts as `{{name}}`, `{{stack}}`, etc.

## Runtime State (`profiles/state/`)

Gitignored. Stores transient UI state per user profile — sidebar collapse state,
last selected agent, last CWD. Managed by the app, not edited by hand.

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
