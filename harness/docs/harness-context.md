---
title: Harness Context
lastUpdated: 2026-07-26
covers: harness/harness-context.ts harness/wake-scheduler.ts harness/move-runner.ts harness/action-runner.ts harness/modus-mcp.ts
---

# Harness Context

The **Harness Context** is the canonical server-side capability contract for MO. Moves,
actions, api-handlers, and (reserved) missions all drive the same harness engines —
session-manager, action-runner, move-runner, db, notify. Historically each surface exposed
its own asymmetric slice with different names, powers, and safety checks. The Harness
Context unifies them: one namespaced capability object, one safety model.

## Shape

`buildHarnessContext(self)` returns a `HarnessContext` (`harness-context.ts`):

```ts
ctx.self        // identity + gating inputs, including pluginId for plugin-origin code
ctx.sessions    // create, send, wake, watchTurns, tag, untag, get, list
ctx.channels    // send(channel, { text, data? })  → the egress primitive (see notify.md)
ctx.moves       // activate, list
ctx.actions     // trigger
ctx.state       // MoveStateAPI (instance-scoped; NOOP when no instance bound)
ctx.db          // read-only MoveDB (sessions, search, move history, messages)
ctx.secrets     // resolve, isSet
ctx.shell       // run(cmd)
ctx.artifacts   // insert, attach
ctx.terminal    // create(opts) → pty handle
ctx.pluginSettings // get(key), all() → resolved values for self.pluginId + user/project context
ctx.log(message, metadata?)
```

It is **not a god object**. Each namespace is built by its own small factory
(`createSessions`, `createChannels`, …) and is independently unit-testable. The composer
(`buildHarnessContextWith`) only wires modules together; it implements no engine operation
itself.

## Gating

Each namespace method asserts its capability against `ctx.self.trust` at the method
boundary — the same model as the old `move-runner.assertCapability`:

- **builtin** — fully trusted, never blocked.
- **reviewed** — blocked (throws + audit log) when the capability is explicitly `false`.
- **experimental** — never blocked, but a denial is logged (audit-only).

Capabilities are the move shape (`shell`, `sessionSpawn`, `sessionMessage`, `actionTrigger`,
`notify`, `fileRead`, `fileWrite`). Because gating lives at the namespace boundary, every
old and new surface gets identical safety behavior for the same underlying operation.

## Adapters (backwards compatibility)

The historic surfaces are now thin **adapters** over the same context — call sites are
untouched:

| Surface | Adapter behavior |
|---|---|
| `ctx.harness` (`HarnessBridge`) in moves | Same method names/shapes; delegates to `ctx.sessions/actions/channels/moves`. `notify` now reaches a real channel (was a console.log stub). |
| `MoveApiContext` (move API handlers) | Keeps its historic fields (session-inject `notify`, `sendMessage`, state, db, …) **plus** new orchestration parity: `createSession`, `triggerAction`, `activateMove`, `watchSessionTurns`, `channels`. |
| `ActionContext` (actions) | Keeps all existing fields **plus** `ctx.sessions` / `ctx.channels`. Actions gain `trust`/`capabilities` (default: harness origin → builtin, project origin → reviewed). |
| `.modus/api-handlers/*.ts` | Dual signature, detected by **export key** (never arity): `export const handlers = {…}` or named fns → old `(sessionId, data)`; `export const ops = {…}` → new `(ctx, data)` with the full Harness Context. |

Plugin-origin move/action adapters also expose `pluginSettings`. Code without a
plugin identity receives an empty accessor.

## Session wake / mailbox

`ctx.sessions.wake(target, content, when?)` delivers a message to an existing session,
generalizing what webhook session-routing already did. `target` is a session id **or** a
tag (tags fan out to every non-archived session carrying them — a "waiting team").

- `when` omitted / `"now"` → deliver immediately (`session-manager.deliverToSession`).
  Idle targets start a turn (= wake); running targets queue (drained at the turn's end).
- `{ at: ISO }` → one-shot at a time.
- `{ every: "30m" }` → recurring.
- `{ onEvent: SessionTriggerEvent }` → fire when a matching session event occurs (e.g.
  `{ role: "assistant", round: "every:3", at: "end" }` to re-engage a worker every 3 rounds).

Scheduled/event wakes are owned by `wake-scheduler.ts` — a small engine with its own 10s
tick loop and a `scheduled_wakes` table for restart survival. `onEvent` wakes are matched
from session-manager's lifecycle emission points (a cascade cooldown bounds self-referential
wakes). `wake` returns a `WakeHandle` with `cancel()`.

A "waiting team": park N workers on a "wait for instruction" first message, tag them
`role:worker`, then `wake("role:worker", task, { every: "30m" })` to re-engage them. Each
wake is an inspectable session event via the global bus and `activity.db`.

## prepare() — heavy setup before gather

Moves may export an optional `prepare(ctx)` (`MoveModule`) run **before** `gather()` on
explicit activation. Use it for slow readiness work — launch a program, poll until an MCP
is reachable — so `gather()` stays fast (it just builds the prompt). `prepare()` has its
own budget (`prepareTimeoutMs`, default 120s). `gather()`'s timeout is configurable per move
via `gatherTimeoutMs` (default 10s).

## The engine seam (internals)

`harness-context.ts` must not statically import session-manager / action-runner /
move-runner (they import it — that would deadlock module init). All external calls go
through a `HarnessEngines` bundle; `liveEngines()` lazy-`require`s the real modules in one
place. `buildHarnessContextWith(self, engines)` lets tests inject stubs and exercise each
capability module in isolation without global module mocking.

**Source**: `harness-context.ts`, `wake-scheduler.ts`, and the adapters in `move-runner.ts`,
`action-runner.ts`, `modus-mcp.ts`.
