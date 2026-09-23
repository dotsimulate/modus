---
title: Actions
lastUpdated: 2026-09-15
covers: harness/action-runner.ts harness/action-types.ts harness/harness-context.ts harness/skill-attachment.ts harness/core-action-overlay.ts harness/action-setting-reference.ts
---

# Actions

Actions are named operations with triggers and a recorded result. They execute
commands, custom code, model completions, or agent sessions. The trigger and page
presentation are independent of the execution choice.

## Command and Code operations

A build button needs only `action.json` in an action directory:

```json
{
  "name": "build",
  "execution": { "type": "command", "executable": "bun", "args": ["run", "build"] }
}
```

The directory name is the action identity. `trigger` defaults to `manual`,
`enabled` to `true`, and project actions run in their project root unless `cwd`
is supplied. Commands run on the **connected backend machine**. The Actions
manager and `action-card` page widget show the execution target, Run control,
expandable output, result, and cancellation. They do not open a terminal for a
finite operation. To expose a selected operation on a page, use a widget leaf
with `"type": "action-card", "actionName": "build"`.

`execution` and the AI fields (`answerer`, `agentProfile`, `steps`, model/session
overrides, and AI retry options) are mutually exclusive. Existing definitions
without `execution` retain their gather → session/completion pipeline.
Command actions never load `context.ts`. Code actions load it only in an isolated
process and call **`run(ctx)`**, never `gather`, `verify`, or `afterRun`.

### Parameterized commands

```json
{
  "name": "export",
  "execution": {
    "type": "command",
    "executable": "bun",
    "args": ["scripts/export.ts", "--format", { "input": "format" }]
  },
  "inputSchema": {
    "type": "object",
    "properties": {
      "format": { "type": "string", "enum": ["json", "csv"], "default": "json" }
    },
    "required": ["format"],
    "additionalProperties": false
  }
}
```

Each input reference inserts exactly one argument. It never interpolates shell
text. `execution.shell: true` explicitly interprets `executable` as a shell
script using the platform shell; `args` cannot be combined with that mode.
For portable command definitions, prefer executable plus arguments.

`inputSchema` is a deliberately limited JSON Schema subset: object properties
of type string, number, integer, or boolean; required, default, enum, title,
description, minLength/maxLength, and minimum/maximum. Unknown fields and schema
keywords are rejected. No coercion occurs; invocation input JSON is limited to
16 KiB. Static `inputs` remain configuration; invocation values are validated
separately and merged over static values for Code/AI contexts.

The same validation applies to Run forms, `POST /api/actions/:name/trigger`
with `{ "inputs": { "format": "csv" } }`, SDK
`triggerAction(name, scope, inputs)`, and Harness Context
`actions.trigger(name, inputs)`. For Command/Code webhooks, the entire JSON body
is the invocation input object. Session/chain events supply `ctx.trigger.payload`;
their input schemas must be satisfiable by defaults. A Command/Code webhook
cannot configure the AI-only `sessionKey` routing option.

### Isolated code and explicit handoff

Set `"execution": { "type": "code" }` and provide `context.ts`:

```ts
export async function run(ctx) {
  const tests = await ctx.process.run({ executable: "bun", args: ["test"], check: false });
  if (tests.exitCode !== 0) {
    await ctx.actions.trigger("review-test-failure", {
      runId: ctx.runId,
      output: (tests.stdout + tests.stderr).slice(-12000),
    });
  }
  return { summary: "Tests inspected", data: { exitCode: tests.exitCode } };
}
```

The receiving action declares `runId` and `output` in its own `inputSchema`.
It may be an AI action whose gather hook reads `ctx.inputs`. Handoff records the
parent run; it means the receiving action was accepted, not that its later work
succeeded. There is no implicit repair agent. `steps[]` remains an AI profile
sequence, not a mixed workflow engine.

`ctx.process.run({ executable, args?, cwd?, check? })` returns exitCode, signal,
stdout, stderr, and truncated. A nonzero exit throws `ProcessExitError` by
default; `check: false` opts into explicit inspection. All calls must be awaited.
The context also supplies runId, actionName, inputs, trigger, cwd, signal,
log(message), artifacts.path(filename), secrets.resolve(reference),
actions.trigger(name, inputs), and sessions.create({ profile, prompt }). See
`generated/authoring-contracts` for exact declarations. Primary code and required
artifact validation complete before success. Notification delivery errors are
stored separately as `afterRunError`.

Results contain optional summary, JSON data, and artifacts
`[{ name, path, mime }]`. Returned artifact files must exist and be nonempty;
required `artifacts[]` declarations must match returned names and MIME types.
Relative returned paths resolve against the operation's working directory.
Use `ctx.artifacts.path(filename)` for a managed output path under the active
Vault's data directory, `action-artifacts/<runId>/`. Command actions
currently return process results; custom artifact-producing work uses Code.

