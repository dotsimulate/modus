---
title: Provider System
lastUpdated: 2026-07-14
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
- `setProviderSessionId()` — persist a provider-native conversation/thread ID without replacing the Modus ID
- `notifyConfigChange(patch)` — provider-initiated config change; updates `_configOverrides` and emits `config_updated` to subscribers
- `updateSessionDb()` — update session row

## Registered Providers

| Name | Family | Implementation | Notes |
|------|--------|---------------|-------|
| `claude-code` | claude-code | Claude Agent SDK subprocess | Full MCP, live per-tool UI permissions, task stop, steer |
| `claude-code-pty` | claude-code | Persistent Claude Code CLI process | Full MCP, runtime-native permissions, warm PTY across turns |
| `codex` | codex | OpenAI Codex CLI | Full MCP, event-derived tools, Codex sandbox/approval settings |
| `cursor` | cursor | Cursor Agent CLI subprocess | Full MCP via `.cursor/mcp.json`, event-derived tools, `--approve-mcps` |
| `antigravity` | antigravity | Google Antigravity CLI (`agy`) | Native UUID resume, JSON Hook tool events/approvals, full MCP transport bridge |
| `grok-build` | grok-build | xAI Grok Build CLI (`grok agent stdio`) | Persistent ACP session, full MCP, streaming tool/thought events, live Modus approvals |
| `opencode` | opencode | OpenCode CLI subprocess | Full MCP, event-derived tools, `bunx opencode-ai` fallback |
| `litellm` | pi-agent | LiteLLM proxy | PI agent loop, MCP via mcp-bridge |
| `ollama` | pi-agent | Ollama API | PI agent loop, MCP via mcp-bridge |
| `openrouter` | pi-agent | OpenRouter API | PI agent loop, MCP via mcp-bridge |

## Model selection

Provider model endpoints return suggestions, not an allowlist. Model values in
agent profiles, user-profile defaults, session setup, and live session config
are open strings and are passed to the selected provider. Every model picker
accepts a custom value so a newly released model or private deployment can be
used before Modus adds it to the suggestions. Claude Code suggestions include
current full model IDs and its durable aliases (`default`, `best`, `opus`,
`sonnet`, `haiku`, extended-context aliases, and `opusplan`).

PI agent providers share a single implementation (`pi-agent.ts`) parameterized
by provider name. They implement a lightweight tool-use agent loop with
compaction support.

The embedded `gemini-cli` adapter is hidden legacy migration code. It is accepted
only when a paid Gemini API key, explicit Vertex AI configuration, Cloud Shell,
or compute ADC is present. It never consumes `~/.gemini/oauth_creds.json`.

### Antigravity support boundary

Modus runs documented `agy --print` turns and resumes them with
`--conversation <uuid>`. A Modus-owned plugin, installed through `agy plugin`,
uses the documented `PreInvocation`, `PreToolUse`, `PostToolUse`, and `Stop`
JSON Hooks to capture the native UUID, observe tool lifecycle, and gate tools in
the Modus approval UI. A turn-scoped MCP fan-in server exposes profile/global
stdio, SSE, and Streamable HTTP servers without overwriting the user's own
Antigravity configuration.

`providerControls.antigravity.mode` maps to `agy --mode` (`accept-edits` or
`plan`), `sandbox` maps to `agy --sandbox`, and `printTimeout` maps to
`--print-timeout`. Profile instructions are injected as documented
`PreInvocation` ephemeral messages rather than being disguised as user text.

Antigravity's current headless interface does not expose structured model-event
streaming, thought/token/quota metrics, non-interactive image attachment,
structured `ask_question` responses, arbitrary-message fork, or programmatic
rewind. It also has no `effort`, `maxTurns`, or disable-project-context flag;
Modus reports those mismatches instead of simulating them. The TUI's `/fork`
and `/rewind` commands remain interactive Antigravity features, not provider
APIs.

### Grok Build support boundary

Modus starts one `grok --no-auto-update agent stdio` ACP child per active
session. It performs ACP initialization and authentication, creates or loads the
provider-native Grok session, and keeps that process warm for follow-up turns.
Text, thought, tool, permission, usage, cancellation, image, model, and MCP data
use their native ACP messages rather than terminal-output scraping.

