---
title: Capability Surface (condensed)
lastUpdated: 2026-08-17
covers: harness/move-types.ts harness/action-types.ts harness/profile-schemas.ts harness/harness-context.ts harness/session-manager.ts harness/modus-mcp.ts harness/wake-scheduler.ts harness/skills.ts harness/skill-attachment.ts harness/app-paths.ts harness/vault-types.ts harness/vault-policy.ts harness/vault-registry.ts harness/vault-api.ts
audience: agent
---

# Capability Surface (condensed)

One-stop, agent-grade reference for everything Modus core can actually do.
Compiled from the type contracts (`move-types.ts`, `action-types.ts`,
`profile-schemas.ts`) and the Harness Context. Field names here are exact.
For narrative docs see `primitives.md`, `moves.md`, `actions.md`, `pages.md`,
`harness-context.md`.

## The system in one paragraph

Five primitives compose: **sessions** (one agent conversation, event-logged,
branchable), **agent profiles** (HOW an agent behaves), **user profiles** (WHO —
a workspace scope, not an identity), **actions** (WHEN automation runs), and
**moves** (WHAT the user wants right now). **Pages** give any primitive a UI
surface. Server-side extension code (move/action `context.ts`) reaches the
engines through one capability contract, the **Harness Context**, gated by
trust tiers. The agent-facing bridge is a single MCP tool, **`modus_submit`**,
which routes by token prefix: move tokens (10-min TTL, one submit), `mapi-`
(move API, reusable ops), `mis-` (missions), `api-` (session API ops).

## Moves — `.modus/moves/<name>/` (project) or built-in

Files: `move.json` (MoveConfig) + optional `context.ts` + optional `widget.tsx`.
Project moves override built-ins with the same name.

**Execution modes** (`mode`, default `inline`):
- `inline` — current session handles it; gathered context merges into the user message.
- `branch` — spawns a sibling session (uses `agentProfile`).
- `background` — fire-and-forget spawned session with persisted status.
- `persistent: true` (separate flag, not a mode) — **ambient gather**: `gather()`
  re-runs on every user turn and injects context; no token/submit lifecycle;
  active until deactivated. This is the standing-awareness mechanism.

**move.json fields**: `name`, `label`, `description`, `icon`, `inputs[]` (form
fields: text/textarea/select/toggle/number, `optionsSource` for dynamic
agentProfiles/projects/sessions pickers, `visibleWhen` rules), `schema` (full
JSON Schema validated on submit), `schemaHint` (compact shape shown to the
model), `submit { required, retryOnInvalid, maxAttempts }`, `session
{ profileOverride, settingsOverride, afterSubmit: continue|end|switch:<profile> }`,
`prompt` (fallback if no gather), `agentProfile` (branch/background),
`gatherTimeoutMs` (default 10s), `prepareTimeoutMs` (default 120s),
`capabilities`, `trust`, `hidden` (tag spawned sessions "internal"), `api`,
`widget`, `toolView`, `page`, `enabled`, `tags`.

**context.ts hooks** (`MoveModule`):
- `prepare(ctx)` — heavy setup before gather (launch a program, wait for an MCP).
- `gather(ctx)` — build the injected prompt; return `null` to bail this turn
  (critical for persistent moves).
- `onSubmit(ctx, data, inputs)` — handle the validated `modus_submit` payload.
- `onAssistantTurn(ctx)` — fires on **every assistant round end** for active
  instances; gets `assistant` turn content + `state` + `emit`.
- `handlers` — named API op handlers (see Move API).
- `inferOp(data)` — fallback op inference when the model omits `op`.

**Move API contract** (`api` in move.json): `ops: { <name>: { description,
schema? } }`, optional `defaultOp`, `state.persist` (disk-persisted instance
state). On activation the runner registers handlers, mints a reusable
`mapi-<prefix>-<instanceId>` token, and passes it to `gather()` as
`ctx.apiToken`. The agent calls ops repeatedly via
`modus_submit(token, { op, ...data })`.

