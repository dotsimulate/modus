---
title: Provider System
lastUpdated: 2026-07-07
lastCommit: a9adf68
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
steerMessage?(ctx, content) — inject mid-turn at next tool boundary (Claude SDK only)
                              returns true if injected, false to fall back to queue
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
- `notifyConfigChange(patch)` — provider-initiated config change; updates `_configOverrides` and emits `config_updated` to subscribers
- `updateSessionDb()` — update session row

## Registered Providers

| Name | Family | Implementation | Notes |
|------|--------|---------------|-------|
| `claude-code` | claude-code | Claude Agent SDK subprocess | Full MCP, live per-tool UI permissions, task stop, steer |
| `claude-code-pty` | claude-code | Persistent Claude Code CLI process | Full MCP, runtime-native permissions, warm PTY across turns |
| `codex` | codex | OpenAI Codex CLI | Full MCP, event-derived tools, Codex sandbox/approval settings |
| `cursor` | cursor | Cursor Agent CLI subprocess | Full MCP via `.cursor/mcp.json`, event-derived tools, `--approve-mcps` |
| `gemini-cli` | gemini-cli | Gemini CLI runtime | Full MCP, Gemini-owned approval policy |
| `opencode` | opencode | OpenCode CLI subprocess | Full MCP, event-derived tools, `bunx opencode-ai` fallback |
| `litellm` | pi-agent | LiteLLM proxy | PI agent loop, MCP via mcp-bridge |
| `ollama` | pi-agent | Ollama API | PI agent loop, MCP via mcp-bridge |
| `openrouter` | pi-agent | OpenRouter API | PI agent loop, MCP via mcp-bridge |

PI agent providers share a single implementation (`pi-agent.ts`) parameterized
by provider name. They implement a lightweight tool-use agent loop with
compaction support.

## Effort Resolution

`effort` follows the standard cascade: session override → agent profile → user profile default.
`session-manager.ts` resolves this before creating `TurnContext`, so providers always receive
the fully-resolved value.

Provider-specific normalization:
- **claude-code / claude-code-pty**: `"off"` disables thinking. Other effort values are passed to Claude Code.
- **codex**: `"off"` disables reasoning. `"low"/"medium"/"high"/"xhigh"` map to Codex reasoning effort; `"max"` maps to `"xhigh"`.
- Other providers accept the resolved effort only if their implementation uses it.

## Claude Permission Mode

The Claude providers read `opts.providerControls.claude.permissionMode` to set permission mode. Valid values: `"default"`, `"acceptEdits"`, `"plan"`, `"dontAsk"`. The SDK provider can update this through its `updateConfig` path; the PTY provider applies config changes on the next turn or process restart.

When the agent calls the `ExitPlanMode` tool, the provider automatically resets `permissionMode` to `"default"` and notifies session-manager via `notifyConfigChange`, so the config_updated event reflects the cleared state.

## Provider Health

`checkAllProviderHealth()` reports readiness from registry-declared prerequisites:

| Provider | Checks |
|----------|--------|
| `claude-code`, `claude-code-pty` | `claude` CLI |
| `codex` | `codex` CLI plus `CODEX_API_KEY` / `OPENAI_API_KEY` or `~/.codex/auth.json` |
| `cursor` | `cursor-agent` CLI (or configured resolver path) |
| `gemini-cli` | Google OAuth in `~/.gemini/oauth_creds.json` or `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| `opencode` | `opencode` CLI, or `bunx` for `opencode-ai` fallback |
| `litellm` | local proxy health at `LITELLM_BASE_URL` or `http://localhost:4000` |
| `ollama` | local server at `OLLAMA_HOST` or `http://localhost:11434` |
| `openrouter` | `OPENROUTER_API_KEY` |

## MCP Server Composition

MCP servers are merged from multiple sources when a session starts:

1. Built-in `modus` server (always present, HTTP transport to harness)
2. Base `_global.json` mcpServers
3. Project `.modus/_global.json` mcpServers (additive)
4. Agent profile `mcpServers` field

Environment variables injected into MCP servers:
- `AGENT_PROFILE` — active agent profile name
- `USER_PROFILE` — active user profile name

Provider-specific wiring differs: Claude uses SDK/CLI MCP config, Cursor writes a temporary `.cursor/mcp.json`, Codex passes MCP config through its CLI wrapper, Gemini builds runtime MCP servers, and PI providers use `mcp-bridge.ts`.

**Source**: `providers/claude-code.ts` (MCP merge), `providers/cursor.ts`
(MCP via .cursor/mcp.json), `providers/codex.ts` (MCP via config object),
`providers/gemini-cli.ts`, `providers/opencode.ts`,
`providers/mcp-bridge.ts` (MCP lifecycle for PI agents),
`providers/registry.ts` (provider lookup).
