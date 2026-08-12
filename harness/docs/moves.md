---
title: Moves
lastUpdated: 2026-07-31
covers: harness/move-runner.ts harness/move-types.ts harness/harness-context.ts harness/move-op-request.ts harness/move-api-result.ts harness/bridged-modules.ts harness/harness-bridge.ts harness/skills.ts harness/skill-attachment.ts
---

# Moves

Moves are the user-facing invocation primitive. They define WHAT the user wants
done right now, with structured submission and validation.

## Directory Structure

Built-in harness moves live in `harness/moves/<name>/`. Project-local moves live
in `.modus/moves/<name>/`. Resolution order (first match wins): project
`.modus/moves/` → enabled plugin `.modus/moves/` → built-in `harness/moves/`.
Resolved move records carry `origin: "harness" | "project" | "plugin"` plus
plugin identity for plugin-origin moves.

Each move directory contains:
```
move.json    — MoveConfig (required)
context.ts   — MoveModule: gather?(), onSubmit?(), handlers?, listInstances?() (optional)
widget.tsx   — React component (optional, for api moves with a widget)
tool-view.tsx — React component (optional, claims this API move's transcript rows)
package.json — move-local dependencies (optional, see below)
skills/      — move-bundled skills, each `<name>/SKILL.md` (optional)
```

No Handlebars templates. `gather()` returns the full prompt string directly.
The move.json `prompt` field is a fallback used only when context.ts has no `gather()`.

Plugin move contexts expose manifest settings through
`ctx.pluginSettings.get(key)` and `ctx.pluginSettings.all()`. The same accessor
is present in move API handlers and branch/background session construction.

### Per-Move Dependencies

A move directory may ship its own `package.json`. On activation, the move runner
installs it before importing `context.ts` (`ensureMoveDeps` in move-runner.ts:
async `bun install` scoped to the move dir, so a slow install never blocks the
event loop). Bare imports in `context.ts` resolve from the move's own
`node_modules` first; widget imports are bundled from the same location by the
widget build. Dependencies stay scoped to the move — nothing is added to the
host project or the harness.

- Install runs only when `node_modules` is missing. After changing a move's
  `package.json`, delete the move's `node_modules` to force a reinstall.
- Install failure logs a warning and module load proceeds (imports of the
  missing package then fail and are caught by the normal load-error path).
- Bun does not run dependency lifecycle scripts (postinstall) unless the
  package is explicitly trusted, which limits install-time supply-chain
  exposure. The move's own code runs with full harness privileges regardless —
  the trust boundary is who can write into the moves directory, unchanged by
  this feature.
- Reference: the chess example (`.modus/moves/chess/`) uses `chess.js` this way.

### Harness Imports (built-in moves only)

A built-in move under `harness/moves/` may import harness runtime modules by
relative path — `modus-brain` imports `../../docs-registry`, `docs-doctor` also
imports `../../profile-schemas`. In a dev run those resolve to the same on-disk
modules the server already loaded, so the move shares one DB connection, one
token store, one session manager.

A packaged build bundles the backend into a single `server.js` and ships no
harness sources, so each importable module needs an entry in
`harness/bridged-modules.ts`. Packaging emits a shim per entry that re-exports
the live instance from a process global (`harness/harness-bridge.ts`); bundling
a *copy* into the move would silently give it a second DB and break state.

**Importing a harness module from a built-in move without adding it to that list
fails only in a packaged build, never in dev.** Type-only imports are erased by
the transpiler and need no entry.

## Execution Modes

| Mode | Behavior |
|------|----------|
| `inline` | Returns rendered prompt to client; client merges into user message |
| `branch` | Spawns a new sibling session |
| `background` | Fire-and-forget, persisted status for later recall |
| `persistent` | Ambient gather-only move; re-runs `gather()` on every user turn until deactivated |

### When a move can be attached

