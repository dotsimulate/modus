# Agent Profile Schema

Reusable user-global agent profiles live at
`~/.modus/profiles/agents/<name>.json`. Project-local profiles and overrides live at
`<project>/.modus/profiles/agents/<name>.json`. The filename (without `.json`) is the
profile's ID used everywhere in the system.

## Complete Schema

```jsonc
{
  // ── Required ──

  // Short description for UI display and selection
  "description": "Full self-learning agent with all tools and memory",

  // System prompt — supports {{key}} template variables
  "prompt": "You are a research assistant working with {{name}}.",

  // ── Prompt Handling ──

  // "append" (default) = adds prompt after the built-in system prompt
  // "custom" = replaces the system prompt entirely (agent gets ONLY your prompt)
  "promptMode": "append",

  // ── Model & Execution ──

  // Execution provider (default: "claude-code")
  "provider": "claude-code",
  // Common options: "claude-code" | "claude-code-pty" | "cursor" | "codex" |
  // "antigravity" | "grok-build" | "opencode" | "litellm" | "ollama" | "openrouter"

  // Model ID (omit for provider's default)
  "model": "claude-opus-4-8[1m]",
  // Prefer omitting this field when the provider's current default is acceptable.
  // Other providers: any model ID from their /models endpoint

  // Inference effort hint
  "effort": "high",
  // Options: "off" | "low" | "medium" | "high" | "xhigh" | "max"

  // Max agentic turns per session turn (omit = unlimited)
  "maxTurns": 50,

  // ── Tools ──

  // Allowlist — only these tools available (omit = all tools allowed)
  "tools": ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],

  // Blocklist — these tools removed (applied after allowlist)
  "disallowedTools": ["WebSearch"],

  // ── Project Settings ──

  // Load CLAUDE.md from CWD and parent directories (default: true)
  "loadProjectSettings": true,

  // Exclude specific CLAUDE.md files from loading
  // Simple form: glob patterns matched against absolute paths
  "claudeMdExcludes": ["**/node_modules/**/CLAUDE.md"],
  // Object form: named rules + custom patterns
  "claudeMdExcludes": {
    "rules": ["no-parent-walk", "no-node-modules"],
    "custom": ["/path/to/specific/CLAUDE.md"]
  },
  // Rules: "no-parent-walk" = skip CLAUDE.md above CWD
  //        "no-node-modules" = skip **/node_modules/**/CLAUDE.md

  // ── MCP Servers ──
  // Merged with _global.json servers. Profile servers override global by key.

  "mcpServers": {
    "server-name": {
      "type": "stdio",            // "stdio" (default) | "sse" | "http"
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": {
        "API_KEY": "$API_KEY"     // $VAR references resolve from environment variables
      }
    }
  },

  // ── Permissions ──

  // "bypass" = no tool approval checks (default, fastest)
  // "ask" = every tool call requires user approval
  // object = granular per-tool control
  "permissionPolicy": "bypass",

  // ── Provider Tuning (PI providers only: litellm, ollama, openrouter) ──
  // These fields are ignored by non-PI providers such as claude-code, cursor, and codex.

  // Context window size (must match inference server's -c flag for local models)
  "contextWindow": 65536,

  // Max tokens per response
  "maxOutputTokens": 4096,

  // Auto-compaction when context fills up
  "compaction": {
    "enabled": true,              // default: true
    "reserveTokens": 16384,      // tokens reserved for next response
    "keepRecentTokens": 20000    // recent context preserved during compaction
  },

  // ── CWD Suggestions ──

  // Auto-populates cwd + additionalDirectories when this profile is selected.
  // First entry → cwd, remaining entries → additionalDirectories.
  // Cleared when switching to a profile without this field.
  "cwdSuggestions": ["/home/user/project", "/home/user/project/subdir"],

  // ── Session Environment ──

  // Inject env vars into the agent session (resolved before start)
  "env": {
    "MY_VAR": "value"
  },

  // Spending cap — session errors out if cost exceeds this (claude-code only)
  "maxBudgetUsd": 5.0,

  // ── Sandbox (claude-code only) ──

  // See harness/docs/profile-system.md for the full network ACL sub-schema.
  // Stub — don't template this in profile creation; configure manually if needed.
  "sandbox": { /* enabled, network.allowedDomains, autoAllowBashIfSandboxed, ... */ },

  // ── Codex-specific ──

  // Override the sandbox mode derived from permissionPolicy (codex only)
  // "danger-full-access" = full shell + filesystem
  // "workspace-write"    = filesystem writes, no arbitrary shell
  // "read-only"          = read-only, no exec
  "codexSandboxMode": "danger-full-access",

  // Starlark rules written to ~/.codex/rules/ for command-level enforcement (codex only)
  // Use this instead of permissionPolicy:"ask" — Codex cannot surface interactive approvals
  "codexRules": [
    "prefix_rule(pattern=[\"rm\", \"-rf\"], decision=\"forbidden\")",
    "prefix_rule(pattern=[\"curl\"], decision=\"ask\")"
  ],

  // ── UI Hints (frontend display only) ──

  "ui": {
    "label": "dev",                    // Short name in profile selector
    "placeholder": "what should we build?",  // Input placeholder
    "showThinking": true,              // Show thinking blocks
    "showMeta": true,                  // Show metadata
    "showToolCalls": true,             // Show tool call details
    "showGitEvents": true,             // Show git events
    "emptyTitle": "dev-agent",         // Title in empty session
    "emptySubtitle": "opus / full tools / self-learning"  // Subtitle
  }
}
```

