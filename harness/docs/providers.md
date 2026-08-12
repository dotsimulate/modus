---
title: Provider System
lastUpdated: 2026-08-09
lastCommit: a9adf68
covers: harness/providers/ harness/modus-plugins.ts harness/templates/providers/ harness/session-manager.ts harness/skill-attachment.ts
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
steerMessage?(ctx, content) — inject into a turn already running (see Steering)
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
| `claude-code-pty` | claude-code | Persistent Claude Code CLI process | Full MCP, runtime-native permissions, warm PTY across turns, steer |
| `codex` | codex | OpenAI Codex CLI | Full MCP, event-derived tools, Codex sandbox/approval settings |
| `cursor` | cursor | Cursor Agent CLI subprocess | Full MCP via `.cursor/mcp.json`, event-derived tools, `--approve-mcps` |
| `grok-build` | grok-build | xAI Grok Build CLI (`grok agent stdio`) | Persistent ACP session, full MCP, streaming tool/thought events, live Modus approvals |
| `opencode` | opencode | OpenCode CLI subprocess | Full MCP, event-derived tools, `bunx opencode-ai` fallback |
| `openai-compat` | pi-agent | Generic OpenAI-compatible endpoint (LiteLLM defaults) | PI agent loop, MCP via mcp-bridge, steer; `litellm` remains an accepted legacy alias |
| `ollama` | pi-agent | Ollama API | PI agent loop, MCP via mcp-bridge, steer |
| `openrouter` | pi-agent | OpenRouter API | PI agent loop, MCP via mcp-bridge, steer |

## Hidden providers

`HIDDEN_LEGACY_PROVIDER_NAMES` (`providers/provider-definition.ts`) names providers
that stay out of `listProviders()`, and therefore out of `GET /api/providers`, the
pickers, `listProviderCapabilities()`, and the health sweep. They remain fully
`isKnownProvider()`, so a profile naming one validates and runs.

| Name | Family | Implementation | Why it is hidden |
|------|--------|---------------|-------------------|
| `antigravity` | antigravity | Google Antigravity CLI (`agy`) | Google's terms prohibit using third-party software to access the Service, and enforcement has suspended paid accounts across Antigravity, Gemini CLI, and Code Assist at once. Modus spawns only the user's own signed-in binary and never touches its credentials, but the exposure falls on the user's Google account, so it is opt-in by name. |
| `gemini-cli` | gemini-cli | Gemini CLI | The free OAuth tier ended and Modus refuses to reuse those credentials; `getProvider` throws unless a paid API, Vertex AI, or compute-ADC deployment is configured explicitly. |

Neither is deprecated: `antigravity` keeps native UUID resume, JSON Hook tool
events/approvals, and the full MCP transport bridge described below.

## Declarative PI providers

PI-backed endpoints are data, not new `SessionProvider` implementations. Add a
strict JSON definition at `<MODUS_HOME>/providers/<name>.json`, or ship one from
an enabled plugin at `<plugin>/.modus/providers/<name>.json`. Providers are
machine-global; project-local `.modus/providers` directories are not scanned,
because provider/profile validity must not change with the active project.

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

Supported fields are:

- `name` (required kebab-case), `label`, and `kind: "pi"`;
- `api`, one of pi-ai's ten shipped protocols: `openai-completions`,
  `mistral-conversations`, `openai-responses`,
  `azure-openai-responses`, `openai-codex-responses`,
  `anthropic-messages`, `bedrock-converse-stream`,
  `google-generative-ai`, `google-gemini-cli`, or `google-vertex`;
- `baseUrl` and optional `apiKeyName`. The latter is a Modus secret name;
  literal `apiKey` values are rejected;
- optional `apiKeyRequired` (default `true`). Naming a secret normally declares
  it required, so an unset one reports `misconfigured`. Set `false` for an
  endpoint that accepts unauthenticated local requests but can optionally take a
  key — a local LiteLLM, Ollama, vLLM, or llama.cpp;
- `defaultModel`, `contextWindow`, `maxOutputTokens`, `reasoning`, `input`,
  `headers`, and four-way `cost` rates;
- `compat`, only with `openai-completions` or `openai-responses`;
- `health: { "type": "http", "url": "..." }`, otherwise health probes
  `<resolved baseUrl>/models`; and
