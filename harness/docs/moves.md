---
title: Moves
audience: agents
lastUpdated: 2026-03-16
lastCommit: a9adf68
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

## Submit vs API Contract

**Submit moves**: one-shot. `gather()` returns the prompt, agent calls `modus_submit(token, data)`
once, `onSubmit()` fires. Token has 10min TTL.

**API contract moves** (`api` field in move.json): support repeated submission. On activation,
the runner registers `handlers` from context.ts, creates a `mapi-{prefix}-{instanceId}` token
(no TTL), and passes it to `gather()` as `ctx.apiToken`. The agent can call
`modus_submit(apiToken, { op: "...", ...data })` repeatedly. Handlers manage state via
`MoveStateAPI`. With `api.state.persist: true`, state and the registry survive server restart.

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
- `submit.maxAttempts` — cap on invalid submissions (default 3)
- `agentProfile` — agent profile for branch/background spawned sessions
- `session.profileOverride` — swap agent profile for this move
- `session.settingsOverride` — fine-grained session settings for the spawned/inline session (provider, model, effort, maxTurns, tools, disallowedTools, toolStates, providerControls, loadProjectSettings)
- `session.afterSubmit` — "continue", "end", or "switch:profileName"
- `api` — API contract declaration (see below)
- `widget` — widget declaration (see below)
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

`ctx.notify(message, emit?)` pushes a message into the agent's session. Optional `emit`
injects a typed signal prefix: `[modus:{type}] {json}\n{message}`.

`listInstances(states)` export in context.ts customizes instance labels for the resume UI.

API calls from the widget use `POST /api/moves/:name/op` with `{ token, data }`.

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

## MoveContext (passed to gather/onSubmit)

- `moveName`, `sessionId`, `cwd`, `userProfile`, `inputs`
- `session` — lastAssistantText, seq, profile, exchangeCount
- `db` — read-only queries (listSessions, search, getMoveHistory, getSessionMessages)
- `run(cmd)` — shell execution
- `harness` — HarnessBridge (createSession, sendMessage, triggerAction, notify)
- `meta(key, value)` — attach metadata (stored as gatheredContext for tracing)
- `token` — short-lived submit token (available during gather)
- `schema` — schema hint string (compact shape for the model)
- `date` — current ISO date (YYYY-MM-DD)
- `apiToken` — API contract token (only when move has `api` declaration)
- `instanceId` — instance identifier (only when move has `api` declaration)

## modus_submit

Built-in MCP tool injected into every session via the `modus` MCP server at
`/api/mcp/modus`. Takes `{ token, data }`. The token ties submission to a
specific move activation. Without a valid token, submission is rejected.

For API contract moves, `data` must include an `op` field matching a declared op name.

**Source**: `move-runner.ts`, `move-types.ts`, `modus-mcp.ts`.