## Permission Policy Object Form

For granular control over which tools need approval:

```json
{
  "permissionPolicy": {
    "default": "approve",
    "autoApprove": ["Read", "Glob", "Grep"],
    "requireApproval": ["Bash", "Write"]
  }
}
```

- `default`: `"approve"` (auto-approve unless listed) or `"ask"` (ask unless listed)
- `autoApprove`: tools that never need approval
- `requireApproval`: tools that always need approval (overrides default)

## Template Variables

Prompts support `{{key}}` interpolation. Variables resolve from:

1. Active user profile's `templateVars` (highest priority)
2. `_users.json` shared defaults (fallback)

Common variables: `{{name}}`, `{{stack}}`, `{{editor}}`

## Config Resolution (for PI provider fields)

```
Profile JSON  >  _global.json providerDefaults  >  TypeScript fallback
(per-agent)      (per-provider, all agents)         (hardcoded defaults)
```

| Field | TS Fallback |
|-------|-------------|
| `contextWindow` | 128000 (or OpenRouter API metadata) |
| `maxOutputTokens` | 8192 |
| `compaction.enabled` | true |
| `compaction.reserveTokens` | `max(4096, maxOutputTokens)` |
| `compaction.keepRecentTokens` | 20000 |

## Real-World Examples

### Full-featured dev agent (Claude Code)

```json
{
  "description": "Full self-learning agent with all tools and memory",
  "prompt": "You are a collaborative assistant working with {{name}}. Use your tools, skills, and memory system as directed by CLAUDE.md.",
  "promptMode": "append",
  "model": "claude-opus-4-8[1m]",
  "effort": "high",
  "loadProjectSettings": true,
  "permissionPolicy": "bypass",
  "ui": {
    "label": "dev",
    "placeholder": "what should we build?",
    "emptyTitle": "dev-agent",
    "emptySubtitle": "opus / full tools / self-learning"
  }
}
```

### Research agent with web search MCP servers

```json
{
  "description": "Read-only research agent with web search",
  "prompt": "Search, read, and analyze. Never modify files. Cite file paths and line numbers.",
  "promptMode": "append",
  "model": "claude-opus-4-8",
  "effort": "high",
  "maxTurns": 15,
  "tools": ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Agent"],
  "disallowedTools": ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"],
  "loadProjectSettings": true,
  "permissionPolicy": { "default": "approve" },
  "mcpServers": {
    "tavily": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "tavily-mcp"],
      "env": { "TAVILY_API_KEY": "$TAVILY_API_KEY" }
    }
  },
  "ui": {
    "label": "research",
    "showThinking": false,
    "placeholder": "what should I research?",
    "emptyTitle": "research",
    "emptySubtitle": "claude / read-only / web search"
  }
}
```

### Creative agent on local model

```json
{
  "description": "Creative exploration with local model",
  "prompt": "You are a creative explorer. Your purpose is perception, reflection, and creative dialogue.",
  "promptMode": "custom",
  "provider": "litellm",
  "model": "deepseek-r1-qwen3-8b",
  "effort": "high",
  "maxTurns": 30,
  "loadProjectSettings": false,
  "tools": ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Agent", "AskUserQuestion"]
}
```

### Ops agent with restricted bash

```json
{
  "description": "System ops agent -- monitoring and maintenance",
  "prompt": "You are a system operations agent. Monitor, diagnose, and maintain. Always explain before executing destructive commands.",
  "model": "claude-opus-4-8",
  "effort": "medium",
  "maxTurns": 20,
  "tools": ["Read", "Bash", "Grep", "Glob"],
  "permissionPolicy": {
    "default": "approve",
    "requireApproval": ["Bash"]
  }
}
```

### Minimal fast agent

```json
{
  "description": "Quick Q&A with Haiku",
  "prompt": "Answer concisely. No tool use unless essential.",
  "model": "claude-haiku-4-5",
  "effort": "low",
  "maxTurns": 3
}
```

## Naming Conventions

- Use kebab-case for profile names: `dev-agent`, `web-ui`, `git-ops`
- Name should reflect the agent's role, not the model
- Keep names short — they appear in UI selectors and API calls
