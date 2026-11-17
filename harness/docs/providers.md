---
title: Provider System
lastUpdated: 2026-08-22
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
- `broadcastEvent()` — broadcast without persisting
- `rekeySession()` — rename the Modus session to a provider-chosen ID. Clients holding the old ID are told (`session_rekeyed`) and it stays an alias, but prefer `setProviderSessionId()` for new providers: the Modus ID then never changes
- `setProviderSessionId()` — persist a provider-native conversation/thread ID without replacing the Modus ID
- `notifyConfigChange(patch)` — provider-initiated config change; updates `_configOverrides` and emits `config_updated` to subscribers
- `updateSessionDb()` — update session row

## Event persistence

Which of the two emit methods a provider calls is a request, not the decision.
Two event types override it, and `harness/event-persistence.ts` is the single
source for both:

| Event type | Persistence | Why |
|------------|-------------|-----|
| `stream_event` | always live-only | Token-level stream; deltas are coalesced before broadcast and the assistant turn is materialized separately, so persisting it would store the turn twice. |
| `error` | always durable | A terminal error must outlive whichever socket happened to be open, and a pre-flight failure is emitted before any assistant turn exists, so nothing else records it. |
| everything else | as requested | `emitEvent()` persists, `broadcastEvent()` does not. |

The practical consequence for provider authors: report a launch or pre-flight
failure with `ctx.broadcastEvent({ type: "error", error })`. Do **not** reach for
`ctx.emitEvent({ type: "result", subtype: "error" })` — a `result` event with no
assistant turn in flight is dropped during history reconstruction
(`session-history.ts`), so the failure is visible live and gone after reload.

### User prompts

Session-manager records a sent or queued message only as a `user/prompt_pending`
row, which keeps the text through a backend death but is not a transcript turn.
The provider owns the turn: emit
`ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content } })`
when each message actually reaches the agent. That includes the first message,
every follow-up pushed into a live process, and every queued message flushed
after a turn ends. Emit a flushed message after the `result` that ended the
previous turn, not before it, or that turn loses its usage on reload. Do not emit
one for content the user did not send, such as a synthesized continuation.
Steered messages are the exception: session-manager records those itself when
`steerMessage` returns true.

History reconstruction recovers a pending row when a reply starts with no prompt
before it, which repairs sessions written before every provider did this. It is
a repair, not a substitute: the turn index, history paging, and single-turn
lookups key on `user/prompt` rows.

## Registered Providers

| Name | Family | Implementation | Notes |
|------|--------|---------------|-------|
| `claude-code` | claude-code | Claude Agent SDK subprocess | Full MCP, live per-tool UI permissions, task stop, steer |
| `claude-code-pty` | claude-code | Persistent Claude Code CLI process | Full MCP, runtime-native permissions, warm PTY across turns, steer |
| `codex` | codex | OpenAI Codex CLI | Full MCP, event-derived tools, Codex sandbox/approval settings |
| `cursor` | cursor | Cursor Agent CLI subprocess | Full MCP via `.cursor/mcp.json`, event-derived tools, `--approve-mcps` |
| `antigravity` | antigravity | Google Antigravity CLI (`agy acp`) | Persistent ACP session on the user's Google AI plan, full MCP, streaming tool/thought events, live Modus approvals, steer |
| `grok-build` | grok-build | xAI Grok Build CLI (`grok agent stdio`) | Persistent ACP session, full MCP, streaming tool/thought events, live Modus approvals |
| `muse-code` | muse-code | Meta Muse Code CLI (`muse serve`) | Persistent MSP session, full MCP, streaming tool/reasoning events, live Modus approvals, steer |
| `opencode` | opencode | OpenCode CLI subprocess | Event-derived tools, `bunx opencode-ai` fallback; Modus MCP injection is not implemented |
| `openai-compat` | pi-agent | Generic OpenAI-compatible endpoint (LiteLLM defaults) | PI agent loop, MCP via mcp-bridge, steer; `litellm` remains an accepted legacy alias |
| `ollama` | pi-agent | Ollama API | PI agent loop, MCP via mcp-bridge, steer |
| `openrouter` | pi-agent | OpenRouter API | PI agent loop, MCP via mcp-bridge, steer |

