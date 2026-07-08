---
title: PI Agent System
lastUpdated: 2026-07-07
lastCommit: a9adf68
covers: harness/providers/pi-agent.ts harness/providers/mcp-bridge.ts
---

# PI Agent System

The harness has several execution backends. This doc covers the PI Agent backend,
currently registered for `litellm`, `ollama`, and `openrouter`.

## Architecture

```
Provider Name     Engine                    Notes
─────────────     ────────────────────      ──────────────────────────────
litellm           PI AgentSession           OpenAI-compat, custom baseURL
ollama            PI AgentSession           OpenAI-compat, custom baseURL
openrouter        PI AgentSession           OpenAI-compat, OpenRouter metadata/pricing
```

All registered providers share the same session interface (`SessionProvider` in
`providers/types.ts`), SSE event format, and DB persistence. The session manager
doesn't know or care which backend runs a given session.

## Key Files

```
providers/
  types.ts          SessionProvider interface + TurnContext
  registry.ts       Maps provider names → implementations
  pi-agent.ts       PI AgentSession provider (this doc's focus)
  mcp-bridge.ts     Connects MCP servers to PI's tool system
```

## PI Provider (`providers/pi-agent.ts`)

### Model Construction

`buildModel()` creates a PI `Model` object for the session:

- **litellm / ollama**: Always manually constructed as OpenAI-compatible. Base URLs
  come from `LITELLM_BASE_URL` / `OLLAMA_BASE_URL` env vars (or harness secrets),
  defaulting to `localhost:4000/v1` and `localhost:11434/v1`. `input: ["text", "image"]`.
- **openrouter**: Fetches model metadata (pricing + context length) from OpenRouter's
  `/api/v1/models` on first use, cached for the process lifetime. `contextLengthFromApi`
  is passed to `buildModel()` to override the default 128000 context window.

### Auth

`buildAuthStorage()` resolves API keys from harness secrets or
environment variables. Uses `setRuntimeApiKey()` to inject into PI's auth chain at
highest priority — bypasses PI's own env var lookup (which doesn't know litellm/ollama).

### Session Lifecycle

1. **startTurn**: Rekeys temp session ID to a real UUID (skips if already a UUID —
   resume case). Creates `AgentSession` with model, tools, resource loader, MCP tools.
   Subscribes to events. Sends the initial prompt via `agentSession.prompt()`.
2. **sendMessage**: If session is idle, sends directly via `sendUserMessage()`.
   If running, queues a structured item in `session.pendingDispatch` for delivery after `agent_end`.
3. **abort**: Calls `agentSession.abort()` + fires the abort controller.
4. **dispose**: Unsubscribes, disposes agent session, shuts down MCP connections.

Auto-retry is disabled for all providers — the harness manages its own lifecycle.
Compaction is enabled with configurable thresholds (see `docs/config-resolution.md`).

## Event Translation

PI emits `AgentSessionEvent` types. The `translateEvents()` function converts these
to the event shapes the frontend reducer expects (matching claude-code's output).

```
PI Event                     Harness Event
──────────                   ─────────────
message_update (text_delta)  stream_event { content_block_delta { text_delta } }
message_update (thinking)    stream_event { content_block_delta { thinking_delta } }
tool_execution_start         assistant { content: [{ type: "tool_use", id, name, input }] }
tool_execution_end           user (synthetic) { content: [{ type: "tool_result", tool_use_id }] }
agent_end                    result { subtype: "success", tokens, cost, duration }
```

Important: text and thinking are streamed via deltas. Tool calls are emitted as
complete `assistant` messages (not streamed). The `agent_end` handler does NOT
re-emit an assistant message — text was already streamed, tools already emitted.

## MCP Bridge (`providers/mcp-bridge.ts`)

Connects external MCP servers to PI's tool system. MCP servers are configured per-profile
and in global/project `_global.json` files. Sources are merged at session start.

### How it works

1. Reads `mcpServers` from merged global + profile config
2. For each server, creates an MCP `Client` with stdio or HTTP transport
3. Calls `listTools()` to discover available tools
4. Wraps each MCP tool as a PI `ToolDefinition` with:
   - Name: `mcp__<server>__<toolname>` (matches claude-code's naming convention)
   - Schema: MCP JSON Schema → TypeBox via `Type.Unsafe`
   - Execute: Delegates to `client.callTool()`, maps result content to PI format

### Transport types

- **stdio**: Launches a child process (`command` + `args`). Env vars support `$VAR`
  references resolved through the harness secrets system.
- **http**: StreamableHTTP transport to a remote server URL.

## Tool Namespaces

Claude and PI use completely different tool names:

```
Claude (PascalCase)          PI (lowercase)
Read, Write, Edit, MultiEdit read, write, edit
Glob, Grep                   grep, find, ls
Bash                         bash
WebSearch, WebFetch           (not available)
Agent, TodoWrite, Skill       (not available)
NotebookEdit, AskUserQuestion (not available)
```

Provider capabilities expose PI's lowercase tool groups to the UI so profile and
session controls do not have to infer them from provider names.

## PI Skills

PI has a built-in skills system loaded by `DefaultResourceLoader`:

- Skills are loaded from `.pi/skills/` directories (local and global)
- Skills are injected into the system prompt via `formatSkillsForPrompt()`
- Skills are enabled by default (`noSkills: false` in resource loader config)
The resource loader also picks up `CLAUDE.md` from the working directory automatically,
so PI agents inherit the same project instructions as Claude agents.

### Resource Loader Config

```typescript
new DefaultResourceLoader({
  cwd,
  settingsManager,
  systemPrompt: profile?.prompt,  // profile prompt layered on top
  noExtensions: true,             // no PI extensions
  noSkills: false,                // skills enabled by default
  noPromptTemplates: true,        // no prompt templates
  noThemes: true,                 // no themes
})
```

## Error Handling

`friendlyError()` translates raw PI/provider errors into human-readable messages:

- Connection refused → "Cannot connect to {provider}. Is the service running?"
- Invalid model → "Check your provider's model list"
- 401 → "Authentication failed. Check your API key"
- 404 → "Resource not found. Check model and server config"
- 429 → "Rate limited. Try again shortly"

## Adding a New PI Provider

1. Add the provider name to `PiProviderName` type in `pi-agent.ts`
2. Add default model to `DEFAULT_MODELS`
3. Add env var mapping in `buildAuthStorage()`
4. Add to `PI_PROVIDERS` in `registry.ts`
5. If OpenAI-compat, add base URL resolution in `buildModel()` and `getProviderUrl()`
6. Add any capability or health-check metadata needed by the registry/UI.