Install and authenticate the official CLI first:

```powershell
irm https://x.ai/cli/install.ps1 | iex
grok login
```

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

Browser/account login is sufficient; `XAI_API_KEY` is an optional alternative
for non-browser or API-backed environments. xAI currently advertises limited
free Grok Build access, so a paid subscription is not required while that offer
and the account's eligibility remain active.

`providerControls.grokBuild.mode` selects `default`, `auto`, `plan`, or
`always-approve`. `sandbox` maps to the Grok sandbox profile; `noMemory`,
`noSubagents`, and `disableWebSearch` map to their documented CLI flags. Profile
prompt replacement/appending maps to Grok's system-prompt override/rules flags.
Model lists are discovered from ACP initialization, with `grok-4.5` used only as
an offline UI fallback.

## Effort Resolution

`effort` follows the standard cascade: session override → agent profile → user profile default.
`session-manager.ts` resolves this before creating `TurnContext`, so providers always receive
the fully-resolved value.

Provider-specific normalization:
- **claude-code / claude-code-pty**: `"off"` disables thinking. Other effort values are passed to Claude Code.
- **codex**: `"off"` disables reasoning. `"low"/"medium"/"high"/"xhigh"` map to Codex reasoning effort; `"max"` maps to `"xhigh"`.
- Other providers accept the resolved effort only if their implementation uses it.
- **grok-build**: effort is applied at ACP process startup and included in prompt metadata for compatible Grok versions.

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
| `antigravity` | `agy` CLI plus an authenticated `agy models` probe |
| `grok-build` | `grok` CLI plus a headless ACP authentication probe (`grok login` or `XAI_API_KEY`) |
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

Provider-specific wiring differs: Claude uses SDK/CLI MCP config, Cursor writes a temporary `.cursor/mcp.json`, Codex passes MCP config through its CLI wrapper, Antigravity uses its validated Modus plugin and turn-scoped MCP fan-in bridge, Grok Build receives the merged servers in ACP `session/new`/`session/load`, and PI providers use `mcp-bridge.ts`.

### Child credential boundary

Every provider CLI is spawned from a filtered environment built by
`providers/child-env.ts`. OS, `PATH`, locale, proxy, and provider runtime
variables are preserved; Modus credentials (`HARNESS_TOKEN`, `HARNESS_PIN`,
`HARNESS_SECRETS_FILE`, `HARNESS_TLS_KEY`, `MODUS_PIN`, `MODUS_TOKEN`) are not
inherited. Without this, every shell command an agent runs — and every MCP stdio
server and subagent beneath it — inherits full Modus API authority regardless of
the provider's own permission model.

This filters only *inherited* values. Profile `env`, resolved provider
credentials, and `$SECRET` references in MCP config are layered on explicitly
afterwards and are unaffected. Set `MODUS_PROVIDER_ENV_PASSTHROUGH=1` to opt out
(for example to drive the Modus SDK CLI from inside a session).

Credential-bearing files are written to process-private storage:

- **Cursor** has no flag for an alternative MCP config path, so it still writes
  `<project>/.cursor/mcp.json` while a turn runs. That write goes through a
  durable journal in the runtime directory (`providers/cursor-mcp-config.ts`),
  so a crashed backend's file is restored on the next start instead of being
  stranded in a frequently git-tracked directory. A file the user edited while
  the session ran is never clobbered.
- **Antigravity** hook/IPC directories use `sensitive-temp.ts` (0700 directory,
  0600 files, per-turn), not a predictable shared temp path. Directories left by
  a dead process are pruned at startup; directories owned by a live process are
  left alone.

**Source**: `providers/claude-code.ts` (MCP merge), `providers/cursor.ts`
(MCP via .cursor/mcp.json), `providers/codex.ts` (MCP via config object),
`providers/antigravity.ts`, `providers/antigravity-plugin.ts`,
`providers/antigravity-mcp-bridge.ts`, `providers/opencode.ts`,
`providers/grok-build.ts`, `providers/grok-build-acp.ts`,
`providers/mcp-bridge.ts` (MCP lifecycle for PI agents),
`providers/registry.ts` (provider lookup).