## Retired Gemini CLI adapter

The standalone `gemini-cli` adapter is excluded from the distributed app. It is
not a provider choice, and an old profile naming it must be changed before
starting a new session. Gemini CLI no longer serves individual Google accounts.
For a Google AI Pro or Ultra plan, use the `antigravity` provider. For paid
Google API access, use a declarative provider definition with your own API key
or Vertex AI configuration.

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
- `api`, one of nine allowed PI protocols: `openai-completions`,
  `mistral-conversations`, `openai-responses`,
  `azure-openai-responses`, `openai-codex-responses`,
  `anthropic-messages`, `bedrock-converse-stream`,
  `google-generative-ai` or `google-vertex`;
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

The field is derived centrally in `registry.ts` from `supportsSteering()` in
`providers/provider-names.ts` — the same pattern as `readsNativeSkills` — rather
than declared per provider, so clients can ask `/api/provider-capabilities`
which will happen *before* sending. `providers/steering.test.ts` fails if that
list and the actual
`steerMessage` implementations drift apart.

These providers can steer, each through a live input channel that stays open
after the turn starts:

| Provider | Channel |
|----------|---------|
| `claude-code` | the Agent SDK's streaming-input iterator |
| `claude-code-pty` | stdin, kept open by `--input-format stream-json` |
| `codex` | app-server `turn/steer`, acknowledged against the active native turn id |
| `muse-code` | the MSP `turn/steer` command on the warm `muse serve` host |
| `antigravity` | a second ACP `session/prompt` during the turn, which Antigravity documents as steering it; an immediate refusal falls back to the queue |
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

Codex launches `codex app-server --listen stdio://` per turn and resumes the same
native thread on follow-ups. The stdin channel stays open until completion and
outstanding steering acknowledgments settle. Interject (or **Alt+Enter**) sends
to the active turn; ordinary Enter still queues. No stop/restart is performed
to deliver an interjection. During startup or teardown, an explicit decline
falls back to the normal queue. A timeout or lost connection before acknowledgment
is reported as a delivery error rather than automatically risking a duplicate.

The provider interface accepts `boolean | Promise<boolean>` for `steerMessage`;
the session manager waits for acceptance before persisting/broadcasting the
interjection. Codex child-thread notifications are filtered out of the parent's
turn lifecycle. Its native rollout, MCP configuration, profile instructions,
images, model, effort, sandbox, and speed settings carry across the transport.
API-key sessions authenticate with process-local ephemeral credential storage;
subscription sessions reuse the CLI's saved login. Interactive approval UI is
still unsupported: unexpected approval requests are declined.

## Profile prompts and project instructions

Profile prompts are provider configuration, not message content. Modus resolves
template variables and sends the prompt through a provider-native system-level
channel. The user payload passed to the provider remains exactly the content
submitted to the session. Repeating instructions on every turn belongs to a
persistent move, which is visible in the session configuration.

Two capability objects describe the real boundary:

- `profilePrompt.supportedModes` lists `append` and/or `custom`.
  `profilePrompt.delivery` maps each supported mode to its system, developer,
  or rule channel.
- `projectInstructions.control` is `toggle`, `always`, or `none`, with the
  provider-native sources named in `sources`.

| Provider | Append channel | Custom channel | Project instruction control |
|----------|----------------|----------------|-----------------------------|
| Claude Code / PTY | Claude system-prompt append | Claude system-prompt replacement | project-only settings toggle |
| Codex | `developer_instructions` | `instructions` | `AGENTS.md` toggle (`project_doc_max_bytes = 0` disables) |
| Cursor | private always-applied plugin rule | unavailable | Cursor rules always on |
| Grok Build | `--rules` | `--system-prompt-override` | `AGENTS.md` always on |
| OpenCode | config `instructions` | custom primary-agent `prompt` | project config/instructions toggle |
| Declarative PI providers | `appendSystemPrompt` | `systemPrompt` | context-files toggle |

The backend rejects a non-empty prompt when the selected mode is unsupported.
It never approximates a system prompt by prepending headers or tags to the user
message.

