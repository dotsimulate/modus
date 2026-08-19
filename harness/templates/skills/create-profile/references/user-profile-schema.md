# User Profile Schema

User profiles live at `<current-home>/profiles/users/<name>.json`. They scope the
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

  // ── Session Defaults ──

  // Default agent profile selected for a new session under this user
  "defaultAgentProfile": "dev-agent",

  // Default model and effort for new sessions. An agent profile's own value
  // overrides these; a session override beats both.
  "model": "claude-opus-4-8",
  "effort": "high",

  // ── Plugin Profile Visibility ──

  // Plugin-supplied agent profiles to hide from this user's pickers.
  // Qualified keys, e.g. "plugin:<id>/<name>".
  "hiddenPluginProfiles": ["plugin:modus-speak/narrator"],

  // ── Client Extensions ──

  // Per-user extension enablement and settings. Extra discovery roots go in
  // "paths"; "settings" is keyed by extension id. Only scope:"user" settings
  // land here — a scope:"global" setting is stored Vault-wide in _global.json
  // instead, so every client resolves the same value.
  "clientExtensions": {
    "paths": ["/home/alex/modus-extensions"],
    "enabled": ["modus-listen"],
    "disabled": ["whisper-transcribe"],
    "settings": { "modus-listen": { "micDevice": "Yeti Stereo Microphone" } }
  },

  // ── Layout ──

  // Dashboard widget/page layout entries. These are layout objects, not bare
  // widget names — the app writes them; hand-authoring is rarely what you want.
  // See UserProfileSchema in harness/profile-schemas.ts for the element shape.
  "dashboard": { "widgets": [], "pages": [] },

  // Left panel takes plain widget keys, from harness/ui/src/widgets/registry.ts
  "leftPanel": { "widgets": ["files"] },

  // Interface preferences for this user
  "interface": {
    "chat": {
      "fontScale": 100,               // percent; 100 = default
      "chatWidth": 800,
      "scrollIndicator": "ruler",     // "scroll" | "spine" | "ruler"
      "spineEnabled": true
    },
    "conversation": {
      "showThinking": true,
      "showMeta": true,
      "toolCalls": "collapsed",       // "expanded" | "collapsed" | "hidden"
      "showGitEvents": true,
      "showFileChanges": true,
      "deferHeavyDetails": false
    },
    "configBar": { "items": ["provider", "model"] },
    "motion": "system"                // "system" | "reduced" — a string, not an object
  },

  // ── Computer ──

  // Label for the machine this profile is used from
  "computer": "studio-desktop",

  // ── Editor ──

  // Preferred external editor for "open in editor"
  "editor": "code"
}
```

> `actions` is **not** a user-profile field. Zod object schemas here are
> non-strict, so an unknown key validates and is then ignored — writing
> `"actions": ["*"]` looks accepted and does nothing. Action visibility is
> resolved from the action side, not from the user profile.

## Relationship to Agent Profiles

User profiles and agent profiles are separate systems:

| Aspect | User Profile | Agent Profile |
|--------|-------------|---------------|
| Controls | Who uses the system, what they see | How the agent behaves |
| Scope | Projects, sessions, memories | Model, tools, prompt, permissions |
| Location | `<current-home>/profiles/users/` | Vault-global `<current-home>/profiles/agents/` or project-local `<project>/.modus/profiles/agents/` |
| Selection | Login screen / profile switcher | Sidebar dropdown |

**Connection:** User profile's `agentProfiles` array lists which agent profiles
this user can see. The user selects one of these to start a session.

## Shared User Data (`_users.json`)

Located at `<current-home>/profiles/_users.json`. Flat key-value defaults for template variables:

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

Runtime UI state is stored separately at `<current-home>/profiles/state/<name>.json`. This is
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
  "defaultAgentProfile": "ops-agent",
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
