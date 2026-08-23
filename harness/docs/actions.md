---
title: Actions
lastUpdated: 2026-08-22
covers: harness/action-runner.ts harness/action-types.ts harness/harness-context.ts harness/skill-attachment.ts
---

# Actions

Actions are the automation primitive. They define WHEN an agent runs, with
what context, and what happens after.

## Directory Structure

Built-in harness actions live in `harness/actions/<name>/`. Project-local actions
live in `.modus/actions/<name>/`, and enabled plugin actions live in
`<plugin>/.modus/actions/<name>/`. Resolution is project → plugin → built-in.

Each action directory contains:
```
action.json   — ActionConfig (required)
context.ts    — ActionModule: gather(), verify?(), afterRun?() (required)
```

## Trigger Types

| Type | Fires when | Key fields |
|------|-----------|------------|
| `interval` | Timer elapsed | `every` ("30s", "5m", "1h"), `from` ("completion"/"start"), `activeHours` |
| `webhook` | HTTP POST to `/api/actions/:name/hook?token=<token>` | `token` (auto-generated, passed as a **query param**), `sessionKey?` |
| `manual` | API call to `/api/actions/:name/trigger` | — |
| `action` | Another action completes | `source` (action name), `condition` ("any"/"done"/"error") |
| `session` | Session event fires | `on` (role + round + at, or "archived"/"deleted"), `excludeTags` — payload includes `assistantSeq` + `assistantMessageUuid` on assistant rounds |

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
types. For execution `<executionId>` and run `<runNumber>`, `ctx.artifactDir()` is
`<actionDir>/output/exec-<executionId>/run-<runNumber>/`, and
`ctx.artifactPath(filename)` safely joins a filename beneath it. This location is
beside the authored action, not under the active Vault's writable root: two Vault
backends that run the same project or plugin action therefore share that action's
output tree. Verify can check artifact existence.
`ctx.attachArtifact({ sessionId, seq, path, name, mime, ... })`
attaches an already-written file to a specific session turn, making it accessible
via `/api/sessions/:id/artifacts/:artifactId`.

**Static inputs**: `ActionConfig.inputs?: Record<string, unknown>` passes fixed
data into every run. Available as `ctx.inputs` in gather, verify, and afterRun.
`ctx.cwd` carries the action's configured working directory (from `cfg.cwd`).
Plugin actions default `cwd` to the plugin root and expand `${pluginDir}`
recursively in `cwd` and `inputs`.

**Move activation**: `ActionConfig.moves?: ActionMoveSpec[]` declares moves to
activate on the spawned session. The runner uses move activation after session
creation, so actions can combine automation with move-defined submit/API flows.

**Skill attachment**: `ActionConfig.skills?: string[]` attaches installed skills
to the spawned session by name. Skills bundled inside an activated move come
along transitively, so an action that attaches a move also gets that move's
skills. Names that resolve to nothing are logged and skipped rather than failing
the run. See [Skills](./skills.md).

### Calling a webhook action from outside Modus

The trigger's `token` is passed as a **query parameter**, not a header and not a
body field:

```bash
curl -X POST "http://127.0.0.1:<port>/api/actions/<name>/hook?token=<token>" \
  -H 'Content-Type: application/json' \
  -d '{"any":"payload"}'
```

- **No harness credential is needed.** The hook path is exempt from the harness
  auth middleware (it is matched by `/^\/api\/actions\/[^/]+\/hook$/` and allowed
  through before any token/PIN check), because the action's own `token` *is* the
  authentication. Treat that token as a secret with the authority to start an
  agent run.
- A bad token or unknown action returns `400`. A malformed JSON body is coerced
  to `{}` rather than rejected.
- On success the response is `{ ok: true }`, plus `sessionId` when the run
  spawned a session and `continued: true` when it routed into an existing one.

**Finding the port.** There is no fixed address under the desktop app: the shell
launches the harness with `HARNESS_PORT=0`, so the OS assigns a free port on
every start and any URL you hardcode dies at the next restart. The desktop shell
writes the live address to `<MODUS_HOME>/runtime/desktop-supervisor.json`
(written to a `.json.tmp` and renamed into place) with this shape:

```json
{ "mode": "managed-local", "desktopPid": 1234, "backendPid": 5678, "port": 51234,
  "instanceId": null, "version": "0.1.0", "apiBase": "http://127.0.0.1:51234",
  "uiConnected": true, "tailscale": null }
```

`mode` is one of `managed-local` (the shell owns the backend), `external-local`,
or `remote`; only `managed-local` carries a `backendPid`.

Re-read it per call rather than caching `apiBase`. The file is **deleted on
shutdown**, so its absence means "not running". Note this is an internal record
that happens to be useful for local discovery — it is not a versioned contract,
so pin nothing to fields beyond `port`/`apiBase` without checking.

`apiBase` is loopback (`127.0.0.1`), so a non-local caller — a GitHub webhook,
say — cannot reach a hook endpoint without a tunnel or a Tailscale address.
Running `modus start` instead of the desktop app gives you a stable configured
port.