A move does not need a fresh session. Sending `moves: [{ name, inputs }]` with
`POST /api/sessions/:id/messages` activates it against the live session and
prepends the gathered `<!-- move:NAME -->` block to that one message — no
interrupt, no resume, no restart. Persistent moves attached this way stay active
for subsequent turns.

`POST /api/sessions/:id/steer` takes the same bindings, so a move can ride an
interjection into a turn that is already running on a provider that supports
steering. See [Providers § Steering](./providers.md).

Two limits are worth knowing. Attaching during a running turn on a
non-steering provider queues the message *and* its gathered context until the
turn ends — the gather runs at send time, not at delivery time, so it reflects
state as of when you hit send. And skills a move attaches mid-session are
recorded but may not reach the agent by tool until restart, because the
provider's MCP endpoint URL is fixed at spawn.

### Seeing what a profile is about to attach

An agent profile's inline (non-persistent) move bindings gather **pre-spawn** and
are prepended to the session's first message. That injection is invisible at the
moment it matters — the user picks a profile, types, and sends, without ever
seeing how many tokens the profile is about to add on their behalf.

The composer therefore lists them as pending attachments *before* the first
message, labelled `<profile> attaches`, with a `×` on each. Removing one sends
its name in `skipProfileMoves` on `POST /api/sessions`, and
`startSessionWithMoves` filters it out of both activation phases. The field only
ever removes; absent means "run them all", so no existing caller changes.

The chips disappear once the conversation has a turn in it. Profile inline moves
fire exactly once per logical session — `skipPreviouslyInjectedForSession` stops
a resume or branch re-injecting them — so showing them afterwards would claim
something untrue. Persistent bindings are not listed here: they activate
post-spawn as ambient moves and already have their own chips with a working
deactivate.

`POST /api/sessions` also accepts `moves` now, so a move attached in the composer
survives being the message that creates the session. Previously that binding was
dropped, because only `sendMessage` and `steer` carried bindings and neither runs
on a session's first message.

### Asking the user for inputs (`ask` on a profile binding)

An agent profile's `moves: [{ name, inputs?, ask? }]` normally runs at session
start with whatever `inputs` the profile author wrote. `ask: true` defers that:

```json
{ "moves": [{ "name": "briefing", "ask": true, "inputs": { "depth": "short" } }] }
```

`startSessionWithMoves` filters `ask` bindings out of both activation phases, so
the move does not gather at spawn. Instead the UI docks the move's input form
above the chat composer when the session opens, seeded from the binding's
`inputs` — a binding can prefill some fields and ask for the rest. Submitting the
form activates the move against the live session (the same path the `/` picker
uses); dismissing it skips the move for that session.

Two behaviors follow from constraints elsewhere and are deliberate:

- **The move's bundled skills still resolve at spawn.** A provider is handed its
  skill scope before it starts and cannot be given a new one afterward, so
  deferring the skills too would leave the move unrunnable for the whole
  session — see the limit noted just above.
- **`ask` on a move that declares no `inputs` is ignored.** There is nothing to
  ask for, and an empty form would be a dead end.

Inputs marked `required` gate the form's submit button; the composer names the
outstanding fields inline. Requiredness is per-input and honours `visibleWhen`,
so a hidden field is never required.

## Submit vs API Contract

**Submit moves**: one-shot. `gather()` returns the prompt, agent calls `modus_submit(token, data)`
once, `onSubmit()` fires. Token has 10min TTL.

**API contract moves** (`api` field in move.json): support repeated submission. On activation,
the runner registers `handlers` from context.ts, creates a `mapi-{prefix}-{instanceId}` token
(no TTL), and passes it to `gather()` as `ctx.apiToken`. The agent can call
`modus_submit(apiToken, { op: "...", ...data })` repeatedly. Handlers manage state via
`MoveStateAPI`. With `api.state.persist: true`, state and the registry survive server restart.

