# Harness ↔ SDK Capability Map
*Generated: 2026-03-02 — verified against `@anthropic-ai/claude-agent-sdk` v0.2.63 sdk.d.ts*

## Summary

The harness ([harness/index.ts](../harness/index.ts)) is a thin Hono/Bun HTTP bridge over
the Agent SDK's `query()` function. This doc maps every SDK option to whether we expose it
through the harness, what the frontend needs to send, and what's worth adding.

## Architecture

```
Frontend (browser)
  │
  │  POST /api/agent/stream  (JSON body → SSE response)
  │  GET  /api/sessions       (planned)
  │  GET  /health
  │
  ▼
Harness (Bun + Hono, port 3001)
  │
  │  query({ prompt, options })  →  AsyncGenerator<SDKMessage>
  │
  ▼
Agent SDK subprocess (claude CLI)
  │
  │  stdin/stdout JSON protocol
  │
  ▼
Claude API (Anthropic)
```

The harness does NOT hold conversation state — the SDK subprocess manages sessions on disk
(`~/.claude/projects/`). The harness just passes options through and streams events back.

## Current Endpoint

```
POST /api/agent/stream
Content-Type: application/json

{
  "prompt":       string,          // required
  "sessionId":    string?,         // resume a session
  "maxTurns":     number?,         // default 10
  "allowedTools": string[]?        // auto-allowed tool names
}
```

Hardcoded in harness:
- `permissionMode: "bypassPermissions"` (fine for dev, not for LAN)
- `cwd: process.env.AGENT_CWD || process.cwd()`
- `includePartialMessages: true`
- `pathToClaudeCodeExecutable: ~/.local/bin/claude`

## Full SDK Options — Exposure Plan

### Tier 1: Expose Now (high value, safe for frontend to control)

| SDK Option | Type | Current | Expose As | Notes |
|---|---|---|---|---|
| `prompt` | `string` | ✅ body.prompt | — | Already works |
| `resume` | `string` | ✅ body.sessionId | — | Already works, **session resume verified** |
| `maxTurns` | `number` | ✅ body.maxTurns | — | Already works, default 10 |
| `allowedTools` | `string[]` | ✅ body.allowedTools | — | Already works |
| `model` | `string` | ❌ | body.model | e.g. `"claude-sonnet-4-6"`, `"claude-haiku-4-5"` |
| `systemPrompt` | `string \| preset+append` | ❌ | body.systemPrompt | Custom prompt or `{ type: "preset", preset: "claude_code", append: "..." }` |
| `agent` | `string` | ❌ | body.agent | Name of agent defined in `agents` option |
| `agents` | `Record<string, AgentDefinition>` | ❌ | body.agents | Define inline agents per request |
| `disallowedTools` | `string[]` | ❌ | body.disallowedTools | Remove tools from context entirely |
| `tools` | `string[] \| preset` | ❌ | body.tools | Base tool set — `["Read","Grep","Glob"]` or `{ type: "preset", preset: "claude_code" }` |
| `cwd` | `string` | hardcoded | body.cwd | Override working directory per request |
| `effort` | `"low"\|"medium"\|"high"\|"max"` | ❌ | body.effort | Controls thinking depth. `"low"` = fast/cheap |
| `maxBudgetUsd` | `number` | ❌ | body.maxBudgetUsd | Hard cost cap per query |
| `persistSession` | `boolean` | ❌ (default true) | body.persistSession | Set `false` for ephemeral test queries |
| `continue` | `boolean` | ❌ | body.continue | Resume most recent session in cwd |
| `forkSession` | `boolean` | ❌ | body.forkSession | Fork when resuming instead of appending |
| `promptSuggestions` | `boolean` | ❌ | body.promptSuggestions | Get next-turn suggestions (free, cached) |

### Tier 2: Expose Later (useful but needs backend support)