## Model selection

Provider model endpoints return suggestions, not an allowlist. Model values in
agent profiles, user-profile defaults, session setup, and live session config
are open strings and are passed to the selected provider. Every model picker
accepts a custom value so a newly released model or private deployment can be
used before Modus adds it to the suggestions. Claude Code suggestions include
current full model IDs and its durable aliases (`default`, `best`, `opus`,
`sonnet`, `haiku`, extended-context aliases, and `opusplan`).

Cursor suggestions come from the installed `cursor-agent models` command using
the same `CURSOR_API_KEY` secret/environment resolution as Cursor turns, or the
CLI's saved login. Modus parses the account's live model list rather than
substituting a static list. Failed discovery returns an API error, which model
pickers display with sign-in or connection guidance. For a sign-in error, run
`cursor-agent login`, then reload the picker. Updating the CLI is unnecessary
when its `models` command already works. Model discovery runs asynchronously
with a 15-second deadline so it does not block other backend requests.

PI agent providers share a single implementation (`pi-agent.ts`) parameterized
by provider name. They implement a lightweight tool-use agent loop with
compaction support.

### Additional workspace roots

Every current provider consumes `additionalDirectories`. PI's upstream
`createCodingTools(cwd)` has one primary root, but its file tools accept
absolute paths and bash is already unrestricted. Modus adds declared roots to
PI's resource system prompt and every coding-tool description so the agent can
address them by absolute path. PI loads its context files, when enabled, and
skills from the primary `cwd`; Modus explicitly adds `<cwd>/.claude/skills`
when present for
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

### Antigravity support boundary

Modus starts one `agy acp` child per active session: the Agent Client Protocol
server that ships inside Google's Antigravity CLI. It initializes ACP, creates or
loads the provider-native Antigravity session, and keeps that process warm for
follow-up turns. Text, thought, tool, permission, usage, cancellation, image,
model, mode, and MCP data use native ACP messages.

Install the Antigravity CLI, then run `agy` once in a terminal and sign in with
Google. That sign-in, and the plan behind it, is what Modus sessions run on:
Modus never calls ACP `authenticate`, never drives an OAuth flow, and never
reads the CLI's credential files. Google decides which models a plan offers;
Modus lists whatever the signed-in account reports. Newly created Google
accounts may first have to complete Google's verification inside `agy`; until
then every turn fails with a message saying so.