**Persistent moves** (`persistent: true`): no submit-token lifecycle. Activation stores an
ambient registration per session; on each user turn the session manager calls
`gatherAmbientContext(sessionId)`, which re-runs `gather()` for each active persistent move
and appends the returned text to the prompt. If the move also declares `api`, it still gets
an API token and instance id.

## Token Flow (submit moves)

1. UI activates move → `POST /api/sessions/:id/moves/activate`
2. Token generated (short opaque string, 10min TTL)
3. `gather()` runs (if defined, 10s timeout) — builds and returns the full prompt string
4. For inline: prompt returned in `ActivateMoveResult.prompt` for client to send
   For branch/background: session spawned, prompt sent as first message
5. Agent receives prompt, does work, calls `modus_submit(token, data)`
6. Harness validates data against schema (if defined)
7. If invalid: retry feedback sent to agent (up to maxAttempts)
8. If valid: `onSubmit()` runs — can create sessions, trigger actions, and return a
   `SubmitResult` whose optional `notify: { channel, body }` is dispatched to a real channel
9. Token marked completed

## MoveConfig Key Fields

- `inputs[]` — form fields shown to user before activation (text, textarea, select, toggle, number)
  - A select can source its options dynamically: `optionsSource: { "type": "agentProfiles" }`
    (also `projects`, `sessions`), or the template form `options: "{{agentProfiles}}"`.
  - **Profile pickers prepend a "Current profile" sentinel option.** The runner translates
    it to the activating session's agent profile before `gather()` runs
    (`resolveAgentProfileInputs`), so a profile-picker input normally delivers a real
    profile name. When no session profile exists to translate to (a page embed, a
    profile-less session), the literal string `"Current profile"`
    (`CURRENT_PROFILE_SENTINEL` in `move-types.ts`) reaches the move verbatim — treat it,
    or an empty value, as "no explicit choice".
- `schema` / `schemaHint` — validation contract for modus_submit data
- `submit.required` — agent must call modus_submit
- `submit.retryOnInvalid` — surface validation failures back to the model for retry
- `submit.maxAttempts` — cap on invalid submissions (default 3)
- `agentProfile` — agent profile for branch/background spawned sessions
- `mode` — `"inline" | "branch" | "background"` (default `"inline"`)
- `gatherTimeoutMs` — override the `gather()` timeout (default 10000)
- `prepareTimeoutMs` — budget for the optional `prepare()` hook (default 120000)
- `persistent` — ambient gather mode; mutually distinct from branch/background execution
- `session.profileOverride` — swap agent profile for this move
- `session.settingsOverride` — fine-grained session settings for the spawned/inline session (provider, model, effort, maxTurns, tools, disallowedTools, toolStates, providerControls, loadProjectSettings)
- `session.afterSubmit` — "continue", "end", or "switch:profileName"
- `api` — API contract declaration (see below)
- `widget` — widget declaration (see below)
- `toolView` — transcript tool-view declaration (see below)
- `page` — registers a move-owned full page in the nav
- `capabilities` — runtime capability declaration for shell/session/action/notify/file access
- `trust` — `"builtin" | "reviewed" | "experimental"`
- `skills` — installed skills to attach while this move is active (see below)
- `origin` — `"harness"` or `"project"` (set automatically, not written to move.json)

## Skills (`skills` field and `skills/` directory)

A move contributes skills two ways: `skills: ["name"]` in `move.json` attaches
installed skills by name, and anything under `<move>/skills/<name>/SKILL.md` is
bundled and attached whenever the move is.

Attachment is transitive. Profiles and actions already attach moves, so a move
that bundles domain knowledge carries it wherever it is attached — without the
attaching profile naming the skills at all. That also gives a move an exportable
component: the protocol stays Modus-only, the packaged text does not.

Installed skills win over bundled ones on a name collision, so a project can
override a move's bundled copy by installing its own at
`.modus/skills/<name>/`. Unresolvable names are logged and skipped. Skills
attached by a move activated mid-session are recorded but may not reach the
agent by tool until the session restarts, because the provider's MCP endpoint
URL is fixed at spawn. See [Skills](./skills.md).

