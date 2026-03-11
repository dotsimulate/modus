---
title: Moves
audience: agents
lastUpdated: 2026-03-11
lastCommit: cf9d454
---

# Moves

Moves are the user-facing invocation primitive. They define WHAT the user wants
done right now, with structured submission and validation.

## Directory Structure

Each move is a directory in `.modus/moves/<name>/`:
```
move.json    — MoveConfig (required)
context.ts   — MoveModule: gather?(), onSubmit?() (optional)
prompt.hbs   — Handlebars prompt template (optional, inline prompt is fine)
```

## Execution Modes

| Mode | Behavior |
|------|----------|
| `inline` | Injected as a message into the current session |
| `branch` | Spawns a new sibling session |
| `background` | Fire-and-forget, persisted status for later recall |

## Token Flow

1. UI activates move → `POST /api/sessions/:id/moves/activate`
2. `gather()` runs (if defined) — collects context from DB, filesystem, etc.
3. Token generated (short opaque string, 10min TTL)
4. Prompt rendered with `{{token}}`, `{{input.*}}`, `{{context.*}}`, `{{schema}}`
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
- `session.profileOverride` — swap agent profile for this move
- `session.afterSubmit` — "continue", "end", or "switch:profileName"

## MoveContext (passed to gather/onSubmit)

- `moveName`, `sessionId`, `cwd`, `userProfile`
- `session` — lastAssistantText, seq, profile, exchangeCount
- `db` — read-only queries (listSessions, search, getMoveHistory)
- `run(cmd)` — shell execution
- `harness` — HarnessBridge (createSession, sendMessage, triggerAction, notify)

## modus_submit

Built-in MCP tool injected into every session via the `modus` MCP server at
`/api/mcp/modus`. Takes `{ token, data }`. The token ties submission to a
specific move activation. Without a valid token, submission is rejected.

**Source**: `move-runner.ts`, `move-types.ts`, `modus-mcp.ts`, `prompt-loader.ts`.
