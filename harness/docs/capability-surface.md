---
title: Capability Surface (condensed)
lastUpdated: 2026-07-24
covers: harness/move-types.ts harness/action-types.ts harness/profile-schemas.ts harness/harness-context.ts harness/session-manager.ts harness/modus-mcp.ts harness/wake-scheduler.ts
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
`widget`, `page`, `enabled`, `tags`.

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

**Handler powers** (`MoveApiContext`) — full orchestration parity:
`createSession`, `sendMessage(sessionId, msg)`, `triggerAction(name)`,
`activateMove({moveName, inputs, sessionId, modeOverride})`,
`watchSessionTurns(sessionId, cb)`, `wake(target, content, when?)`,
`channels.send(channel, {text, data})`, `insertArtifact(...)`,
`notify(message, emit?)` — pushes into the agent's session; with `emit` the
agent receives a typed signal line `[modus:{type}] {json}` it can branch on.
Plus `state` (get/set/delete), `store`/`setStore` (process-scoped), `db`
(read-only sessions/messages/search), `secrets` (resolve/isSet), `caller`
("agent" | "user").

**Widget** (`widget` in move.json): `component` (e.g. "widget.tsx"), `label`,
`icon`, `autoOpen`, `mountOnAttach` (mount before any message; requires `api`),
`cache: instance|module|none`. Renders as a right-panel tab or embeds in pages.

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
`ActionContext` includes `sessions`/`channels` (Harness Context), `db`,
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
preconfigure right-panel widgets for sessions), and **`moves: [{name,
inputs?}]`** — auto-activated at session start (`startSessionWithMoves`):
inline moves gather pre-spawn and prepend the prompt; persistent moves activate
post-spawn. **A profile + a persistent move = a standing Modus-aware agent.**

## User profiles — `~/.modus/profiles/users/*.json`

A workspace scope ("my folders"), not an identity: `displayName`, `projects[]`,
`agentProfiles[]` (visible agents), `defaultAgentProfile`, `provider`/`model`/
`effort` defaults, `templateVars`, `memory {scope, inheritGlobal}`,
`memoryFilter`, `dashboard` (widgets + pages), `leftPanel`, `pageNav`
(mode/enabled/disabled/pinned/order/labels), `layouts` (per-breakpoint panel
layouts), `interface` (chat/conversation display), `clientExtensions`,
`computer`, `editor`. A user profile can reshape the entire UI shell.

## Pages — `.modus/pages/*.json`, `harness/pages/*.json`, or declared by moves/actions/missions

`{ id, title, nav?, fullscreen?, padding?, context?, layout, layouts?.mobile }`.
Layout tree: `grid` (columns, templateColumns/Rows) / `panel` (list|tabs) /
`widget` leaves. Widget types come from the built-in registry
(`session-list`, `pages-browser`, `notes`, `code-editor`, `docs`, …) plus
`move:<name>` embeds. Users fork built-in pages into projects
(`POST /api/pages/fork`).

## Harness Context (server-side extension code)

`ctx.sessions` (create, send, wake, watchTurns, tag/untag, get, list),
`ctx.channels.send`, `ctx.moves` (activate, list), `ctx.actions.trigger`,
`ctx.state`, `ctx.db`, `ctx.secrets`, `ctx.shell.run`, `ctx.artifacts`,
`ctx.terminal.create`, `ctx.log`.

**Wake / mailbox**: `wake(target, content, when?)` — target is a session id
**or a tag** (fans out to every non-archived session carrying it: a "waiting
team"). `when`: omitted = now (idle sessions start a turn, running sessions
queue), `{at: ISO}`, `{every: "30m"}`, `{onEvent: <SessionTriggerEvent>}`.
Scheduled wakes persist in `scheduled_wakes` and survive restart.

**Trust gating** (applies to moves AND actions): `builtin` (never blocked),
`reviewed` (blocked when a capability is explicitly false, audited),
`experimental` (never blocked, all denials audit-logged). Capabilities:
`shell`, `sessionSpawn`, `sessionMessage`, `actionTrigger`, `notify`,
`fileRead`, `fileWrite`.

## Gotchas — what does NOT exist (do not assume)

- **No inline in-conversation widgets.** Move widgets render as right-panel
  tabs or pages only. The transcript is text/markdown plus built-in blocks
  (file-change cards, tool calls).
- `widget.panel: "right"` is schema-present but unread — placement is
  hard-coded to the right panel.
- Agent profiles have **no working `skills` field** — skill loading is
  filesystem-based (`<cwd>/.claude/skills/`) and only reaches Claude-family
  CLIs and the PI-agent providers. Other provider CLIs read no skills; moves +
  `modus_submit` are the provider-neutral path.
- Moves are **user-invoked by default**. Programmatic activation exists only
  through opted-in configuration: profile `moves`, action `moves`, or a move
  handler's `activateMove` — each is authored by the user.
- There is no runtime "promote widget to page" button; dual-surface is authored
  by declaring both `widget` and `page` in `move.json`.

## Where things live

- Project-planted config: `<project>/.modus/{moves,actions,pages,profiles,missions}/`
- User-global: `~/.modus/profiles/{agents,users}/`, `~/.modus/profiles/_global.json`
- Built-ins: `harness/{moves,actions,pages,prompts}/` (packaged into the desktop app)
- Docs API: `GET /api/docs` (index), `GET /api/docs/<id>`, `POST /api/docs/search`
  (`{queries: string[]}` — batch). Generated audit doc: `generated/move-ops`.