## API Contract (`api` field)

```json
{
  "api": {
    "tokenPrefix": "chess",
    "ops": {
      "move": { "description": "Play a move", "schema": { ... } },
      "resign": { "description": "Resign the game" }
    },
    "state": { "persist": true }
  }
}
```

- `tokenPrefix` — token becomes `mapi-{prefix}-{instanceId}` (default: move name)
- `ops` — declares what ops exist; unknown ops are rejected
- `state.persist` — write handler *state* to `.modus/moves/<name>/state/` for restart survival

Declaring `ops` is enough to persist the *registration* — you do not need
`state.persist` for that. The two are independent on purpose: a stateless move's
token is baked into the session transcript and an agent may call it hours or days
later, so the token-to-instance binding has to survive a restart even when there
is no handler state to save.

`context.ts` exports `handlers: Record<string, MoveApiHandler>`. Each handler receives
`MoveApiContext` (instanceId, sessionId, caller, state API, notify) and the submitted data.

A handler's return may carry keys beyond `ok`/`message`/`error`; they survive on both
surfaces. The HTTP route (`POST /api/moves/:name/op`) serializes the whole object, and
the `modus_submit` tool renders `message` (or `error`) first with the remaining keys
following as a fenced JSON block (`formatMoveApiResultText` in `move-api-result.ts`) —
so `{ ok: true, ms: 2832, usage: {...} }` reaches the agent instead of collapsing to
a bare "OK".

`ctx.state.get/set/delete` is the state API. Typed interface; shape is your contract.
If `api.state.persist` is true, state files live in `.modus/moves/<name>/state/<instanceId>.json`.
`_registry.json` in that same directory stores token-to-instance bindings for restart
rehydration, and is written for every API move regardless of `state.persist`. It is
pruned on write: registrations older than 30 days, or beyond the newest 200 per move,
are dropped.

Rehydration runs at boot over every project root in session history, and again for a
single token when an unknown one is submitted — so a registration written by a process
that never appeared in that boot scan is still recoverable. A token that cannot be
recovered reports a lifecycle failure naming the recovery step; it is never described
as expired, because API tokens have no TTL.

`ctx.notify(message, emit?)` pushes a message into the agent's session (session-inject — NOT
a channel). Optional `emit` injects a typed signal prefix: `[modus:{type}] {json}\n{message}`.

**Orchestration parity**: `MoveApiContext` also exposes the same engine operations
`gather()`/`onSubmit()` had, sourced from the Harness Context — `createSession`,
`triggerAction`, `activateMove`, `watchSessionTurns`, `wake(target, content, when?)`, and
`channels.send(channel, { text, data? })` for channel egress (Discord/Slack/file). See
[Harness Context](./harness-context.md) and [Notify & Channels](./notify.md).

`listInstances(states)` export in context.ts customizes instance labels for the resume UI.

Frontend API calls use `POST /api/moves/:name/op` with `{ apiToken, op, ...rest }`.
Agent-side API calls still go through `modus_submit(apiToken, { op, ...data })`.

That route also accepts **`multipart/form-data`**, so a handler can receive media
without base64ing it through JSON. `apiToken` and `op` are parts (or keys inside an
optional `json` part); every other part becomes a key in the handler's `data`.
Binary parts arrive as a web `File` — `await data.audio.arrayBuffer()` — and a
repeated key becomes a `File[]`. Plain text parts stay **strings**: multipart has
no types and coercing `"false"` would break any field whose value is legitimately
that string, so send structured values in the `json` part instead. Precedence,
lowest to highest: `json` → plain parts → files. The JSON path is unchanged.
Contract and parsing: `harness/move-op-request.ts`.

## Widget Declaration (`widget` field)

```json
{
  "widget": {
    "component": "widget.tsx",
    "panel": "right",
    "label": "Chess",
    "icon": "♟",
    "autoOpen": true
  }
}
```

