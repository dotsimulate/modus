---
title: PI Agent System
lastUpdated: 2026-07-30
lastCommit: a9adf68
covers: harness/providers/pi-agent.ts harness/providers/pi-model.ts harness/providers/provider-definition.ts harness/providers/provider-definitions.ts harness/providers/mcp-bridge.ts
---

# PI Agent System

The PI Agent backend is one `SessionProvider` implementation parameterized by a
strict provider definition. It serves the built-in `openai-compat`, `ollama`,
and `openrouter` definitions plus user- and plugin-authored definitions.
`litellm` remains an accepted legacy alias of `openai-compat`.

```
Provider Name     Engine                    Notes
-------------     --------------------      ------------------------------
openai-compat     PI AgentSession           Generic OpenAI-compatible endpoint
ollama            PI AgentSession           OpenAI-compatible Ollama API
openrouter        PI AgentSession           declares pricing: live cost/context
<user-defined>    PI AgentSession           Protocol and endpoint from JSON
```

All providers share `SessionProvider`, the harness SSE event format, and DB
persistence. Session-manager does not contain PI-specific routing.

## Key files

```
providers/
  types.ts                  SessionProvider and TurnContext contracts
  registry.ts               Standalone routing, PI factory, capabilities, health
  provider-definition.ts    Strict data shape, built-ins, aliases
  provider-definitions.ts   User/plugin discovery, precedence, cache
  pi-model.ts               Shared model, endpoint, credential resolution
  pi-agent.ts               AgentSession lifecycle and event translation
  mcp-bridge.ts             External MCP servers to PI tools
```

## Model construction

`buildPiModel()` creates the PI `Model` used by both agent sessions and
sessionless one-shot calls. These fields come from the selected definition:

- `api`, `baseUrl`, `headers`, `reasoning`, and `input`;
- `cost` rates and OpenAI compatibility flags;
- default model, context window, and maximum output tokens.

Profile and global `providerDefaults` context/output limits retain higher
precedence. An API-reported context length also beats the definition fallback.

Any definition declaring a `pricing` block additionally fetches per-model cost
and context metadata on first use and caches the result per provider for the
process. Those live values override the definition's static cost/context
fallbacks. The built-in `openrouter` definition declares it; so may a user
definition pointing at OpenRouter or any OpenRouter-compatible gateway under a
different name. This is driven by the definition field, never by the provider
name — see `providers.md` for the shape.

The definition `api` is one of pi-ai's ten shipped protocols, not merely
OpenAI-compatible chat completions. `compat` is accepted only for
`openai-completions` and `openai-responses`, matching pi-ai's conditional
`Model` type.

## Authentication and endpoint overrides

`buildAuthStorage()` resolves the definition's `apiKeyName` through Modus
secrets or environment variables and injects the value at the top of PI's auth
chain. Definition files cannot contain a literal `apiKey`.

The base URL comes from the definition and may be overridden by the derived
`<PROVIDER_NAME>_BASE_URL` Modus secret/environment name. The canonical
`openai-compat` provider deliberately retains the legacy
`LITELLM_BASE_URL`/`LITELLM_API_KEY` names.

Profile `env` is not applied to PI's in-process HTTP calls. Use definition
fields and Modus secrets instead. `providerControls.pi.extraBody` also remains
specific to `openai-completions`: its scoped fetch patch matches
`/chat/completions`, so it does not alter requests for the other protocols.

## Session lifecycle

1. **startTurn** rekeys a temporary session to a UUID, builds the definition
   model, tools, resource loader, auth storage, and MCP connections, subscribes
   to PI events, then prompts the `AgentSession`.
2. **sendMessage** sends directly when idle. During a running turn the steering
   path uses `sendUserMessage(content, { deliverAs: "steer" })`.
3. **abort** aborts the `AgentSession` and turn controller.
4. **dispose** unsubscribes, disposes the session, and closes MCP connections.

PI session state is in memory. The provider refuses to fabricate a
context-free replacement after a backend restart.

Auto-retry is disabled; the harness owns retry/lifecycle policy. Compaction uses
profile/provider-default settings and reserves at least the model output budget.

## Event translation

PI `AgentSessionEvent` values are translated to the same event shapes consumed
by the frontend reducer:

```
PI Event                     Harness Event
--------                     -------------
message_update text delta    stream_event text delta
message_update thinking      stream_event thinking delta
tool_execution_start         assistant tool_use
tool_execution_end           synthetic user tool_result
agent_end                    result with tokens, cost, duration
```

Text and thinking stream as deltas. Tool calls emit complete assistant/user
messages. `agent_end` does not emit the assistant text a second time.

## MCP bridge

Global, project, profile, and session MCP servers merge before a PI session
starts. `mcp-bridge.ts` connects stdio, SSE, and Streamable HTTP transports,
lists their tools, and wraps each as a PI tool named
`mcp__<server>__<tool>`.

Stdio `$VAR` references resolve through Modus secrets. Connections close when
the provider is disposed.

## Tool namespaces

Claude and PI use different tool names:

```
Claude (PascalCase)          PI (lowercase)
Read, Write, Edit            read, write, edit
Glob, Grep                   grep, find, ls
Bash                         bash
```

Provider capabilities expose PI's lowercase groups to the UI. Live profile and
session controls use those capabilities directly. Static frontend catalogs are
offline fallbacks for known built-ins only; an unknown provider with no
capability record gets no tool groups rather than Claude's groups.

## Skills and additional roots

`DefaultResourceLoader` reads PI-native skills and `CLAUDE.md`. Modus passes
attached `SKILL.md` files individually through `additionalSkillPaths`, so
attaching one skill never exposes every installed Modus skill. Native paths
come first and win name collisions.

PI file tools accept absolute paths. Modus adds `additionalDirectories` to the
system prompt and coding-tool descriptions so the model can address every
declared root; the primary cwd remains the resource-loader root.

## Errors and health

`friendlyError()` names the resolved definition endpoint for connection
failures and translates common model, auth, not-found, and rate-limit errors.

Provider health resolves the same base URL and secret as model construction,
then probes the definition's explicit `health.url` or
`<resolved baseUrl>/models`. A custom definition naming an unset `apiKeyName`
reports `misconfigured` without making the request.

## Authoring a PI provider

Create `<MODUS_HOME>/providers/<name>.json`:

```json
{
  "name": "lmstudio",
  "label": "LM Studio (local)",
  "kind": "pi",
  "api": "openai-completions",
  "baseUrl": "http://127.0.0.1:1234/v1",
  "defaultModel": "default",
  "input": ["text", "image"]
}
```

Restart after editing. The provider appears in `/api/providers`; the display
label and lowercase tools come from `/api/provider-capabilities`; model
suggestions and health use the same resolved endpoint.

Definitions may also ship from an enabled plugin's
`.modus/providers/*.json`. User definitions win plugin collisions, and no
definition may shadow a built-in name or alias. See `providers` for the complete
strict shape, precedence, shipped examples, secret handling, and explicit
localhost detection API.
