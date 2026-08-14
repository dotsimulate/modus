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
    "litellm": {
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
  },

  // Client extensions, machine-wide.
  // "settings" here holds every extension setting declared scope:"global" —
  // values the harness itself consumes, which must be identical for every
  // client. A scope:"user" setting lives in the user profile instead, so it may
  // legitimately differ between a desktop and a phone.
  "clientExtensions": {
    "paths": ["/home/user/modus-extensions"],
    "enabled": ["modus-listen"],
    "disabled": [],
    "settings": {
      "modus-listen": { "whisperUrl": "http://whisper-box:8080/v1/audio/transcriptions" }
    }
  },

  // Machine-wide values for plugin settings declared scope:"global",
  // keyed by plugin id
  "pluginSettings": {
    "modus-speak": { "endpoint": "http://localhost:8880" }
  },

  // Outbound notification channels, keyed by channel name.
  // "method" and "headers" are supported and are merged over a default
  // Content-Type. Values are literal — there is no ${VAR} expansion and no
  // secrets indirection here, so a bearer token written here sits in plaintext.
  "notificationChannels": {
    "ops-webhook": {
      "type": "webhook",
      "url": "https://hooks.example.com/modus",
      "method": "POST",
      "headers": { "X-Source": "modus" }
    }
  },

  // Text-to-speech routing
  "textToSpeech": {
    "enabled": true,
    "defaultProvider": "kokoro",     // kokoro | zonos2 | neutts | elevenlabs
    "defaultVoice": "af_sky",
    "defaultFormat": "wav",          // wav | mp3 | pcm
    "voiceAliases": { "narrator": "af_sky" },
    "providers": {
      "kokoro": {
        "enabled": true,
        "baseUrl": "http://localhost:8880",
        "model": "kokoro",
        "apiKeyEnv": "KOKORO_API_KEY",   // names an env var; never the key itself
        "outputFormat": "wav",
        "stability": 0.5,
        "similarityBoost": 0.75,
        "style": 0.0
      }
      // zonos2, neutts, and elevenlabs take the same fields
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

These only apply to PI providers (`litellm`, `ollama`, `openrouter`).
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
