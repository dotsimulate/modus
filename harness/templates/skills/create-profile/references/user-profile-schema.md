# User Profile Schema

User profiles live at `~/.modus/profiles/users/<name>.json`. They scope the
UI and session management to a specific person or project context.

## Complete Schema

```jsonc
{
  // ── Required ──

  // Display name shown in the UI login screen and sidebar
  "displayName": "Alex",

  // Project root paths — used for session filtering and CWD picker
  // Sessions are scoped to these directories
  "projects": [
    "/home/alex/projects/webapp",
    "/home/alex/projects/api-server"
  ],

  // ── Agent Visibility ──

  // Which agent profiles this user can see and use
  // Must reference existing agent profile names (filenames without .json)
  "agentProfiles": ["dev-agent", "research", "git-ops"],

  // ── Template Variables ──

  // Override shared defaults from _users.json
  // Available as {{key}} in agent profile prompts
  "templateVars": {
    "name": "Alex",
    "stack": "Python, FastAPI, React",
    "editor": "VS Code"
  },

  // ── Provider Default ──

  // Default provider for new sessions under this user profile
  // Agent profile provider overrides this; session override overrides both
  "provider": "claude-code",

  // ── Memory Scoping ──

  // Controls where agent-memory MCP saves and reads memories
  "memory": {
    // "global" = shared memory store (default)
    // "profile" = isolated to this user profile's directory
    "scope": "global",

    // When scope="profile", also read from global store (default: true)
    // Set false for full isolation
    "inheritGlobal": true
  },

  // ── UI Filtering ──

  // Tag filter pre-applied to memory visualization (optional)
  "memoryFilter": "webapp",

  // Show project paths from ALL user profiles in CWD picker (default: false)
  "showAllProjectPaths": false,

  // Which actions this user can see (optional)
  // Omit or ["*"] = see all actions
  "actions": ["*"]
}
```

## Relationship to Agent Profiles

User profiles and agent profiles are separate systems:

| Aspect | User Profile | Agent Profile |
|--------|-------------|---------------|
| Controls | Who uses the system, what they see | How the agent behaves |
| Scope | Projects, sessions, memories | Model, tools, prompt, permissions |
| Location | `~/.modus/profiles/users/` | user-global `~/.modus/profiles/agents/` or project-local `<project>/.modus/profiles/agents/` |
| Selection | Login screen / profile switcher | Sidebar dropdown |

**Connection:** User profile's `agentProfiles` array lists which agent profiles
this user can see. The user selects one of these to start a session.

## Shared User Data (`_users.json`)

Located at `~/.modus/profiles/_users.json`. Flat key-value defaults for template variables:

```json
{
  "name": "Alex",
  "stack": "Python, FastAPI, React",
  "editor": "VS Code"
}
```

User profile `templateVars` override these per-profile. If no user profile is active,
`_users.json` values are used directly.

## Runtime State (auto-managed)

Runtime UI state is stored separately at `~/.modus/profiles/state/<name>.json`. This is
app-managed and should never be hand-edited:

```jsonc
{
  "sidebarGroupMode": "time",
  "sidebarCollapsedGroups": [],
  "sidebarConfigExpanded": false,
  "lastAgentProfile": "dev-agent",
  "lastCwd": "/home/alex/projects/webapp"
}
```

State files are created automatically on first use.

## Examples

### Developer with multiple projects

```json
{
  "displayName": "Alex",
  "projects": [
    "/home/alex/projects/webapp",
    "/home/alex/projects/api-server",
    "/home/alex/projects/mobile-app"
  ],
  "agentProfiles": ["dev-agent", "web-ui", "research", "git-ops"],
  "templateVars": {
    "stack": "TypeScript, Next.js, Prisma",
    "editor": "VS Code with Claude Code"
  }
}
```

### Isolated creative workspace

```json
{
  "displayName": "Studio",
  "projects": ["/home/alex/creative"],
  "agentProfiles": ["creative", "research"],
  "provider": "openai-compat",
  "memory": {
    "scope": "profile",
    "inheritGlobal": false
  }
}
```

### Ops user with action visibility

```json
{
  "displayName": "ops",
  "projects": ["/srv", "/etc/services"],
  "agentProfiles": ["ops-agent", "monitoring"],
  "actions": ["health-check", "log-rotate", "backup-verify"],
  "memory": {
    "scope": "profile",
    "inheritGlobal": true
  }
}
```

## Naming Conventions

- Use kebab-case for profile names: `modus-dev`, `creative-studio`
- Name should reflect the person or context, not the agent
- The `displayName` field is what appears in the UI (can include spaces, capitals)