| SDK Option | Type | Notes |
|---|---|---|
| `permissionMode` | `PermissionMode` | Currently hardcoded to `bypassPermissions`. For LAN access, expose `"default"` / `"acceptEdits"` / `"dontAsk"`. Don't let frontend set `bypassPermissions`. |
| `mcpServers` | `Record<string, McpServerConfig>` | Attach MCP servers per session. Powerful but needs validation — don't let frontend inject arbitrary commands. Define allowed servers in harness config. |
| `thinking` | `ThinkingConfig` | `{ type: "adaptive" }` (default on Opus 4.6), `{ type: "disabled" }`, or `{ type: "enabled", budgetTokens: N }`. Could expose as body.thinking. |
| `outputFormat` | `OutputFormat` | JSON schema output — useful for structured agent responses. `{ type: "json_schema", schema: {...} }` |
| `hooks` | `Record<HookEvent, ...>` | 18 hook event types. In-process callbacks — can't serialize from frontend. Harness would define these server-side. |
| `sandbox` | `SandboxSettings` | Process isolation. Server-side config, not frontend-controlled. |
| `settingSources` | `SettingSource[]` | `["user","project","local"]`. Must include `"project"` to load CLAUDE.md. Currently implicit (SDK default). Harness should explicitly set this. |
| `enableFileCheckpointing` | `boolean` | Enables `query.rewindFiles()`. Useful for undo, but needs harness API for rewind. |
| `plugins` | `SdkPluginConfig[]` | Local plugins. Server-side config only. |
| `betas` | `SdkBeta[]` | e.g. `"context-1m-2025-08-07"` for 1M context on Sonnet. |

### Tier 3: Don't Expose (internal/infrastructure)

| SDK Option | Why Not |
|---|---|
| `abortController` | Harness manages this via `stream.onAbort()` — already wired |
| `pathToClaudeCodeExecutable` | Server-side config only |
| `executable` / `executableArgs` | Runtime choice, not per-request |
| `spawnClaudeCodeProcess` | In-process callback |
| `canUseTool` | In-process callback — use hooks or permissionMode instead |
| `onElicitation` | In-process callback |
| `env` | Security risk — don't let frontend set env vars |
| `debug` / `debugFile` / `stderr` | Dev/ops only |
| `extraArgs` | Catch-all escape hatch — if we need it, add specific options |
| `strictMcpConfig` | Server-side config |
| `allowDangerouslySkipPermissions` | Never from frontend |

## Query Instance Methods

The `query()` function returns a `Query` object (extends `AsyncGenerator<SDKMessage>`) with
control methods. These only work with **streaming input mode** (passing `AsyncIterable<SDKUserMessage>`
as the prompt instead of a string).

| Method | What It Does | Harness Endpoint? |
|---|---|---|
| `interrupt()` | Stop current generation | `POST /api/agent/:sessionId/interrupt` |
| `setPermissionMode(mode)` | Change permissions mid-session | Not yet — server-side only |
| `setModel(model)` | Switch model mid-session | `POST /api/agent/:sessionId/model` |
| `setMaxThinkingTokens(n)` | Adjust thinking budget | Deprecated — use `thinking` option |
| `initializationResult()` | Get session init info | Return in first SSE event (already there) |
| `supportedCommands()` | List available skills/commands | `GET /api/agent/:sessionId/commands` |
| `supportedModels()` | List available models | `GET /api/models` |
| `supportedAgents()` | List available subagents | `GET /api/agent/:sessionId/agents` |
| `mcpServerStatus()` | MCP server connection status | `GET /api/agent/:sessionId/mcp-status` |
| `accountInfo()` | Auth/subscription info | `GET /api/account` |
| `rewindFiles(msgId)` | Undo file changes to a message | `POST /api/agent/:sessionId/rewind` |
| `reconnectMcpServer(name)` | Reconnect failed MCP | Admin endpoint |
| `toggleMcpServer(name, on)` | Enable/disable MCP server | Admin endpoint |
| `setMcpServers(servers)` | Replace dynamic MCP servers | Admin endpoint |
| `streamInput(stream)` | Multi-turn streaming input | Core — needed for real conversations |
| `stopTask(taskId)` | Stop a background subagent task | `POST /api/agent/:sessionId/stop-task` |
| `close()` | Kill the subprocess | `DELETE /api/agent/:sessionId` |

## Streaming Input Mode (Multi-Turn)

Current harness uses **single-prompt mode**: pass a string, get a response, connection closes.
For real multi-turn conversations (the frontend chat experience), we need **streaming input**:

