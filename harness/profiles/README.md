# Profiles

Two profile systems live here: **agent profiles** (what the agent is) and **user profiles**
(who is using the harness). Plus shared config files.

> **IMPORTANT FOR AGENTS:** If you modify the profile types in `profiles.ts` or change how
> the backend validates/uses profile fields, update this README to match. This is the
> canonical reference for the profile JSON schema.

## File conventions

| Pattern | Purpose |
|---|---|
| `<name>.json` | Agent profile |
| `_user_<name>.json` | User profile |
| `_global.json` | Global config (MCP servers shared across all sessions) |
| `_users.json` | Shared user data / template variables |

## Agent Profile (`Profile`)

Controls how an agent session behaves. Defined in `profiles.ts`.

```jsonc
{
  // System prompt — supports {{key}} template vars from _users.json
  "prompt": "You are a research assistant working with {{name}}.",

  // Short description for UI display / subagent selection
  "description": "Full self-learning agent with all tools and memory",

  // "append" = adds prompt after claude_code preset (default)
  // "custom" = replaces system prompt entirely
  "promptMode": "append",

  // Model override (optional — omit for SDK default)
  "model": "claude-opus-4-6",

  // Effort level (optional)
  "effort": "high",  // "low" | "medium" | "high" | "max"

  // Max agentic turns (optional — omit for unlimited)
  "maxTurns": 50,

  // Tool allowlist (optional — omit to allow all)
  "tools": ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],

  // Tool blocklist (optional — applied after allowlist)
  "disallowedTools": ["WebSearch"],

  // Whether to load CLAUDE.md and project settings (default: true)
  "loadProjectSettings": true,

  // MCP servers specific to this profile (merged with _global.json)
  "mcpServers": {
    "server-name": {
      "command": "...",
      "args": [],
      "env": {}
    }
  },

  // Permission policy for tool execution
  // "bypass" = no checks (default)
  // "ask" = every tool call requires approval
  // object = per-tool rules
  "permissionPolicy": "bypass"
}
```

### Permission policy object form
```jsonc
{
  "permissionPolicy": {
    "default": "approve",           // "approve" | "ask"
    "autoApprove": ["Read", "Glob"], // always allowed
    "requireApproval": ["Bash"]      // always needs approval
  }
}
```

## User Profile (`UserProfile`)

Scopes the harness UI and sessions to a specific person/project context.
Stored as `_user_<name>.json`. Defined in `profiles.ts`.

```jsonc
{
  // Display name shown in UI
  "displayName": "dot",

  // Template variables — merged with _users.json, available as {{key}} in agent prompts
  "templateVars": {
    "stack": "TypeScript, Bun, Hono, React"
  },

  // Project root paths — used for session filtering and CWD picker
  "projects": [
    "/home/dot/dev/infra/agent_dev_zone"
  ],

  // Which agent profiles this user works with (shown in UI selector)
  "agentProfiles": ["dev-agent", "web-ui", "research"],

  // Tag filter pre-applied to MemoryViz (optional)
  "memoryFilter": "harness",

  // Memory scoping (optional — omit for global/default behavior)
  "memory": {
    // "global" = memories saved to shared store (default)
    // "profile" = memories saved to profile-specific directory
    "scope": "global",

    // When scope=profile, also read from global store (default: true)
    // Set false for full isolation
    "inheritGlobal": true
  },

  // Show project paths from ALL user profiles in the CWD picker (default: false)
  "showAllProjectPaths": false,

  // Persisted UI state — managed by the frontend via PATCH endpoint
  "ui": {
    "sidebarGroupMode": "time",       // "time" | "project"
    "sidebarCollapsedGroups": [],
    "sidebarConfigExpanded": false,
    "lastAgentProfile": "dev-agent",
    "lastCwd": "/home/dot/dev/infra/agent_dev_zone"
  }
}
```

### Memory scoping details

When `memory.scope` is `"profile"`, the harness configures the agent-memory MCP server
to save memories to `agent_memory/memory/profiles/<user-profile-name>/` instead of the
global `agent_memory/memory/` directory. The agent is unaware of this — `save()` and
`query()` signatures don't change.

When `memory.inheritGlobal` is `true` (default), the agent also sees global memories
when querying. When `false`, only profile-scoped memories are visible.

## Global Config (`_global.json`)

MCP servers listed here are merged into every session (agent profile MCP servers override
by key).

```jsonc
{
  "mcpServers": {
    "agent-memory": {
      "command": "uv",
      "args": ["--directory", "/path/to/agent_memory", "run", "python", "server.py"],
      "env": {}
    }
  }
}
```

## Shared User Data (`_users.json`)

Flat key-value object available as `{{key}}` template variables in agent profile prompts.
User profile `templateVars` override these per-profile.

```jsonc
{
  "name": "dot",
  "stack": "TypeScript, Bun, Hono, React",
  "editor": "VS Code with Claude Code"
}
```

## API

All profiles are managed via REST endpoints on the harness server. See `index.ts`.

**Agent profiles:**
- `GET /api/profiles` — list all
- `GET /api/profiles/:name` — get one
- `PUT /api/profiles/:name` — create/replace
- `DELETE /api/profiles/:name` — delete

**User profiles:**
- `GET /api/user-profiles` — list all
- `GET /api/user-profiles/:name` — get one
- `PUT /api/user-profiles/:name` — create/replace
- `PATCH /api/user-profiles/:name` — partial update (UI state)
- `DELETE /api/user-profiles/:name` — delete
