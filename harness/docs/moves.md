---
title: Moves
audience: agents
lastUpdated: 2026-04-08
covers: harness/move-runner.ts harness/move-types.ts
---

# Moves

Moves are the user-facing invocation primitive. They define WHAT the user wants
done right now, with structured submission and validation.

## Directory Structure

Built-in harness moves live in `harness/moves/<name>/`. Project-local moves live
in `.modus/moves/<name>/` and override built-ins of the same name.

Each move directory contains:
```
move.json    — MoveConfig (required)
context.ts   — MoveModule: gather?(), onSubmit?(), handlers?, listInstances?() (optional)
widget.tsx   — React component (optional, for api moves with a widget)
```

No Handlebars templates. `gather()` returns the full prompt string directly.
The move.json `prompt` field is a fallback used only when context.ts has no `gather()`.

## Execution Modes

| Mode | Behavior |
|------|----------|
| `inline` | Returns rendered prompt to client; client merges into user message |
| `branch` | Spawns a new sibling session |
| `background` | Fire-and-forget, persisted status for later recall |
| `persistent` | Ambient gather-only move; re-runs `gather()` on every user turn until deactivated |

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
8. If valid: `onSubmit()` runs — can create sessions, trigger actions, notify
9. Token marked completed

## MoveConfig Key Fields

- `inputs[]` — form fields shown to user before activation (text, textarea, select, toggle, number)
- `schema` / `schemaHint` — validation contract for modus_submit data
- `submit.required` — agent must call modus_submit
- `submit.retryOnInvalid` — surface validation failures back to the model for retry
- `submit.maxAttempts` — cap on invalid submissions (default 3)
- `agentProfile` — agent profile for branch/background spawned sessions
- `mode` — `"inline" | "branch" | "background"` (default `"inline"`)
- `persistent` — ambient gather mode; mutually distinct from branch/background execution
- `session.profileOverride` — swap agent profile for this move
- `session.settingsOverride` — fine-grained session settings for the spawned/inline session (provider, model, effort, maxTurns, tools, disallowedTools, toolStates, providerControls, loadProjectSettings)
- `session.afterSubmit` — "continue", "end", or "switch:profileName"
- `api` — API contract declaration (see below)
- `widget` — widget declaration (see below)
- `page` — registers a move-owned full page in the nav
- `capabilities` — runtime capability declaration for shell/session/action/notify/file access
- `trust` — `"builtin" | "reviewed" | "experimental"`
- `origin` — `"harness"` or `"project"` (set automatically, not written to move.json)

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
- `state.persist` — write state and registry to `.modus/moves/<name>/state/` for restart survival

`context.ts` exports `handlers: Record<string, MoveApiHandler>`. Each handler receives
`MoveApiContext` (instanceId, sessionId, caller, state API, notify) and the submitted data.

`ctx.state.get/set/delete` is the state API. Typed interface; shape is your contract.
If `api.state.persist` is true, state files live in `.modus/moves/<name>/state/<instanceId>.json`
with `_registry.json` storing token-to-instance bindings for restart rehydration.

`ctx.notify(message, emit?)` pushes a message into the agent's session. Optional `emit`
injects a typed signal prefix: `[modus:{type}] {json}\n{message}`.

`listInstances(states)` export in context.ts customizes instance labels for the resume UI.

Frontend API calls use `POST /api/moves/:name/op` with `{ apiToken, op, ...rest }`.
Agent-side API calls still go through `modus_submit(apiToken, { op, ...data })`.

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

- `handlers` — API op handlers for `api` moves
- `listInstances()` — custom labels for resume UIs
- `onAssistantTurn()` — hook invoked on assistant round end for active API move instances

`onAssistantTurn()` receives `MoveAssistantTurnContext` with the current assistant turn,
instance state, and an `emit()` helper that broadcasts `move-widget-event` UI events.

## MoveContext (passed to gather/onSubmit)

- `moveName`, `sessionId`, `cwd`, `userProfile`, `inputs`
- `session` — lastAssistantText, seq, profile, exchangeCount
- `db` — read-only queries (listSessions, search, getMoveHistory, getSessionMessages)
- `run(cmd)` — shell execution
- `harness` — HarnessBridge (createSession, sendMessage, triggerAction, notify)
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
- `GET /api/moves/:name/widget.css?cwd=...` — optional widget CSS
- `POST /api/moves/:name/op` — frontend API op call (`caller: "user"`)

**Source**: `move-runner.ts`, `move-types.ts`, `modus-mcp.ts`.