Widget module is served at `/api/moves/:name/widget?cwd=...`. Active widgets for a session
are returned by `GET /api/sessions/:id/moves/widget` as `{ widget, apiToken, instanceId }[]`.

`mountOnAttach` enables widget-first activation: attach the widget and API registration first,
let the user configure state through frontend op calls, then run gather and send the message
through `/api/moves/:name/activate-attached`.

## Transcript Tool View (`toolView` field)

An API move can claim the transcript rows produced by its own `modus_submit`
calls with the same authored-React mechanism used by widgets:

```json
{
  "toolView": {
    "component": "tool-view.tsx",
    "ops": ["move"],
    "takeover": "block",
    "cache": "module"
  }
}
```

`ops` omitted claims every op. `takeover: "block"` (the default) replaces the
whole tool row, including its collapsed appearance; `"body"` preserves the
harness status/name/duration header and replaces only the expandable detail.
The component filename is resolved only from `move.json`. The component-serving
route rejects any requested filename that is not the move's declared `widget`
or `toolView` component.

The component receives `MoveToolViewProps` from
`harness/ui/src/move-tool-view.ts`: move/instance/session identity, the op and
handler input, the parsed handler result, artifacts attached to the turn,
running/completed/error status, `isLatest`, expansion state, and the same
`callOp`, `submitMessage`, and event subscription powers as a panel widget.
Use `isLatest` to make historical game/control rows read-only. Render useful
history from `input`, `result`, and `artifacts`; a live handler is an optional
enhancement, not a persistence mechanism.

The handler result remains model-facing text. Extra return keys are recovered
from the fenced JSON block written by `formatMoveApiResultText` and passed to the
component as `result`; rendered React is a separate, app-only surface. Move API
registrations rehydrate on demand, so `callOp` can work from an old transcript
while its retained registration exists. If the token cannot resolve, the move
was deleted, the component fails to load or render, or the op is not claimed,
the native tool row renders instead.

Move API calls are never folded into the transcript's collapsed core-tool runs.
Heavy deferred turns keep the existing behavior: their tool rows appear after
the user loads turn details, then resolve through this same path.

## Page Declaration (`page` field)

```json
{
  "page": {
    "id": "memory",
    "title": "Memory",
    "icon": "M",
    "nav": true
  }
}
```

Move pages register a nav entry using `view: "move-page:<name>"` and render through
`MovePageView` in the frontend. This is separate from `.modus/pages/*.json`: the move owns
the page and its widget/API behavior.

## Module Hooks

`context.ts` can export more than `gather()` and `onSubmit()`:

- `prepare(ctx)` — optional heavy-setup hook run **before** `gather()` on explicit activation
  (launch a program, poll until an MCP is reachable). Has its own longer budget
  (`prepareTimeoutMs`, default 120s) so `gather()` stays fast — it just builds the prompt.
- `handlers` — API op handlers for `api` moves
- `listInstances()` — custom labels for resume UIs
- `onAssistantTurn()` — hook invoked on assistant round end for active API move instances

`onAssistantTurn()` receives `MoveAssistantTurnContext` with the current assistant turn,
instance state, and an `emit()` helper that broadcasts `move-widget-event` UI events.

## Reload Semantics (editing `context.ts` while developing)

The edit-reload loop differs by export, and the difference is the single most
confusing thing about authoring an API move. **You do not need to restart the
harness.**

| Export | When your edit takes effect |
|---|---|
| `gather()`, `onSubmit()`, `prepare()`, `onAssistantTurn()`, `listInstances()` | **Next activation.** `loadMoveModule()` deletes the `require.cache` entry before `await import()`, so each activation re-reads the file from disk. |
| `handlers` (API ops) | **Next registration, not next call.** `registerMoveApi()` captures the `handlers` object into the in-memory registry, and op dispatch reads `reg.handlers[op]` from that snapshot. Editing the file changes nothing for an already-registered instance. |