### Ownership, limits, and receipts

- The harness supervises responsive guardian processes. Each guardian owns its
  command or code worker. Managed Code processes have their own guardians.
  Windows teardown uses `taskkill /T`, then `/F`; POSIX uses detached process
  groups. A guardian detects harness disconnection and tears down its tree,
  including blocked code workers. This is crash containment for trusted local
  code, not a security sandbox or CPU/memory quota.
- Defaults are concurrency one per action, **four Command/Code runs globally**,
  and a **five-minute timeout**. Set positive `concurrency` and `timeoutMs` to
  override per-action limits. There is no waiting queue and no automatic retry.
  Code permits at most four managed processes and eight pending context requests.
- Cancellation and timeout request cooperative cancellation, then terminate the
  owned tree with a bounded grace period and forced termination. A run holds its
  slot through cleanup. Reset is rejected while operation work remains active.
  Descendants that deliberately detach or escape ownership are outside this
  process-tree guarantee.
- Worker messages/results are limited to 256 KiB. Stdout and stderr retain
  separate 32 KiB tails with a truncation flag. Snapshots persist at 500 ms
  intervals and existing UI polling displays them while work runs. Stderr alone
  is not failure. Total historical run count is not automatically pruned.
- Run rows retain legacy `done`/`error`/`skipped` statuses for chain and notify
  compatibility. `operation.outcome` distinguishes succeeded, failed,
  could-not-start, timed-out, cancelled, interrupted, and skipped. No session or
  fake model response is created. Receipt metadata includes run/caller/parent
  identity, backend cwd, invocation inputs, command details, definition hash,
  exit status, bounded logs, and structured results. Normal run timestamps
  provide timing. The hash covers resolved configuration and the Code entry
  file; it does not snapshot sibling dependencies or mutable external state.
- Startup marks unfinished runs interrupted; it does not replay side effects.
  `enabled: false` parks automatic triggers but still allows explicit Run for
  manual/interval actions. Vault policy is checked at dispatch and capability
  requests. Existing trust-tier semantics govern execution (`shell`) and handoff
  (`actionTrigger`/`sessionSpawn`).
- `env: { "API_KEY": { "secret": "service-key" } }` resolves a named secret at
  execution time. Resolved secrets are excluded from receipts and best-effort
  redacted from retained logs/results. Arbitrarily transformed secrets, ambient
  environment values, and secrets embedded directly into authored commands are
  not guaranteed to be redacted; use references.

External terminals, long-running services, automatic retry policies, deduplication
keys, custom confirmation workflows, and general workflow graphs are outside
this finite operation contract.

## Directory Structure

Shipped core actions live in `harness/core-actions/<name>/` — tracked content of
the built-in `modus-core` tier, staged into a build. Project-local actions live in
`.modus/actions/<name>/`, and enabled plugin actions live in
`<plugin>/.modus/actions/<name>/`. Resolution is project → plugin → built-in.

`harness/actions/<name>/` is a gitignored personal scratch root. It still loads in
a source checkout, but it is deliberately not staged into a build: the staging
copy has no gitignore awareness, so shipping it would ship whatever the machine
that ran the build happened to have there — including the webhook tokens the
loader writes back into an authored `action.json`.

Each action directory contains:
```
action.json   — ActionConfig (required)
context.ts    — AI: gather(), verify?(), afterRun?(); Code: run(); Command: not needed
```

### Core action state is per-Vault

A shipped core action's `action.json` is an **immutable default**. It lives in
the packaged resources directory, which is the installed application — on macOS
that is inside the signed `.app`, and everywhere else an upgrade replaces the
file. It is also install-wide, so two Vaults could not disagree about it.

Enabling, disabling, or re-timing a core action therefore writes to a per-Vault
overlay at `<current-home>/core-actions.json` instead:

```json
{ "actions": { "auto-title": { "enabled": true } } }
```

Only the fields a user can change from the UI live there (`enabled`, and `every`
for an interval trigger); everything else stays authored. An absent overlay means
the shipped default applies — and shipped core actions default to
`"enabled": false`, so an upgrade never starts running something new on its own.
An unreadable overlay is ignored rather than failing action loading.

## Trigger Types