**Webhook session routing**: webhook actions can declare `sessionKey`. When the
incoming payload contains that field, the runner looks for an existing session
tagged as `${actionName}:${sessionKey}:${value}`. If found, it sends the payload
as a follow-up message to that session instead of creating a new run. Otherwise
it creates a new run and tags the new session for future routing.

**Harness Context capabilities**: `ActionContext` exposes `ctx.sessions` (spawn / message /
`wake` / `watchTurns` / tag sessions) and `ctx.channels` (`send(channel, { text, data? })` —
egress to Discord/Slack/file), sourced from the unified Harness Context. These are gated by
the action's trust/capabilities. See [Harness Context](./harness-context.md) and
[Notify & Channels](./notify.md).

**Trust & capabilities**: `ActionConfig.capabilities` (shell/session/action/notify/file) and
`ActionConfig.trust` (`"builtin" | "reviewed" | "experimental"`) gate those Harness Context
operations at the namespace boundary. When `trust` is omitted it defaults by origin: harness
origin → `builtin` (fully trusted), project origin → `reviewed` (enforced as declared).

**Origin**: `origin` (`"harness"`, `"project"`, or `"plugin"`) is set automatically on load.
Returned by `GET /api/actions` so callers know where the action came from.

**Profile resolution**: plugin actions resolve unqualified `agentProfile`
references against their own plugin first. Resolved sessions store a qualified
profile key. A missing initial or step profile emits
`automation_profile_missing`, records a warning on the action run, and continues
with normal session fallbacks.

**Source**: `action-runner.ts`, `action-types.ts`.

## API Routes

- `GET /api/actions` — list all actions with state
- `GET /api/actions/:name` — single action config + state
- `PATCH /api/actions/:name` — update persisted config fields such as `enabled` or interval
- `POST /api/actions/:name/trigger` — manual trigger (only works for `manual` and `interval` types; other types require a trigger-constructed payload and are rejected)
- `POST /api/actions/:name/hook` — webhook trigger
- `GET /api/actions/:name/runs` — run history
- `GET /api/actions/:name/executions` — execution history
- `GET /api/actions/:name/executions/:id/runs` — runs inside one execution
- `POST /api/actions/:name/executions` — start new execution
- `DELETE /api/actions/:name/executions/:id` — cancel execution
- `GET /api/actions/:name/info` — return raw `action.json` and `context.ts` source
- `DELETE /api/actions/:name/runs` — clear persisted run history
- `POST /api/actions/:name/reset` — reset in-memory execution state
- `GET /api/actions/:name/preferences` — read UI preferences
- `POST /api/actions/:name/tags` / `DELETE /api/actions/:name/tags/:tag` — mutate freeform tags
- `POST /api/actions/reload` — reload actions from disk

## Parking an action (`enabled: false`)

`enabled` is **required** in `action.json` (`ActionConfig.enabled: boolean`).
An action that does not say `true` does not run — the opposite of a move, where
`enabled` is optional and absent means on. An action fires on its own, so
silence has to mean off.

Setting `enabled: false` parks the action on disk. It is still discovered,
still listed in the actions UI, and its run history is kept; what stops is
firing:

| Path | With `enabled: false` |
|---|---|
| interval scheduling | `nextRunAt` is `null`; never scheduled |
| watch triggers | skipped in the watch sweep |
| session / action triggers | skipped |
| `POST /api/actions/:name/hook` (webhook) | `{ ok: false, error: "action is disabled" }` |
| idle executions showing "RUNNING" | closed when the action is disabled |
| explicit manual trigger (`triggerAction`) | **still runs** — see below |

Toggling through `PATCH /api/actions/:name` is not in-memory only: it writes
`enabled` back into `action.json` (`writeActionConfig`), so a toggle from the UI
survives a restart and shows up as a file edit in version control.

An explicit manual trigger is not gated on `enabled`. `triggerAction` checks the
trigger type and the concurrency limit but not the flag, so pressing run on a
parked `manual` or `interval` action fires it. Read `enabled` as governing
*automatic* firing rather than as a lock.

Vault policy remains an independent execution boundary. A denied project or
plugin action is hidden from runtime lookup, and every dispatch rechecks policy;
an explicit manual trigger does not bypass it. An allow-to-deny policy edit
blocks the next interval, webhook, chain, session, or manual trigger without an
action reload, but does not terminate a run that already began.

Re-enabling resets exhaustion (`maxRuns`/`maxCycles`) and, for an interval
trigger, schedules the next run one full interval out rather than immediately —
so re-enabling never causes a catch-up burst.

## Reload semantics

Action discovery is snapshot-based. Creating/removing an action directory or
editing `action.json` does not update the in-memory scheduler until harness
startup or `POST /api/actions/reload`. Reload scans built-in, project, and
enabled-plugin roots; it adds new actions, refreshes config for existing ones,
and removes missing actions only when they have no active execution. An active
execution keeps running, but its state receives the refreshed config.

`context.ts` has a different lifetime: each run imports it with a fresh
timestamp query (`?t=<now>`), so edits are read when the next run starts and do
not require the discovery reload. As with moves, an installed desktop's
built-ins come from its staged resource snapshot; editing another source
checkout requires rebuilding/reinstalling that snapshot.
