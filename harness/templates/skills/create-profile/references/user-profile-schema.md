# User Profile Schema

User profiles live at `<cwd>/.modus/profiles/users/<name>.json`. They scope the
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

  // ── UI Filtering ──

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
| Location | `profiles/users/` | `profiles/agents/` |
| Selection | Login screen / profile switcher | Sidebar dropdown |

**Connection:** User profile's `agentProfiles` array lists which agent profiles
this user can see. The user selects one of these to start a session.

## Shared User Data (`_users.json`)

Located at `profiles/_users.json`. Flat key-value defaults for template variables:

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

Runtime UI state is stored separately at `profiles/state/<name>.json`. This is
app-managed and should never be hand-edited:

```jsonc
{
  "sidebarGroupMode": "time",       // "time" | "agent"
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
  "provider": "litellm",
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