- `pricing: { "source": "openrouter", "url": "..." }` for live per-model cost
  and context length. `source` names the *response shape*, not the vendor: any
  gateway serving an OpenRouter-compatible model list (`data[].pricing.prompt`,
  `.completion`, `.input_cache_read`, `.input_cache_write` as per-token strings,
  plus `context_length`) can declare it under any provider name. `url` defaults
  to `<resolved baseUrl>/models`, and the request carries the definition's
  `headers` and resolved `apiKeyName` secret. Omit the block and the static
  `cost` and `contextWindow` are used as-is. Results are cached per provider for
  the process lifetime, including a negative cache so an unreachable endpoint is
  not retried every turn.

Definitions reject unknown fields. A misspelling must fail discovery visibly
instead of producing a session that silently ignores the intended setting.
Invalid files are logged and skipped without suppressing valid siblings.
`headers` values are literal shareable configuration, not secret references;
use `apiKeyName` for bearer credentials and do not place secrets in a template
or plugin definition. The current schema cannot safely express a different
sensitive custom header.

Precedence is built-in, then user home, then enabled plugins. Neither user nor
plugin definitions may shadow a built-in name or alias; user definitions beat a
same-named plugin definition. The built-in generic endpoint is
`openai-compat`. `litellm` remains a permanent accepted alias and continues to
read `LITELLM_BASE_URL` and `LITELLM_API_KEY`, so existing profiles and secrets
need no migration. Other base-URL overrides derive from the definition name
(`my-gateway` â†’ `MY_GATEWAY_BASE_URL`); credentials use the explicit
`apiKeyName`.

Definitions are read from disk on every lookup, like every other authored
primitive — adding or editing one takes effect on the next session with no
restart. A session already running keeps the model object it started with.
New PI definitions inherit native
skill loading, injected skill paths, mid-turn steering, and sessionless
one-shot completion. Their lowercase tool groups and display labels come from
backend capabilities rather than frontend name inference.

Examples ship under `templates/providers/` for LM Studio, remote Ollama,
remote LiteLLM, vLLM, llama.cpp, and a generic gateway. They are examples only
and are not auto-registered. `POST /api/providers/detect` is an explicit,
read-only localhost probe: it checks known ports against the `/v1/models`
response shape and returns definition proposals. It never writes or registers
one. The response-shape check is essential on port 8080, which may instead be
the configured speech-to-text service.

## Steering (mid-turn message delivery)

A message sent while a turn is running lands in one of two places, and which one
is a property of the provider:

- **`messageDelivery: "steer"`** — the harness injects it into the turn in
  flight and the agent reads it at the next tool boundary.
- **`messageDelivery: "next-turn"`** — there is no injection point, so it waits
  in `session.pendingDispatch` and is delivered when the turn ends.

The field is derived centrally in `registry.ts` from `isSteerableProvider()` in
`providers/provider-names.ts` — the same pattern as `readsNativeSkills` — rather
than declared per provider, so clients can ask `/api/provider-capabilities`
which will happen *before* sending. `providers/steering.test.ts` fails if that
list and the actual
`steerMessage` implementations drift apart.

Three providers can steer, each through a live input channel that stays open
after the turn starts:

| Provider | Channel |
|----------|---------|
| `claude-code` | the Agent SDK's streaming-input iterator |
| `claude-code-pty` | stdin, kept open by `--input-format stream-json` |
| Any declarative PI provider, including `openai-compat`, `ollama`, and `openrouter` | `AgentSession.sendUserMessage(content, { deliverAs: "steer" })` |

Every other provider runs one prompt per turn with no way in.

`steerMessage()` may still return `false` at the moment of the call — an
interrupted PTY generation is unwinding, or the turn ended in between — so the
caller always has a queue fallback. `session-manager.steerMessage()` reports
which happened as `mode: "steer" | "queued"`; a `"queued"` result carries a
`dispatchId` that cancels it. Treating those two as the same outcome is what
makes a UI lie about whether the agent has the message.

Steering takes the same per-message `moves` bindings as an ordinary send, so a
move can be attached to an interjection. The gathers run once, before injection;
if the provider then declines, the already-gathered text is queued rather than
re-gathered, because activation has side effects (persistent registration, API
token minting).

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

### Additional workspace roots

