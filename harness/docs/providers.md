---
title: Provider System
audience: agents
lastUpdated: 2026-03-11
lastCommit: cf9d454
covers: harness/providers/ harness/session-manager.ts
---

# Provider System

Providers are execution backends. They implement the `SessionProvider` interface
from `providers/types.ts` and handle the actual agent loop.

## SessionProvider Interface

```
startTurn(ctx)           — kick off a turn, emit events via ctx
sendMessage(ctx, content) — follow-up message to idle/running session
abort(session)           — stop current turn
stopTask?(session, id)   — stop a sub-task (Claude SDK only)
updateConfig?(session, config) — mutate config mid-session
switchProfile?(session, ctx, contextMode) — swap profile mid-session
dispose?(session)        — cleanup on shutdown
```

Providers do NOT own persistence or SSE — they call `ctx.emitEvent()` and
`ctx.updateSessionDb()` to interact with session-manager's infrastructure.

## TurnContext

Passed to providers by session-manager. Contains:
- `session` — the ActiveSession object
- `opts` — original StartSessionOpts
- `profile` — resolved agent profile (or undefined)
- `emitEvent()` — persist + broadcast
- `broadcastEvent()` — broadcast only (no DB)
- `rekeySession()` — replace temp session ID with real one
- `updateSessionDb()` — update session row

## Registered Providers

| Name | Family | Implementation | Notes |
|------|--------|---------------|-------|
| `claude-code` | claude-code | Claude Agent SDK subprocess | Full MCP, tool permissions, sub-agents |
| `codex` | codex | OpenAI Codex CLI | Sandbox modes, no MCP |
| `gemini-cli` | gemini-cli | Gemini CLI subprocess | Streaming, no MCP |
| `anthropic` | pi-agent | Direct Anthropic API | PI agent loop |
| `openai` | pi-agent | OpenAI-compatible API | PI agent loop |
| `litellm` | pi-agent | LiteLLM proxy | PI agent loop, local models |
| `ollama` | pi-agent | Ollama API | PI agent loop, local models |
| `openrouter` | pi-agent | OpenRouter API | PI agent loop |

PI agent providers share a single implementation (`pi-agent.ts`) parameterized
by provider name. They implement a lightweight tool-use agent loop with
compaction support.

## MCP Server Composition

MCP servers are merged from multiple sources when a session starts:

1. Built-in `modus` server (always present, HTTP transport to harness)
2. Base `_global.json` mcpServers
3. Project `.modus/_global.json` mcpServers (additive)
4. Agent profile `mcpServers` field

Environment variables injected into MCP servers:
- `AGENT_PROFILE` — active agent profile name
- `USER_PROFILE` — active user profile name
- `AGENT_MEMORY_DIR` — project-local memory path (if exists)
- `AGENT_MEMORY_SKILLS_DIRS` — skills search paths from user profile projects

Relative `--directory` args are resolved from harness root.

**Source**: `providers/claude-code.ts` (MCP merge), `providers/mcp-bridge.ts`
(MCP lifecycle), `providers/registry.ts` (provider lookup).
