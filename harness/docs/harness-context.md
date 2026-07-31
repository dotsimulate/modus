---
title: Harness Context
lastUpdated: 2026-07-29
covers: harness/harness-context.ts harness/wake-scheduler.ts harness/move-runner.ts harness/action-runner.ts harness/modus-mcp.ts harness/model-oneshot.ts harness/providers/pi-model.ts
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
ctx.model       // complete, promote, recent → one-shot model calls (see below)
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
`notify`, `modelCall`, `fileRead`, `fileWrite`). Because gating lives at the namespace
boundary, every old and new surface gets identical safety behavior for the same underlying
operation.

`modelCall` is deliberately separate from `sessionSpawn` even though both reach a model: a
one-shot spends tokens without producing anything visible in the session list, so code that
must never cost money needs a way to say so without also losing the ability to spawn.
`ctx.model.promote()` is gated by `sessionSpawn`, because spawning is what it does — so
denying `modelCall` still allows promoting a one-shot that already ran.

## Adapters (backwards compatibility)

The historic surfaces are now thin **adapters** over the same context — call sites are
untouched:

| Surface | Adapter behavior |
|---|---|
| `ctx.harness` (`HarnessBridge`) in moves | Same method names/shapes; delegates to `ctx.sessions/actions/channels/moves`. `notify` now reaches a real channel (was a console.log stub). |
| `MoveApiContext` (move API handlers) | Keeps its historic fields (session-inject `notify`, `sendMessage`, state, db, …) **plus** orchestration members sourced from this context. It is *not* a superset of `MoveContext` — there is no `run`/shell on handlers. Exact member list, generated from source: [`generated/authoring-contracts`](./generated/authoring-contracts.md). |
| `ActionContext` (actions) | Keeps all existing fields **plus** `ctx.sessions` / `ctx.channels` / `ctx.model`. Actions gain `trust`/`capabilities` (default: harness origin → builtin, project origin → reviewed). |
| `.modus/api-handlers/*.ts` | Dual signature, detected by **export key** (never arity): `export const handlers = {…}` or named fns → old `(sessionId, data)`; `export const ops = {…}` → new `(ctx, data)` with the full Harness Context. |

Plugin-origin move/action adapters also expose `pluginSettings`. Code without a
plugin identity receives an empty accessor.

## One-shot model calls (`ctx.model`)

A model call with **no session**: prompt in, text out, no tools, no state, no subprocess.
This is the cheap rung below `ctx.sessions.create()`, for transforms whose answer is a value
rather than a conversation — punctuating dictated text, naming a thing, classifying,
translating.

```ts
const { text, oneShotId } = await ctx.model.complete({
  prompt: "Add punctuation and capitalisation. Return only the corrected text:\n\n" + raw,
  profile: "dictation-cleanup",   // resolves provider + model
  maxTokens: 200,
});
```

Reachable as `ctx.model` on the Harness Context, `ctx.model` on `MoveApiContext`,
`ctx.harness.model` in move `onSubmit`, and `ctx.model` on `ActionContext`.

**Only the PI provider family can serve one-shots** — `openai-compat`, `ollama`,
`openrouter`, and user/plugin declarative providers (`litellm` remains an alias)
(`listOneShotProviders()` in `providers/provider-names.ts`). That is structural, not a missing
feature: PI is an in-process SDK, so `pi-ai`'s `completeSimple()` reaches the model directly,
while every other provider is a CLI the harness spawns and converses with. A one-shot against
`claude-code`, `codex`, `cursor`, `antigravity`, `grok-build`, `opencode` or `gemini-cli`
**throws** and names the capable providers. It does not fall back to spawning a session — that
would silently reintroduce the cost the primitive exists to avoid.

Resolution rules (`resolveOneShotTarget`), all of which throw rather than guess:

| Input | Result |
|---|---|
| `profile` naming an agent profile | provider + model taken from it |
| explicit `provider` / `model` | overrides the profile |
| profile omits `provider` | error — `GlobalConfigSchema` has no default provider to fall back to |
| neither profile nor provider | error |
| resolved provider is not PI-family | error naming the current `listOneShotProviders()` result |

The model object is built by `buildPiModel` in `providers/pi-model.ts` — the **same** seam the
agentic PI provider uses, so a one-shot and a session against the same profile resolve the
same baseUrl (from secrets), the same `providerDefaults`, and the same OpenAI-compat flags.

### Promotion

A one-shot answer you disagree with is a dead end unless you can keep talking, so every call
is recorded and can become a real session:

```ts
const { sessionId } = await ctx.model.promote(oneShotId);
```

- **Replay, not restore.** The new session's first user message contains the original prompt
  and the previous answer (`buildPromotionPrompt`). Rebuilding provider-side history is a
  different problem (see `checkpoint-rewind-decisions-2026-07-11.md`) and would only work for
  providers that support resume; replay works everywhere and is honest that the session was
  handed a transcript rather than having lived through it.
- **Idempotent.** Promoting twice returns the same session id — the caller is usually a button
  and a double click must not cost two sessions.
- **Requires a profile.** A one-shot made with a bare `provider`/`model` has no profile to
  spawn with, so promotion throws rather than inventing one.
- The session is spawned into the **origin's** project (`record.origin.cwd`), not the
  promoter's, and through `ctx.sessions.create` so it inherits that gate and audit entry.

### Records

`ctx.model.recent(limit?)` returns recent one-shots, newest first. The store is a bounded
in-memory ring (`ONE_SHOT_STORE_LIMIT`, 50): promotion is a human action taken shortly after
the call, and an unbounded map would be a slow leak in a long-running backend. Records do not
survive a restart, deliberately — offering a promote link for a call whose context is gone
would be worse than not offering one.

Both `complete` and `promote` write audit entries (`harness_model_oneshot`,
`harness_model_promote`) carrying the provider, model, one-shot id, and token/cost usage.

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