Every current provider consumes `additionalDirectories`. PI's upstream
`createCodingTools(cwd)` has one primary root, but its file tools accept
absolute paths and bash is already unrestricted. Modus adds declared roots to
PI's resource system prompt and every coding-tool description so the agent can
address them by absolute path. PI still loads `CLAUDE.md` and skills from the
primary `cwd`; Modus explicitly adds `<cwd>/.claude/skills` when present for
cross-provider plugin skills. Extra roots widen coding access, not
resource-loader discovery.

### Skills

Only the Claude-family CLIs and the PI providers read skills at all
(`readsNativeSkills` in `provider-names.ts`, surfaced on `ProviderCapabilities`
so the composer's `/` picker can stop offering native skills to providers that
ignore them). Everything else reads none.

PI is the one provider Modus can hand specific skills to: `additionalSkillPaths`
accepts individual `SKILL.md` file paths as well as directories, so attached
skills are passed as files rather than as a root — otherwise every skill
installed under `.modus/skills/` would load, not just the attached ones. Native
roots are passed first, and PI keeps the first path on a name collision, so a
user's own skill always wins. Sessions on PI therefore do **not** get the Modus
skill tools; every other provider does. See `skills`.

The embedded `gemini-cli` adapter is hidden legacy migration code. It is accepted
only when a paid Gemini API key, explicit Vertex AI configuration, Cloud Shell,
or compute ADC is present. It never consumes `~/.gemini/oauth_creds.json`.

### Antigravity support boundary

This provider is hidden from the pickers (see Hidden providers above) and runs
only when a profile names it explicitly.

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

Browser/account login is sufficient, and carries Grok Build access for SuperGrok
and X Premium+ subscribers rather than a free tier. `XAI_API_KEY` is the
alternative for non-browser or API-backed environments and needs no
subscription. Eligibility and limits are xAI's to change; verify the entitlement
shown after sign-in rather than relying on this paragraph.

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
| Any declarative PI provider | resolved `<baseUrl>/models`, or its explicit `health.url`; definition headers and named Modus secret are included |

A definition that names `apiKeyName` but has no such secret reports
`misconfigured` without attempting the request. Definitions that set
`apiKeyRequired: false` are exempt: the key is used when present and its absence
is not an error. The built-in `openai-compat` and Ollama definitions set that
flag, so they keep working unauthenticated against a local endpoint; OpenRouter
leaves it at the default and requires its named key.

### CLI resolution

`providers/resolve-cli.ts` locates every provider CLI, for both health checks and
session spawn. `PATH` is authoritative and always tried first; everything else is
a fallback consulted only when it comes up empty, and none of it overrides a
binary `PATH` already found.

The fallbacks exist because a launched app inherits the environment of whatever
started it, which is a snapshot taken before the user's most recent CLI install:

- **Linux/macOS** — a packaged desktop app gets the session manager's `PATH`
  (roughly `/usr/local/bin:/usr/bin`), so user-owned prefixes are probed
  directly: `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `~/.claude/local`,
  `/opt/homebrew/bin`.
- **Windows** — the process `PATH` is Explorer's copy, which Explorer rebuilds
  only at sign-in. A directory an installer appended to the *persisted* user
  `PATH` is therefore invisible to an already-running Modus until the next
  reboot, even though every newly opened terminal finds it. The persisted user
  and machine values are read back from the registry (`HKCU\Environment` and the
  `Session Manager\Environment` machine key) and used as a fallback `PATH`,
  cached for the process lifetime. The Grok Build CLI installs to
  `%USERPROFILE%\.grok\bin` and is the common case.

A provider that cannot find its CLI fails the turn before it starts and reports
the reason as a persisted system message, so the explanation survives a reload
rather than living only on whichever stream happened to be open. Setting the
provider's explicit path override (`MODUS_GROK_CLI`, `CLAUDE_PATH`) skips the
search entirely.

**Source**: `providers/resolve-cli.ts`.

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

This filters only *inherited* values. Resolved provider credentials and
`$SECRET` references in MCP config are layered on explicitly afterwards and are
unaffected. Profile `env` is provider-specific rather than a universal layer:
the Claude Code SDK and Grok Build providers consume it today; other CLI
providers ignore it, and in-process PI providers use definition fields plus
Modus secrets instead. Set `MODUS_PROVIDER_ENV_PASSTHROUGH=1` to opt out
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
