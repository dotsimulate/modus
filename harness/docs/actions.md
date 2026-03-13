---
title: Actions
audience: agents
lastUpdated: 2026-03-12
lastCommit: 1592796
covers: harness/action-runner.ts harness/action-types.ts
---

# Actions

Actions are the automation primitive. They define WHEN an agent runs, with
what context, and what happens after.

## Directory Structure

Built-in harness actions live in `harness/actions/<name>/`. Project-local actions
live in `.modus/actions/<name>/` and override built-ins of the same name.

Each action directory contains:
```
action.json   — ActionConfig (required)
context.ts    — ActionModule: gather(), verify?(), afterRun?() (required)
```

## Trigger Types

| Type | Fires when | Key fields |
|------|-----------|------------|
| `interval` | Timer elapsed | `every` ("30s", "5m", "1h"), `from` ("completion"/"start"), `activeHours` |
| `webhook` | HTTP POST to `/api/actions/:name/hook` | `token` (auto-generated) |
| `manual` | API call to `/api/actions/:name/trigger` | — |
| `action` | Another action completes | `source` (action name), `condition` ("any"/"done"/"error") |
| `session` | Session event fires | `on` (role + round + at, or "archived"/"deleted"), `excludeTags` |

## Execution Model

```
Trigger
  → gather(ctx) — build the prompt (access to DB, prior runs, trigger payload)
  → Spawn session with agent profile
  → Monitor until idle/done/error
  → verify?(ctx, result) — inspect output, accept/reject/retry
  → afterRun?(ctx, result) — side effects (only on success)
  → Notify channels (on configured statuses)
```

**Three layers of limiting:**
- **Run**: one session spawn. `maxRuns` caps runs per cycle.
- **Cycle**: a batch of runs within `cycleInterval`. Resets run counter.
- **Execution**: one lifecycle instance. `maxCycles` caps total cycles.

When limits exhaust: `onExhausted` controls behavior ("archive", "idle", "restart").

**Multi-step**: actions can define `steps[]` with different profiles. Each step
runs sequentially, receiving the previous step's result.

**Resilience**: `onGatherError`, `maxTransientRetries`, `retryBackoff` handle
transient failures. `maxRetries` handles verify failures.

**Artifacts**: `artifacts[]` declares expected output files with names and MIME
types. `ctx.artifactPath(filename)` provides namespaced paths. Verify can check
artifact existence.

**Static inputs**: `ActionConfig.inputs?: Record<string, unknown>` passes fixed
data into every run. Available as `ctx.inputs` in gather, verify, and afterRun.
`ctx.cwd` carries the action's configured working directory (from `cfg.cwd`).

**Origin**: `origin` (`"harness"` or `"project"`) is set automatically on load.
Returned by `GET /api/actions` so callers know where the action came from.

**Source**: `action-runner.ts`, `action-types.ts`.

## API Routes

- `GET /api/actions` — list all actions with state
- `GET /api/actions/:name` — single action config + state
- `POST /api/actions/:name/trigger` — manual trigger (only works for `manual` and `interval` types; other types require a trigger-constructed payload and are rejected)
- `POST /api/actions/:name/hook` — webhook trigger
- `GET /api/actions/:name/runs` — run history
- `GET /api/actions/:name/executions` — execution history
- `POST /api/actions/:name/executions` — start new execution
- `DELETE /api/actions/:name/executions/:id` — cancel execution
