# Profiles

Two profile systems live here: **agent profiles** (what the agent is) and **user profiles**
(who is using the harness). Plus shared config and runtime state.

> **IMPORTANT FOR AGENTS:** If you modify the profile types in `profiles.ts` or change how
> the backend validates/uses profile fields, update this README to match. This is the
> canonical reference for the profile JSON schema.

## Directory structure

```
profiles/
├── agents/              ← agent profile definitions (config, edit deliberately)
│   ├── dev-agent.json
│   ├── research.json
│   └── ...
├── users/               ← user profile definitions (config, edit deliberately, gitignored)
│   ├── harness-dev.json
│   └── ...
├── state/               ← runtime UI state (app-managed, gitignored, never hand-edit)
│   ├── harness-dev.json
│   └── ...
├── _global.json         ← shared MCP servers merged into every session
└── _users.json          ← shared user data / template variables (gitignored)
```

Three folders, three concerns:
- **`agents/`** — what the agent is. Config. Edit deliberately.
- **`users/`** — what the user sees. Config. Edit deliberately.
- **`state/`** — where the app was last. Ephemeral. Gitignored. Never hand-edit.

## Agent Profile (`Profile`)

Controls how an agent session behaves. Stored in `agents/<name>.json`. Defined in `profiles.ts`.

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

  // CLAUDE.md exclusions — prevents unwanted CLAUDE.md files from loading
  // Simple form: raw glob patterns passed straight to the SDK
  "claudeMdExcludes": ["**/node_modules/**/CLAUDE.md"],
  // Object form: named rules + custom patterns (see below)
  "claudeMdExcludes": {
    "rules": ["no-parent-walk", "no-node-modules"],
    "custom": ["D:/some/specific/CLAUDE.md"]
  },

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

### CLAUDE.md exclusions

Controls which `CLAUDE.md` files the SDK skips when loading project settings.
Without this, Claude Code walks up the directory tree from CWD and loads every
`CLAUDE.md` it finds — including parent repos you don't control.

**Simple form** — raw glob patterns (picomatch syntax, matched against absolute paths):
```jsonc
{ "claudeMdExcludes": ["D:/TD-tox/LOPS_tox/GITsync/CLAUDE.md"] }
```

**Object form** — named rules + custom patterns:
```jsonc
{
  "claudeMdExcludes": {
    "rules": ["no-parent-walk", "no-node-modules"],
    "custom": ["D:/other/repo/CLAUDE.md"]
  }
}
```

**Available rules:**
| Rule | What it excludes |
|------|-----------------|
| `no-parent-walk` | Every `CLAUDE.md` and `.claude/CLAUDE.md` in directories above CWD |
| `no-node-modules` | `**/node_modules/**/CLAUDE.md` |

Rules are expanded at session start using the resolved CWD, then merged with
any `custom` patterns into a flat array passed to the SDK's `claudeMdExcludes`.

## User Profile (`UserProfile`)

Scopes the harness UI and sessions to a specific person/project context.
Stored in `users/<name>.json`. Defined in `profiles.ts`.

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

  // Which actions this user can see (optional — omit or ["*"] for all)
  "actions": ["health-monitor", "daily-report"],

  // Default execution provider (optional — agent profile overrides this)
  "provider": "claude-code",  // "claude-code" | "anthropic" | "openai" | "litellm" | "ollama"

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
  "showAllProjectPaths": false
}
```

**Note:** User profiles contain only stable config. Runtime UI state (last selected
agent profile, sidebar collapse state, last CWD) lives in `state/<name>.json` and is
managed automatically by the frontend.

### Memory scoping details

When `memory.scope` is `"profile"`, the harness configures the agent-memory MCP server
to save memories to `agent_memory/memory/profiles/<user-profile-name>/` instead of the
global `agent_memory/memory/` directory. The agent is unaware of this — `save()` and
`query()` signatures don't change.

When `memory.inheritGlobal` is `true` (default), the agent also sees global memories
when querying. When `false`, only profile-scoped memories are visible.

## User Profile State (`UserProfileState`)

Runtime UI state — app-managed, gitignored, never hand-edit. Stored in `state/<name>.json`.

```jsonc
{
  "sidebarGroupMode": "time",       // "time" | "agent"
  "sidebarCollapsedGroups": [],
  "sidebarConfigExpanded": false,
  "lastAgentProfile": "dev-agent",
  "lastCwd": "/home/dot/dev/infra/agent_dev_zone"
}
```

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

## How Profiles Connect to Actions

Actions are the automation primitive in MO. Every action references an agent profile
by name — the profile defines *how* the agent behaves, the action defines *when*,
*why*, and *with what context* it runs.

```
Action (actions/<name>/action.json)
  ├── trigger: interval | webhook | manual | action-chain
  ├── agentProfile: "ops-agent"  ──→  profiles/agents/ops-agent.json
  ├── context.ts: gather() builds the prompt, afterRun() handles side effects
  └── overrides: model, effort, maxTurns, tools, cwd (override the profile per-run)
```

**What actions can do:**
- Run on intervals with active hours and cycle limits
- Fire from HTTP webhooks (GitHub, home automation, external services)
- Chain: action A completes → action B fires automatically (up to 8 levels deep)
- Trigger manually from the UI or API
- Gather live data (APIs, files, DB) before each run to build a dynamic prompt
- Act on the agent's response after completion (notifications, file writes, API calls)

**What profiles control that actions cannot override:**
- System prompt (always from the agent profile)
- MCP server configuration
- Permission policies
- Prompt mode (`custom` vs `append`)

**Concurrency:** If a trigger fires while the action is already running, it's dropped
and logged. No queuing, no overlapping runs.

User profiles scope which actions are visible via the `actions` field. Omit or set to
`["*"]` to show all actions.

See `action-types.ts` for the full type contracts and `action-runner.ts` for the engine.

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
- `PATCH /api/user-profiles/:name` — partial update (config only)
- `DELETE /api/user-profiles/:name` — delete

**User profile state (runtime, separate from config):**
- `GET /api/user-profiles/:name/state` — get state
- `PATCH /api/user-profiles/:name/state` — partial update state