**Handler powers** (`MoveApiContext`) — Harness Context orchestration, including
`shell.run(cmd)` (gated by `capabilities.shell`) and `model` one-shots:
`createSession`, `sendMessage(sessionId, msg)`, `triggerAction(name)`,
`activateMove({moveName, inputs, sessionId, modeOverride})`,
`watchSessionTurns(sessionId, cb)`, `wake(target, content, when?)`,
`channels.send(channel, {text, data})`, `insertArtifact(...)`,
`notify(message, emit?)` — agent callers inject into the session (with a typed
`[modus:...]` prefix when `emit` is supplied); user/widget callers inject
nothing and only broadcast a supplied `emit` payload as `move-widget-event`.
Plus `state` (get/set/delete), `store`/`setStore` (process-scoped), `db`
(read-only sessions/messages/search), `secrets` (resolve/isSet),
`pluginSettings`, `emit`, and `caller` (`"agent" | "user"`).
`vault.slug` identifies the process-level Vault (`null` for the implicit
default); it is distinct from the move's `instanceId`.

Handlers are **not** a superset of `gather()`/`onSubmit()`. `MoveContext` exposes
the convenience `run(cmd)` and the full `harness` object; handlers instead expose
the gated path as `shell.run(cmd)` plus their own orchestration members. For the
exact per-surface member list see
[`generated/authoring-contracts`](./generated/authoring-contracts.md), which is
generated from the declarations and cannot drift from them.

**Widget** (`widget` in move.json): `component` (e.g. "widget.tsx"), `label`,
`icon`, `autoOpen`, `mountOnAttach` (mount before any message; requires `api`),
`cache: instance|module|none`. Renders as a right-panel tab or embeds in pages.

**Transcript tool view** (`toolView` in move.json, API moves): `component`,
optional `ops[]`, `takeover: block|body` (default `block`), and
`cache: instance|module|none`. It claims this move's own `modus_submit` rows and
receives durable input/result/artifacts plus live status, `isLatest`, the real
session id, `callOp`, and `submitMessage`. Missing/deleted/broken views fall back
to the native tool row.

**Page** (`page` in move.json): `id`, `title`, `nav` (default true), `layout`
(full page tree — same schema as `.modus/pages/*.json`), `layouts.mobile`,
`context` (page-scoped pub/sub seed), `padding`. Without `layout`, the move's
widget renders as a bare full page (`#move-page:<name>`); with `layout` it
becomes a normal nav page that can embed the widget via a
`{ "type": "move:<name>" }` leaf.

## Actions — `.modus/actions/<name>/`

Files: `action.json` (ActionConfig) + `context.ts` (ActionModule).

**Triggers**: `interval` (`every`, `from: completion|start`, `activeHours`
wrapping midnight), `webhook` (`token`, `sessionKey` routes payloads as
follow-ups into an existing tagged session), `manual`, `action` (chain:
`source`, `condition: any|done|error`, max depth 8), `session` (fire on session
events: `{role, round: N|every:N|after:N, at: start|end}` or
`archived`/`deleted`; `excludeTags` defaults to `["internal"]` to prevent
cascades).

**Layers**: run (one spawned session) → cycle (`cycleInterval` resets run
counter, `maxCycles` caps) → execution (lifecycle instance, `concurrency`,
`onExhausted: archive|idle|restart`). Resilience: `maxRetries` (verify),
`maxTransientRetries`, `retryBackoff`, `onGatherError`, `onTransientFailure`.

**Pipeline**: trigger → `gather(ctx)` (returns prompt string, content blocks
with images, or `null` to skip) → spawn session with `agentProfile` →
monitor → `verify(ctx, result)` (accept/reject/retry) → `afterRun(ctx,
result)` (side effects, success only) → `notify` specs (per-status, named
channels, templated messages).

**Also**: `steps[]` (multi-profile sequences with `contextMode:
full|summary|lastResponse`), `moves: [{name, inputs}]` (**activate moves on the
spawned session** — this is how automated sessions get ambient context or
widgets), `page` (action-owned nav page), `artifacts[]` (declared outputs,
auto-verified), `inputs` (static, reaches ctx), session overrides (provider,
model, effort, cwd, tools), `capabilities` + `trust` (same gating as moves).
`ActionContext` includes `vault`, `sessions`/`channels`/`model` (Harness Context), `db`,
`createTerminal()` (managed PTY visible in the UI), artifact helpers, `log`.

## Agent profiles — `~/.modus/profiles/agents/*.json` (project override in `.modus/profiles/agents/`)