```typescript
// Single prompt (current)
const q = query({ prompt: "hello", options: { ... } });

// Streaming input (needed for multi-turn)
async function* userMessages(): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", content: "hello" };
  // ... wait for user to type next message ...
  yield { type: "user", content: "now do X" };
}
const q = query({ prompt: userMessages(), options: { ... } });
```

This is how the frontend will maintain a persistent connection with live back-and-forth.
The harness would need to hold the `Query` object in memory per session and accept new
messages via WebSocket or SSE push.

**For now**, the resume-based approach works: each message is a new HTTP request with the
session ID, and the SDK loads conversation history from disk. This is simpler and already
verified working. Streaming input is a future upgrade for lower-latency multi-turn.

## Agent Profiles via SDK

The SDK supports inline agent definitions. This is how we create a test profile:

```typescript
query({
  prompt: "...",
  options: {
    agent: "test-harness",         // Use this agent for the main thread
    agents: {
      "test-harness": {
        description: "Lightweight test agent for harness validation",
        prompt: "You are a minimal test agent. Respond briefly and concisely. Do not use tools unless explicitly asked.",
        tools: ["Read", "Grep", "Glob"],    // Read-only tools
        model: "haiku",                      // Cheapest model
        maxTurns: 3,
      }
    },
    settingSources: [],            // Don't load CLAUDE.md — pure isolation
    persistSession: false,         // Don't persist test sessions
  }
});
```

Profiles can also be defined server-side in the harness and selected by name:

```typescript
// harness/profiles.ts
export const PROFILES = {
  "test-harness": {
    description: "...",
    prompt: "...",
    tools: ["Read", "Grep", "Glob"],
    model: "haiku",
    maxTurns: 3,
  },
  "dev-agent": {
    description: "Full self-learning agent with all tools",
    prompt: "You are a collaborative research assistant...",
    // tools: omitted = inherit all
    model: "opus",
  }
};
```

Frontend sends `{ "profile": "test-harness", "prompt": "hello" }` and the harness resolves
the profile to SDK options.

## SSE Event Types

The SDK emits these event types (from `SDKMessage`):

| Event | Description | Frontend Use |
|---|---|---|
| `system` | Init event with session_id, tools, model, etc. | Capture session ID, show available tools |
| `assistant` | Complete assistant message | Display final response |
| `stream_event` | Streaming deltas (content_block_delta, etc.) | Live typing effect |
| `result` | Query complete — cost, duration, usage stats | Show cost, mark complete |
| `rate_limit_event` | Rate limit status | Show warnings |
| `error` | SDK/subprocess error | Display error |
| `done` | Stream finished | Close connection |

## Verified Behaviors

1. **Session resume works** — tested with cerulean blue memory test, same session ID preserved
2. **SSE streaming works** — content_block_delta events stream in real-time
3. **Cost tracking** — `result` event includes `total_cost_usd` and per-model breakdown
4. **Cache hits** — resumed sessions show `cache_read_input_tokens` >> `cache_creation_input_tokens`
5. **maxTurns** — limits agent loop iterations as expected
6. **CLAUDE.md loads** — agents in harness cwd pick up CLAUDE.md (confirmed by agent using memory tools)

## Recommended Harness Changes

### Immediate (before frontend)

1. **Expose Tier 1 options** — pass through model, systemPrompt, agent/agents, disallowedTools,
   tools, cwd, effort, maxBudgetUsd, persistSession, continue, forkSession, promptSuggestions
2. **Add profiles system** — server-side profile definitions, selected by name in request body
3. **Add `settingSources`** — explicitly set `["project"]` by default so CLAUDE.md is guaranteed
4. **Session list endpoint** — `GET /api/sessions` scanning `~/.claude/projects/`
5. **Test profile** — define a `test-harness` profile with haiku, limited tools, no persistence

### Next Phase (with frontend)

6. **WebSocket upgrade** — for streaming input mode (real multi-turn without resume overhead)
7. **Query instance management** — hold Query objects in memory, expose interrupt/model/rewind
8. **Permission mode selection** — expose non-bypass modes for LAN access
9. **MCP server management** — define allowed MCP servers in harness config, expose by name