To pick up a handler edit: **detach and re-attach the move.**
`POST /api/moves/:name/detach` drops the registration, and `attachMove()` calls
`loadMoveModule()` again before re-registering — so the new code is live without
restarting anything. Re-activating the move in a new message does the same.

Two traps that make an edit look like it did not land:

- **A page-embedded widget will not re-attach on navigation.** `MoveWidgetEmbed`
  caches its attachment at module scope keyed by `(moveName, cwd, widgetId)`, so
  leaving the page and coming back reuses the old registration. Reload the window.
- **A move whose `context.ts` fails to import keeps working with no visible
  error** — the loader logs and returns null. If an edit introduces a syntax
  error, the symptom is "my change did nothing", not a failure.

## MoveContext (passed to gather/onSubmit)

- `moveName`, `sessionId`, `cwd`, `userProfile`, `inputs`
- `session` — lastAssistantText, seq, profile, exchangeCount
- `db` — read-only queries (listSessions, search, getMoveHistory, getSessionMessages)
- `run(cmd)` — shell execution
- `harness` — HarnessBridge (createSession, sendMessage, triggerAction, notify, addSessionTag,
  listMoves, activateMove, watchSessionTurns). `harness.notify({ channel, body })` now routes
  to a real channel via the Harness Context (was a console.log stub). See [Notify & Channels](./notify.md).
- `secrets` — safe secret/env resolution helpers
- `meta(key, value)` — attach metadata (stored as gatheredContext for tracing)
- `token` — short-lived submit token (available during gather)
- `schema` — schema hint string (compact shape for the model)
- `date` — current ISO date (YYYY-MM-DD)
- `apiToken` — API contract token (only when move has `api` declaration)
- `instanceId` — instance identifier (only when move has `api` declaration)
- `store()/setStore()` — process-scoped per-instance memory for API moves
- `state` — state API for API moves

## modus_submit

Built-in MCP tool injected into every session via the `modus` MCP server at
`/api/mcp/modus`. Takes `{ token, data }`. The token ties submission to a
specific move activation. Without a valid token, submission is rejected.

For API contract moves, `data` must include an `op` field matching a declared op name.

Mission tokens (`mis-...`) and move API tokens (`mapi-...`) are routed through the same
tool entrypoint; `modus-mcp.ts` discriminates by token prefix.

## API Routes

- `GET /api/moves/:name?cwd=...` — move definition
- `POST /api/moves/activate` — activate without a parent session
- `POST /api/sessions/:id/moves/activate` — activate on a session
- `GET /api/moves/:name/runs` — move run history by move name
- `GET /api/move-runs/recent` — recent runs across moves
- `GET /api/move-runs/:id` — one move run
- `GET /api/sessions/:id/moves` — runs for a session
- `GET /api/sessions/:id/moves/active` — active submit tokens for a session
- `GET /api/sessions/:id/moves/widget` — active widget-backed move instances
- `GET /api/sessions/:id/moves/ambient` — active persistent moves
- `POST /api/sessions/:id/moves/deactivate` — deactivate a persistent move
- `POST /api/sessions/:id/moves/rekey` / `POST /api/moves/rekey-by-token` — repair session-id rekeys
- `POST /api/moves/:name/attach` — widget-first phase 1
- `POST /api/moves/:name/activate-attached` — widget-first phase 2
- `POST /api/moves/:name/detach` — remove an attached widget/API registration
- `GET /api/moves/:name/widget?cwd=...` — transpiled widget module
- `GET /api/moves/:name/widget?cwd=...&component=...` — declared widget or tool-view module
- `GET /api/moves/:name/widget.css?cwd=...` — optional widget CSS
- `GET /api/moves/resolve-token?token=...` — resolve a retained API token's tool-view declaration
- `POST /api/moves/:name/op` — frontend API op call (`caller: "user"`)

**Source**: `move-runner.ts`, `move-types.ts`, `modus-mcp.ts`.