Fields: `prompt` (supports `{{templateVars}}`), `description`, `provider`,
`model`, `effort`, `maxTurns`, `cwd`, `additionalDirectories`, `tools`,
`disallowedTools`, `promptMode: append|custom`, `loadProjectSettings`,
`claudeMdExcludes`, `mcpServers` (stdio/sse/http), `permissionPolicy`
(`bypass` | `ask` | `{default, autoApprove[], requireApproval[]}`),
`providerControls` (per-provider tuning), `env`, `plugins`, `sandbox`,
`contextWindow`, `maxOutputTokens`, `compaction`, `maxBudgetUsd`,
`cwdSuggestions`, `ui` (label, placeholder, showThinking, **`panelWidgets`** —
preconfigure right-panel widgets for sessions), and **`moves: [{name, inputs?,
ask?}]`** — auto-activated at session start (`startSessionWithMoves`):
inline moves gather pre-spawn and prepend the prompt; persistent moves activate
post-spawn. **A profile + a persistent move = a standing Modus-aware agent.**

A profile's **inline** bindings are shown in the composer as pending attachments
before the first message (`<profile> attaches`), each removable — removal sends
`skipProfileMoves: ["name"]` on `POST /api/sessions`, which only ever subtracts.
They vanish once the session has a turn, since inline profile moves fire exactly
once. `POST /api/sessions` also takes `moves` now, so a composer-attached move
survives being the message that creates the session.

`ask: true` defers a binding instead: the harness skips it at session start and
the move's input form docks above the composer when the chat opens, seeded from
`inputs` (so a binding can prefill some fields and ask for the rest). The move
activates when the user submits the form; dismissing it skips the move for that
session. The move's bundled skills still resolve at spawn either way, since a
provider cannot be handed a new skill scope after it starts. `ask` on a move
that declares no `inputs` is ignored — there is nothing to ask for.

Also `skills: ["name"]` — see below.

## Skills — `.modus/skills/<name>/SKILL.md`

Packaged text, standard `SKILL.md` + front-matter (`name`, `description`), so
files stay portable out of Modus. Resolved project → user (`~/.modus/skills/`)
→ plugin, most specific wins. Moves may also bundle skills at `<move>/skills/`.

**Attachment is required.** `skills: [...]` on an agent profile, `move.json`, or
`action.json`; a move's bundled skills come along whenever the move is attached.
Unresolvable names are logged and skipped, never fatal.

Delivery is per provider and automatic. PI is handed the attached `SKILL.md`
paths directly (`additionalSkillPaths` accepts individual files) and loads them
natively. Everyone else gets two tools on a session-scoped MCP endpoint
(`/api/mcp/modus/<scope>`):

- `skills_list` → `[{name, description}]`
- `skills_load {name}` → full `SKILL.md` + its directory, for reading
  `references/*` with ordinary file tools

The endpoint carries the same exact-route, per-provider-session MCP credential
as the plain surface; it does not accept the supervisor bearer by default.
**Neither tool is registered when nothing is attached** — sessions without
skills keep the plain single-tool surface. Because
the URL is fixed at spawn, skills attached mid-session may not reach the agent
by tool until restart.

Modus never scans, copies into, or overrides `.claude/skills/` or `.pi/skills/`.
Full contract: `skills`.

## User profiles — `~/.modus/profiles/users/*.json`

A workspace scope ("my folders"), not an identity: `displayName`, `projects[]`,
`agentProfiles[]` (visible agents), `defaultAgentProfile`, `provider`/`model`/
`effort` defaults, `templateVars`, `memory {scope, inheritGlobal}`,
`memoryFilter`, `dashboard` (widgets + pages), `leftPanel`, `pageNav`
(mode/enabled/disabled/pinned/order/labels), `layouts` (per-breakpoint panel
layouts), `interface` (chat/conversation display), `clientExtensions`,
`computer`, `editor`. A user profile can reshape the entire UI shell.

## Vaults — process-level data and capability boundaries

An unset `MODUS_INSTANCE` (or `default`) uses the implicit default Vault;
`MODUS_INSTANCE=<slug>` scopes writable data, logs, runtime, cache, workspace
history, checkpoints, and the policy file under `~/.modus/<slug>/`. Profiles,
skills, and machine plugin/project/Vault registries remain shared.
Slugs use letters, numbers, dots, underscores, and hyphens and canonicalize to
lowercase; display casing belongs in the registry `name`.

Named Vaults fail closed when `vault.json` is absent or invalid. Its `plugins`,
`projectAutomation`, and `channels` rules each use `allow-all` or deny plus an
allow list. New API-created Vaults get explicit deny-all. The default Vault
preserves existing behavior when its policy is absent. Full contract: `vaults`.
Project and plugin action dispatch rechecks the policy, so revocation applies
without an action reload.

## Pages — `.modus/pages/*.json`, `harness/pages/*.json`, or declared by moves/actions/missions