| Type | Fires when | Key fields |
|------|-----------|------------|
| `interval` | Timer elapsed | `every` ("30s", "5m", "1h"), `from` ("completion"/"start"), `activeHours` |
| `webhook` | HTTP POST to `/api/actions/:name/hook?token=<token>` | `token` (auto-generated, passed as a **query param**), `sessionKey?` |
| `manual` | API call to `/api/actions/:name/trigger` | — |
| `action` | Another action completes | `source` (action name), `condition` ("any"/"done"/"error") |
| `session` | Session event fires | `on` (role + round + at, or "archived"/"deleted"), `excludeTags` — payload includes `assistantSeq` + `assistantMessageUuid` on assistant rounds |

A session trigger is filtered by the same user-profile `actions` allowlist that
decides what the Actions list shows. An action a profile excludes is neither
listed for that profile nor fired on its sessions.

## AI Execution Model

```
Trigger
  → gather(ctx) — build the prompt (access to DB, prior runs, trigger payload)
  → Answer through a session (default) or one-shot completion
  → Monitor the session when one was spawned
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

### Answerers

`ActionConfig.answerer` selects who answers the value returned by `gather()`:

- absent or `"session"` preserves the historic behavior: spawn and monitor an
  agent session;
- `"completion"` calls `ctx.model.complete()` and passes its text to `verify()`
  and `afterRun()` through the same `RunResult.response` field. No session is
  created.

Completion mode resolves its target from `agentProfile`; explicit action
`provider` and `model` fields override that profile. It goes through the
`modelCall` capability gate, never `sessionSpawn`. The run record carries
`answerer: "completion"` plus the one-shot id, provider, model, transport,
elapsed milliseconds, usage, and stop reason. The Actions run history shows
those details in place of a session link.

The PI transport itself uses a streaming model request, including
`stream: true` for OpenAI-compatible providers, then buffers those events into
the final result returned by `complete()`. Action authors receive the final
value rather than progressive text deltas; progressive caller/UI delivery is a
separate surface.

A completion answerer accepts only a string from `gather()`. Multipart
text/image content and session-only configuration are rejected with a named
error instead of being ignored. Session-only fields are `steps`, `maxTurns`,
`effort`, `tools`, `disallowedTools`, `providerControls`,
`loadProjectSettings`, `moves`, and `skills`. Existing actions are unchanged
when `answerer` is absent.

**Concurrency defaults differ by answerer.** `concurrency` defaults to `1` for a
session answerer, so a heavyweight action cannot spawn a second agent session on
top of one still running. A completion answerer spawns nothing — it is a single
in-process request — so it is **uncapped** unless the author sets `concurrency`
explicitly. Without that, a per-session reflex is silently lossy: two sessions
finishing a turn at the same moment, and only the first is served. Concurrent
runs each get their own execution, so nothing is shared between them.

### Settings references in `provider` and `model`

An action's `provider` and `model` may be written as `${settings.<key>}`, which
resolves against the owning plugin's settings (`ctx.pluginSettings`) **when the
action fires**. Load-time `${pluginDir}` expansion is not enough here: settings
change through the settings API without an action reload, so a value resolved at
boot would go stale.

```json
{ "answerer": "completion", "provider": "${settings.titleProvider}", "model": "${settings.titleModel}" }
```

This is whole-string only and is not general templating — a provider or model is
the entire value, and matching the whole string means an unresolved reference is
visibly unresolved rather than a half-substituted model id that fails obscurely
at the provider. An unresolved reference falls back to the agent profile and
records a warning on the run.

Harness-origin actions resolve settings against `modus-core`, which is the tier
that ships them.

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

Session listing through an action's `ctx.db` is scoped to its project for
project-discovered actions. Plugin- and harness-discovered actions can list
across projects in the current Vault. Discovery determines this origin; a
directory found as both a configured project and an enabled plugin uses the
project origin. Setting `origin` in `action.json` does not override discovery.

Action discovery is snapshot-based. Creating/removing an action directory or
editing `action.json` does not update the in-memory scheduler until harness
startup or `POST /api/actions/reload`. Reload scans built-in, project, and
enabled-plugin roots; it adds new actions, refreshes config for existing ones,
and removes missing actions only when they have no active execution. An active
execution keeps running, but its state receives the refreshed config.

`context.ts` has a different lifetime: each run checks whether `context.ts` or a
file it loaded from the action directory changed (mtime + size), and re-imports
only then. Edits are read when the next run starts and do not require the
discovery reload; an unchanged module is reused, because Bun never frees an
evaluated module and importing one per run leaks memory on every tick. A failed
import is not retried until a tracked file changes. Failed imports also watch
local source files and directory additions, so creating a missing dependency or
fixing a dependency's syntax error recovers on the next run. Helpers imported from outside
the action directory are never re-evaluated. As with moves, an installed desktop's
built-ins come from its staged resource snapshot; editing another source
checkout requires rebuilding/reinstalling that snapshot.
