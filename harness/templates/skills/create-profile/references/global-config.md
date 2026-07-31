# Global Config & Provider Defaults

## `_global.json`

User-global defaults live at `~/.modus/profiles/_global.json`. Project-local overrides
live at `<project>/.modus/_global.json`. The resolved configuration is merged into every
session regardless of which agent or user profile is active.

```jsonc
{
  // MCP servers available to ALL sessions
  // Agent profile MCP servers override these by key name
  "mcpServers": {
    "agent-memory": {
      "command": "uv",
      "args": ["--directory", "/path/to/agent_memory", "run", "python", "server.py"],
      "env": {}
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
      "env": {}
    }
  },

  // Per-provider defaults (optional)
  // Apply to all agents using that provider, unless the agent profile overrides
  "providerDefaults": {
    "openai-compat": {
      "contextWindow": 65536,
      "maxOutputTokens": 4096,
      "compaction": {
        "reserveTokens": 8192,
        "keepRecentTokens": 20000
      }
    },
    "ollama": {
      "contextWindow": 8192,
      "maxOutputTokens": 2048
    }
  }
}
```

## Config Resolution Order

Every runtime value resolves through a cascade. First non-undefined wins:

```
Agent Profile JSON  >  _global.json providerDefaults  >  TypeScript fallback
(per-agent)            (per-provider, all agents)         (hardcoded defaults)
```

When an action is involved, action overrides sit above agent profile:

```
Session override  >  Action config  >  Agent Profile  >  Provider Defaults  >  TS fallback
```

## Provider Defaults

These fields can be set per-provider in `_global.json`:

| Field | Default | Description |
|-------|---------|-------------|
| `contextWindow` | 128000 (or OpenRouter API metadata) | Context size (match your inference server's `-c` flag) |
| `maxOutputTokens` | 8192 | Max tokens per response |
| `compaction.enabled` | true | Auto-summarize when context fills |
| `compaction.reserveTokens` | `max(4096, maxOutputTokens)` | Tokens reserved for the next response |
| `compaction.keepRecentTokens` | 20000 | Recent context preserved during compaction |

These apply to built-in and user/plugin declarative PI providers. `litellm` is a
legacy alias of `openai-compat`; use the canonical name for new defaults.
Claude Code provider manages context through the SDK directly.

## MCP Server Merging

1. Start with `_global.json` MCP servers
2. Merge agent profile MCP servers on top (override by key)
3. Result is passed to the session

```
Global:  { "agent-memory": {...}, "filesystem": {...} }
Profile: { "filesystem": {...custom...}, "tavily": {...} }
Result:  { "agent-memory": {...}, "filesystem": {...custom...}, "tavily": {...} }
```

## MCP Server Config Format

```jsonc
{
  "type": "stdio",       // "stdio" (default) | "sse" | "http"
  "command": "npx",      // executable to run
  "args": ["-y", "package-name"],  // command arguments
  "env": {
    "API_KEY": "$API_KEY"  // $VAR references resolve from environment variables
  }
}
```

## Common MCP Server Examples

### Agent memory (persistent knowledge)
```json
{
  "agent-memory": {
    "command": "uv",
    "args": ["--directory", "/path/to/agent_memory", "run", "python", "server.py"],
    "env": {}
  }
}
```

### Web search (Tavily)
```json
{
  "tavily": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "tavily-mcp"],
    "env": { "TAVILY_API_KEY": "$TAVILY_API_KEY" }
  }
}
```

### Web search (Brave)
```json
{
  "brave-search": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "env": { "BRAVE_API_KEY": "$BRAVE_API_KEY" }
  }
}
```

### Filesystem access
```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"],
    "env": {}
  }
}
```

## When to Update `_global.json`

- Adding an MCP server that should be available to ALL agents (e.g., memory system)
- Tuning provider defaults for local model infrastructure
- Setting up a new provider endpoint (LiteLLM proxy, Ollama server)

Do NOT put agent-specific MCP servers here — those belong in the agent profile.