Antigravity is a Google service governed by Google's
[Antigravity terms](https://antigravity.google/terms), which restrict use of the
service with products Google does not provide. Modus launches only Google's own
binary through the client protocol Google publishes for other editors; whether
that satisfies the terms for a given account is Google's call, not Modus's.

- **Models.** The picker lists base models (for example `gemini-4-hydrogen`);
  the profile `effort` picks the thinking level, mapped onto ACP's per-level
  model ids (`off` → `low`, `max` → `xhigh`, falling back to `high` for models
  without an extra tier, and to `medium` when no effort is set). A full id such
  as `gemini-4-hydrogen-high` is also accepted. A model the account does not
  offer fails the turn and lists what it does offer. Lists come from a
  throwaway ACP session, shared with the health check for a minute.
- **Modes and approvals.** `providerControls.antigravity.mode` selects the ACP
  session mode: `default`, `accept-edits`, `auto`, or `plan`. Antigravity decides
  which calls reach Modus for approval: in `default` it asks before commands and
  file edits, in `accept-edits` before commands only, and in `auto` only before
  commands it judges risky. Reads, web search, and MCP calls never ask. Modus
  answers each request from the session's tools and `permissionPolicy`, or with a
  live prompt. A restricted tool that Antigravity runs without asking cannot be
  blocked, so Modus reports it in the transcript instead.
- **Sandbox.** `sandbox: true` launches `agy acp --sandbox`; `auto` mode turns
  Antigravity's terminal sandbox on by itself. A command that asks to bypass the
  sandbox (`BypassSandbox`) always waits for the user, whatever the permission
  policy. Where the sandbox cannot start (Google lists its Windows requirements in
  the [sandbox docs](https://antigravity.google/docs/sandbox/)), every sandboxed
  command fails; Modus names that once per session in the transcript.
- **Profile prompts.** `append` is delivered as ACP session metadata
  (`_meta.antigravity.systemPrompt.append`). `custom` is rejected: ACP offers no
  replacement channel. Antigravity always loads its own rules and project
  instructions.
- **Billing.** Inherited `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
  `GOOGLE_GENAI_API_KEY`, and `GOOGLE_APPLICATION_CREDENTIALS` are removed from the
  child so a stray key cannot move a session from the plan to API billing. A key
  set deliberately in the profile `env` is passed through. Turns report token
  usage; their dollar cost is recorded as zero.
- **Tools.** A profile's `tools`, `disallowedTools`, and session tool toggles may
  use the shared Modus names (`Read`, `Bash`, ...) or Antigravity's own
  (`read_file`, `run_command`, ...); see Tool names across providers below.
  MCP tools appear as `mcp_<server>_<tool>`; Antigravity does not return MCP or
  `read_file` output to the client, so those rows show only completion. Prompt
  attachments accept text and images; Antigravity's ACP server reports no audio
  input. HTTP and SSE MCP servers launch `agy acp --process-per-session`, which
  Antigravity requires for them.
- **Steering.** A message sent while a turn runs goes into that turn as a second
  ACP `session/prompt`, which Antigravity's ACP server documents as steering the
  running turn. If Antigravity refuses it at once, Modus queues it instead.
- **Background commands.** `run_command` moves a command to the background after
  its `WaitMsBeforeAsync`, and Antigravity can end its reply while the command
  runs. When the command finishes, Antigravity completes that tool call and keeps
  working on its own, with no ACP prompt around the work and no event that marks
  its end. A turn whose reply leaves a command running therefore stays open: it
  closes once no command is left running and Antigravity has been quiet for a
  minute. Stopping the turn ends the wait, and so does a message sent during
  it, which Antigravity takes into whatever it is doing. Work Antigravity starts after a turn has already closed is shown as a
  turn of its own. That work reports no token usage.
- **Turn limit.** ACP has no turn limit, so Modus counts model rounds (each batch
  of tool calls is one) and cancels the turn at `maxTurns`, ending it with
  `error_max_turns`.
- **Slash commands.** The composer offers Antigravity's own commands (`/goal`,
  `/compact`, `/plan`, `/schedule`, ...); a prompt starting with one is handled by
  Antigravity. Installed agy skills are invoked the same way.
- **Legacy plugin.** Earlier Modus builds installed an agy plugin named
  `modus-provider` whose hooks fail every agy tool call. On first use per backend
  process Modus disables it if it is enabled (`agy plugin enable modus-provider`
  reverses that); it touches no other plugin.

`ANTIGRAVITY_CLI_PATH` points at a specific `agy` executable. Otherwise `agy`
is found on `PATH`, then in the CLI's default per-user install location.

### Tool names across providers

Profiles name tools in one shared vocabulary, the Claude Code names (`Read`,
`Write`, `Edit`, `Bash`, `WebSearch`, ...), because that is what the profile
editor and starter content write. Providers with their own tool names publish a
`toolAliases` map in their capabilities, and Modus reads `tools`,
`disallowedTools`, session tool toggles, and permission-policy name lists through
it, so one profile restricts the same capabilities on every provider. Native
names are accepted as well. The tool grid reads the same map, so it shows what
the backend enforces.

| Shared name | Antigravity | Grok Build | Muse Code |
|---|---|---|---|
| `Bash`, `PowerShell` | `run_command`, `manage_task` | `run_terminal_cmd`, `run_terminal_command` | `shell` |
| `Read` | `read_file` | `read_file` | `read_file` |
| `Write` | `write_file` | `write_file` | `write_file` |
| `Edit`, `MultiEdit`, `NotebookEdit` | `edit_file` | `search_replace` | `write_file` |
| `Glob` / `Grep` | none | `list_dir` / `grep`, `grep_search` | none |
| `WebSearch` / `WebFetch` | `search_web` | web and X search / fetch tools | none |
| `Agent` | subagent and swarm tools | `task`, `spawn_subagent` | none |
| `AskUserQuestion` | `ask_question` | `ask_user_question` | none |

The full maps live in each provider's capabilities file. As on Claude Code,
`tools` limits built-in tools only; MCP tools stay available unless
`disallowedTools` names them (`mcp__server__tool`, or `mcp__server` for a whole
server). A toggle switched on re-enables a tool the list leaves out; a toggle on a
tool's own name takes precedence over one on a shared name. When Modus refuses a
tool, the transcript says which setting blocked it and which names would allow
it.

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

### Muse Code support boundary

Modus starts one `muse serve` host per active session and drives it over the
Muse Session Protocol (MSP): newline-delimited JSON-RPC 2.0 on stdio. It
initializes, starts or resumes the provider-native Muse session, and keeps the
host warm for follow-up turns. Text, reasoning summaries, tool calls,
approvals, usage, cancellation, steering, images, model selection, and MCP
servers use native MSP methods rather than terminal-output scraping.

Install the Muse Code CLI and sign in with your Meta Model API account. The
CLI's own sign-in is what a Muse Code subscription applies to, and Modus
launches that same CLI, so subscription turns stay on the subscription. If a
`MODEL_API_KEY` Modus secret is set it is forwarded instead, and Muse bills that
key pay-as-you-go. `MODUS_MUSE_CLI` overrides the executable path.

- **Models**: listed with MSP `model/list`, which needs no session. There is no
  offline fallback list; model pickers accept any ID. A model change is sent as
  `session/setModel` before the next turn, without restarting the host.
- **Approvals**: MSP has no tool filter, so Modus enforces `tools`,
  `disallowedTools`, `toolStates`, and `permissionPolicy` by answering the
  host's `approval/request`. The session uses approval mode `allowAll` only when
  the policy is `bypass` and no tool is restricted; otherwise `promptUnmatched`,
  so a tool the host already allows by its own rules never reaches Modus.
- **MCP**: servers are sent in the session's `config.mcpServers` when the host
  grants the `sessionMcp` capability. Stdio and streamable HTTP are supported;
  SSE servers are skipped with a warning. Servers are marked `optional`, so one
  failing server does not refuse the session.
- **Profile prompts**: MSP has no system-prompt channel, so a profile with a
  prompt fails the turn up front instead of smuggling the prompt into the user
  message.
- **Questions**: the client declines `userInput/request` dialogs at the
  handshake, since Modus has no surface for them.

## Effort Resolution

`effort` follows the standard cascade: session override → agent profile → user profile default.
`session-manager.ts` resolves this before creating `TurnContext`, so providers always receive
the fully-resolved value.

Provider-specific normalization:
- **claude-code / claude-code-pty**: `"off"` disables thinking. Other effort values are passed to Claude Code.
  A mid-session effort or model change on `claude-code` reaches the warm subprocess through the
  SDK's live controls (`applyFlagSettings({ effortLevel })`, `setModel`) and applies from the next
  turn; `claude-code-pty` restarts its process on the next turn instead.
- **codex**: `"off"` disables reasoning. `"low"/"medium"/"high"/"xhigh"` map to Codex reasoning effort; `"max"` maps to `"xhigh"`.
- Other providers accept the resolved effort only if their implementation uses it.
- **antigravity**: effort selects the ACP thinking-level model variant (see the Antigravity section).
- **grok-build**: effort is applied at ACP process startup and included in prompt metadata for compatible Grok versions.
- **muse-code**: effort is sent per turn as MSP `reasoningEffort`; `"off"` maps to `"none"`.

## Permissions

`permissionPolicy` is the portable gate shown in both profile and session
configuration. Its ladder is inherit, `"bypass"`, `"auto-edit"`, and `"ask"`;
the object form remains supported for per-tool exceptions. Provider-specific
degradation is shown in the authoring UI.

`providerControls.claude.permissionMode` remains a JSON-only compatibility
control. Valid values are `"default"`, `"acceptEdits"`,
`"bypassPermissions"`, `"plan"`, `"dontAsk"`, and `"auto"`. The portable
policy wins for its string modes; an object policy can still use the native
control.

When the agent calls the `ExitPlanMode` tool, the provider automatically resets `permissionMode` to `"default"` and notifies session-manager via `notifyConfigChange`, so the config_updated event reflects the cleared state.

## External sessions

Claude Code and Codex keep every conversation on disk under an ID their CLI
resumes by, and Modus resumes its own sessions by that ID
(`provider_session_id`). So Modus can also take over a conversation started
in the CLI, another app, or an IDE (`external-sessions.ts`,
`external-session-import.ts`).

| Provider | Listed from | Excluded |
|----------|-------------|----------|
| `claude-code` | `~/.claude/projects/<folder>/<id>.jsonl` | files with no typed prompt |
| `codex` | `threads` in `$CODEX_HOME/state_5.sqlite` (default `~/.codex`) | archived threads, sub-agent threads, and threads whose originator is Modus |

These are the same roots the resume paths check, so anything listed can be
resumed. Both stores are internal provider formats. Unknown records are
skipped, so a format change can only degrade the imported preview. It cannot
break the resume, which the provider runs from its own file.

Importing creates a Modus session with `provider_session_id` set to the
conversation ID, `cwd` set to the conversation's recorded project folder, and a
`config_updated` event naming the provider. A revived session reads its provider
from that event, not from a profile. Without it, the first turn would fall back
to the profile's provider. The visible history is a digest: each typed prompt
and the last text the agent wrote after its final tool call. For Claude Code it
follows the active branch (the `parentUuid` chain from the latest message, across
compaction boundaries), so turns abandoned by a rewind are not shown. The digest
is written as ordinary `user/prompt`, `assistant`, and `result` events, so it
keeps reconstructing after new turns add events of their own. Tool calls and
injected context stay in the native file, where the provider reloads them.

The next turn resumes natively in the recorded folder, and Claude Code only finds
a conversation from that folder. The native file stays the source of truth, so
the CLI or any other front end resuming the same ID sees the continued thread. Two
front ends appending at once is not coordinated. The listing marks a conversation
written in the last two minutes, and the `resume` widget asks the user to close
it elsewhere first.

| Route | Purpose |
|-------|---------|
| `GET /api/external-sessions/providers` | Which providers have a store on this machine |
| `GET /api/external-sessions?provider=&cwd=&q=&limit=&hideKnown=1` | Newest first. `cwd` keeps a folder and its subfolders. `modusSessionId` marks conversations Modus already holds |
| `POST /api/external-sessions/import` `{ provider, id, userProfile? }` | Creates the session, or returns the existing one with `existing: true`. 404 when the conversation is gone, 409 when its folder is gone |

The routes read other tools' transcripts, so like the file APIs they require
`HARNESS_TOKEN` or `HARNESS_PIN` to be configured.

## Provider Health

`checkAllProviderHealth()` reports readiness from registry-declared prerequisites:

| Provider | Checks |
|----------|--------|
| `claude-code`, `claude-code-pty` | `claude` CLI |
| `codex` | `codex` CLI plus `CODEX_API_KEY` / `OPENAI_API_KEY` or `~/.codex/auth.json` |
| `cursor` | `cursor-agent` CLI (or configured resolver path) |
| `antigravity` | `agy` CLI plus a throwaway ACP session that reports Google sign-in and plan tier |
| `grok-build` | `grok` CLI plus a headless ACP authentication probe (`grok login` or `XAI_API_KEY`) |
| `muse-code` | `muse` CLI (or `MODUS_MUSE_CLI`). MSP has no sign-in status method, so a missing login surfaces on the first turn |
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

On Windows, Claude Code is launched through a native `claude.exe`, never npm's
`claude.cmd` batch shim. `claude` resolves the way a terminal would; when that
is the npm shim, Modus launches the `claude.exe` the shim wraps
(`node_modules\@anthropic-ai\claude-code\bin\claude.exe` beside it). A
native-installer `claude.exe` is used as found. A shim with no binary behind it
is still launched as a last resort.

A provider that cannot find its CLI fails the turn before it starts and reports
the reason as a persisted system message, so the explanation survives a reload
rather than living only on whichever stream happened to be open. Setting the
provider's explicit path override (`MODUS_GROK_CLI`, `ANTIGRAVITY_CLI_PATH`,
`CLAUDE_PATH`) skips the search entirely.

**Source**: `providers/resolve-cli.ts`.

## MCP Server Composition

MCP server settings follow this merge order for providers with Modus MCP
integration. Later entries override same-named servers from earlier entries:

1. Project `.claude/mcp.json` (compatibility path)
2. Project `.mcp.json`
3. Project `.modus/mcp.json`
4. Built-in `modus` server
5. Each global layer, in base â†’ plugin â†’ project order: its optional
   `mcpConfig` file, then its inline `mcpServers`
6. The profile's optional `mcpConfig` file, then inline `mcpServers`
7. Session `mcpServers`

Relative `mcpConfig` paths resolve from the file that declares them. Relative
`--directory` arguments in stdio server configs resolve from the MCP file or
profile/global file that owns the entry.

Environment variables injected into MCP servers:
- `AGENT_PROFILE` — active agent profile name
- `USER_PROFILE` — active user profile name

Provider-specific wiring differs: Claude uses SDK/CLI MCP config, Cursor writes a temporary `.cursor/mcp.json`, Codex passes MCP config through its CLI wrapper, Grok Build receives the merged servers in ACP `session/new`/`session/load`, and PI providers use `mcp-bridge.ts`. OpenCode can use its own native MCP configuration, but this Modus adapter does not inject Modus MCP servers into it.

The built-in `modus` entry carries a random in-memory credential minted before
the provider spawns. It authorizes only that entry's exact
`/api/mcp/modus[/<skill-scope>]` route, is bound to the provider's final Modus
session ID after initialization/rekey, and is revoked when the session is
disposed, reaped, or the backend shuts down. Resume starts a new provider
generation and therefore mints a fresh credential; credentials are never
persisted. Presenting one to an operator route is rejected even when the
harness otherwise runs without a PIN.

`MODUS_PROVIDER_MCP_LEGACY_BEARER=1` is a compatibility escape hatch: when a
`HARNESS_TOKEN` is configured, it restores the old behavior of putting that
full operator bearer in provider MCP config. It is off by default and should be
used only while migrating a caller that incorrectly depends on provider-wide
operator authority.

### Child credential boundary

Every provider CLI is spawned from a filtered environment built by
`providers/child-env.ts`. OS, `PATH`, locale, proxy, and provider runtime
variables are preserved; Modus credentials (`HARNESS_TOKEN`, `HARNESS_PIN`,
`HARNESS_SECRETS_FILE`, `HARNESS_TLS_KEY`, `MODUS_PIN`, `MODUS_TOKEN`,
`MODUS_SESSION_MCP_TOKEN`) are not
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

- **Claude Code SDK and PTY** write MCP config under a random
  `modus-sensitive-` directory and pass only its path in `--mcp-config`; the
  directory is removed on failed launch and provider disposal. The SDK path
  does not serialize MCP headers into argv.
- **Cursor** has no flag for an alternative MCP config path, so it still writes
  `<project>/.cursor/mcp.json` while a turn runs. That write goes through a
  durable journal in the runtime directory (`providers/cursor-mcp-config.ts`),
  so a crashed backend's file is restored on the next start instead of being
  stranded in a frequently git-tracked directory. A file the user edited while
  the session ran is never clobbered.

### Provider diagnostics

Provider lifecycle and timing chatter is off by default. Set
`MODUS_PROVIDER_DIAGNOSTICS=1` before starting the harness to emit it while
investigating provider startup, resume, MCP registration, or process teardown.
Actionable provider warnings and errors remain enabled without this flag.

**Source**: `providers/claude-code.ts` (MCP merge), `providers/cursor.ts`
(MCP via .cursor/mcp.json), `providers/codex.ts` (MCP via config object),
`providers/opencode.ts`,
`providers/grok-build.ts`, `providers/grok-build-acp.ts`,
`providers/muse-code.ts`, `providers/muse-code-runtime.ts`,
`providers/mcp-bridge.ts` (MCP lifecycle for PI agents),
`providers/registry.ts` (provider lookup).