`{ id, title, nav?, fullscreen?, padding?, context?, layout, layouts?.mobile }`.
Layout tree: `grid` (columns, templateColumns/Rows) / `panel` (list|tabs) /
`widget` leaves. Widget types come from the built-in registry
(`session-list`, `pages-browser`, `notes`, `code-editor`, `docs`, …) plus
`move:<name>` embeds. Users fork built-in pages into projects
(`POST /api/pages/fork`).

## Harness Context (server-side extension code)

`ctx.vault.slug` (process identity; `null` for implicit default),
`ctx.sessions` (create, send, wake, watchTurns, tag/untag, get, list),
`ctx.channels.send`, `ctx.moves` (activate, list), `ctx.actions.trigger`,
`ctx.model` (complete, promote, recent), `ctx.state`, `ctx.db`, `ctx.secrets`,
`ctx.shell.run`, `ctx.artifacts`, `ctx.terminal.create`, `ctx.log`.

**One-shot model calls**: `ctx.model.complete({ prompt, profile?, provider?,
model?, system?, temperature?, maxTokens?, allowSubprocess? })` → `{ text,
oneShotId, provider, model, usage?, transport, elapsedMs }`. No session, no
tools — the cheap rung below `sessions.create` for transforms whose answer is a
value. **PI providers serve these in-process** (`openai-compat`, `ollama`,
`openrouter`, and user/plugin definitions; `litellm` remains an alias) in
milliseconds. **`claude-code-pty` can serve one with `allowSubprocess: true`**:
a single headless CLI turn on the CLI's own subscription auth, costing seconds
of subprocess startup — check `transport`/`elapsedMs` on the result;
`temperature`/`maxTokens` are ignored there. Every other provider throws rather
than silently starting a session. Resolution throws instead of guessing: a
profile with no `provider` is an error (there is no global default provider). `ctx.model.promote(oneShotId)` turns a completed one-shot into a real
session whose first message replays the exchange — idempotent, requires the
one-shot to have named a profile, spawns into the origin's project.
`ctx.model.recent(limit?)` reads a bounded in-memory ring (50) that does not
survive restart.

**Wake / mailbox**: `wake(target, content, when?)` — target is a session id
**or a tag** (fans out to every non-archived session carrying it: a "waiting
team"). `when`: omitted = now (idle sessions start a turn, running sessions
queue), `{at: ISO}`, `{every: "30m"}`, `{onEvent: <SessionTriggerEvent>}`.
Scheduled wakes persist in `scheduled_wakes` and survive restart.

**Trust gating** (applies to moves AND actions): `builtin` (never blocked),
`reviewed` (blocked when a capability is explicitly false, audited),
`experimental` (never blocked, all denials audit-logged). Capabilities:
`shell`, `sessionSpawn`, `sessionMessage`, `actionTrigger`, `notify`,
`modelCall`, `fileRead`, `fileWrite`. `modelCall` gates `ctx.model.complete`
only — `promote` is gated by `sessionSpawn`, since spawning is what it does.

## Gotchas — what does NOT exist (do not assume)

- **No arbitrary inline message widgets.** Move widgets render as right-panel
  tabs or pages. An API move may claim only the transcript tool rows produced by
  its own `modus_submit` token through `toolView`; ordinary message bodies stay
  text/markdown plus built-in blocks.
- `widget.panel: "right"` is schema-present but unread — placement is
  hard-coded to the right panel.
- **Installed skills are not available skills.** A profile, move, or action must
  attach one by name; nothing under `.modus/skills/` reaches an agent otherwise.
  Provider CLIs other than the Claude family and PI read no skills of their own,
  so on those the Modus skill tools are the only path. See `skills`.
- Moves are **user-invoked by default**. Programmatic activation exists only
  through opted-in configuration: profile `moves`, action `moves`, or a move
  handler's `activateMove` — each is authored by the user.
- There is no runtime "promote widget to page" button; dual-surface is authored
  by declaring both `widget` and `page` in `move.json`.

## Where things live

- Project-planted config: `<project>/.modus/{moves,actions,pages,profiles,missions}/`
- User-global: `~/.modus/profiles/{agents,users}/`, `~/.modus/profiles/_global.json`
- Vault-scoped runtime: `~/.modus/<slug>/{data,logs,runtime,cache,history,checkpoints}/`
- Built-ins: `harness/{moves,actions,pages,prompts}/` (packaged into the desktop app)
- Docs API: `GET /api/docs` (index), `GET /api/docs/<id>`, `POST /api/docs/search`
  (`{queries: string[]}` — batch). Generated audit doc: `generated/move-ops`.
