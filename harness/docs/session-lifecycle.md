---
title: Session Lifecycle & Reclamation
lastUpdated: 2026-09-09
covers: harness/session-manager.ts harness/session-reap-policy.ts harness/process-memory.ts harness/memory-guard.ts harness/process-registry.ts harness/provider-process-identity.ts
---

# Session Lifecycle & Reclamation

A Modus session has two halves with different lifetimes. Its **history** is
database rows and lives until the user deletes it. Its **process** is a provider
CLI the harness spawned, and the harness reclaims that process when keeping it
alive is not worth what it costs. Reclamation never deletes history.

This document covers the second half: when a live session's process ends without
anyone asking it to, and how to configure that.

## Statuses

`SessionStatus` in `session-manager.ts`:

| Status | Meaning |
|---|---|
| `starting` | The provider is spawning. No turn has begun. |
| `running` | A turn is in flight. |
| `interrupting` | A stop was requested; provider teardown is in progress. |
| `idle` | The provider is alive and waiting for the next message. |
| `paused` | Held at a tool boundary by an explicit pause. |
| `done` / `error` | Terminal. |

Only sessions in `activeSessions` have a process. A session that has been
reclaimed still appears in the session list and still opens; sending it a
message starts a **new** provider process and resumes the conversation.

## Unread replies

Unread replies are independent of runtime status. The sidebar shows a dot and
bold title when a session has a completed assistant reply that has not been
viewed. Intermediate assistant/tool rounds, interrupted output, title changes,
project switches, and process reclamation do not create or clear this marker.

The transcript acknowledges the latest completed reply when its end is visible
in the focused browser or desktop window. Opening a conversation while scrolled
above the reply does not acknowledge it. Read state persists across refreshes
and synchronizes between clients of the same Vault. Existing history starts
unmarked when this feature is first installed.

The session row and session index expose `last_reply_seq` and `read_reply_seq`.
Completion advances the first watermark for nonempty assistant text on a
`result/success` or `result/error_max_turns` event. `POST /api/sessions/:id/read`
with `{ "seq": <viewed reply sequence> }` advances the read watermark, bounded
by the latest completion. Older receipts cannot acknowledge a newer reply.
The SDK exposes `markSessionReplyRead(id, seq)`. Both completion and reading
broadcast `session:read-state` with `lastReplySeq` and `readReplySeq`.

## The reaper

`startSessionReaper()` sweeps every 60 seconds.

Process-table commands run asynchronously with an eight-second timeout per
command. Concurrent requests share one sample, cached for 15 seconds after
completion. The sweep checks current session state after sampling completes;
a session resumed during that wait is not treated as still idle. On Windows,
`tasklist` is the fallback when `wmic` is unavailable; it reports root-process
memory only because it provides no parent-process IDs.

| Status | Reclaimed when |
|---|---|
| `done` / `error` | Settled for 1 minute with no SSE subscribers. |
| `starting` | Stuck for 3 minutes — the provider never finished spawning. |
| `interrupting` | Stuck for 5 minutes — teardown did not finish. |
| `running` / `paused` | Never. |
| `idle` | Decided by the policy below. |

### Idle sessions are decided by cost, not by elapsed time

Reclaiming an idle session kills the provider CLI **and every process beneath
it**, which includes background work the agent left running: a background shell,
a build, a watcher, a long-running task. Time since the last event does not
predict whether that is worth doing, so `session-reap-policy.ts` decides from
what the session actually holds. In order:

1. **The provider CLI's own footprint** exceeds `cliRssLimitBytes`. A runaway
   agent runtime shows up here and nowhere else.
2. **The system is under memory pressure** and the session's whole tree exceeds
   `pressureRssFloorBytes`, once it has been idle for `pressureGraceMs`. Largest
   trees are reclaimed first.
3. **The backstop**: idle longer than `idleBackstopMs`, whatever it costs.

The distinction in rule 1 is deliberate. `process-memory.ts` reports two numbers
for a session's process tree — `totalBytes` for everything below the registered
root pids, and `matchedBytes` for only those processes whose image is the
provider's own CLI (`providers/provider-cli-names.ts`). A session running a 6 GB
build is not a leaking session, and only rule 2 may touch it.

When the process table cannot be read, or a provider registered no OS pids, the
footprint is reported as **unknown** rather than zero. Rules 1 and 2 cannot fire
on an unknown footprint outside real pressure, so such a session survives to the
backstop.

### Reclamation is visible

A reclaimed session persists a `system` / `reclaimed` event and a system message
naming the reason, broadcasts a status change, and closes its SSE subscribers.
An open transcript therefore shows why the session ended rather than silently
never emitting again.

## Configuration

Environment variables set the startup values. The concurrency limit can also be
changed while the backend is running, as described below.

| Variable | Default | Effect |
|---|---|---|
| `MG_MAX_HEAP_MB` | `4096` | Memory ceiling for one agent runtime. Also the reaper's `cliRssLimitBytes`. |
| `MG_MAX_CONCURRENT` | `10` | Initial concurrent-session limit; invalid, nonpositive, or noninteger values fall back to 10. |
| `MG_PRESSURE_THRESHOLD` | `0.90` | System memory ratio that blocks new spawns and enables pressure reclamation. |
| `MG_BLOCK_ON_PRESSURE` | `1` (`0` on macOS) | Whether pressure gates spawning and reclamation. |
| `MG_REAP_PRESSURE_FLOOR_MB` | `512` | Smallest tree worth reclaiming under pressure. |
| `MG_REAP_PRESSURE_GRACE_MS` | `120000` | Idle time before pressure may reclaim a session. |
| `MG_REAP_IDLE_BACKSTOP_MS` | `28800000` | Absolute idle limit (8 hours). |
| `MG_WATCHDOG_INTERVAL_MS` | `30000` | Memory watchdog reporting interval. |

To keep a long background task alive indefinitely, raise
`MG_REAP_IDLE_BACKSTOP_MS`. To make reclamation more aggressive on a small
machine, lower `MG_MAX_HEAP_MB` and `MG_REAP_PRESSURE_FLOOR_MB`.

### Where to set them

These are read from `process.env` when the module loads, so startup overrides must be present
in the backend's environment before it starts. The concurrency limit additionally has
an in-app control; the other values have no in-app setting. There is no
config file for them, and the Modus secrets file does not work — `loadSecrets()`
parses it into its own store and never writes to `process.env`.

- **`modus start`** — set them on the command, e.g.
  `MG_REAP_IDLE_BACKSTOP_MS=0 modus start`.
- **Packaged desktop app** — the Tauri shell adds its own variables and does not
  clear the rest, so the backend inherits the environment the app was launched
  with. Set an OS-level user environment variable and start the app fresh. On
  Windows a newly added variable does not reach an already-running Explorer, so
  a launch from the Start menu may need a sign-out first; launching the app from
  a terminal that already has the variable avoids that.

### Changing session capacity without interrupting agents

Open **Settings → Environment → Backend session capacity** and apply a positive
integer. This changes admission for new sessions immediately across the connected
backend. It never stops, restarts, or reclaims existing sessions. Lowering the
limit below the current active count only blocks further starts until enough
sessions finish. Memory-pressure checks remain in effect. Pilot/orchestrator
limits are separate and may still cap the number of workers.

The authenticated API is `PUT /api/system/memory` with exactly
`{ "maxConcurrentSessions": 10 }`. It returns the same memory status as
`GET /api/system/memory`; invalid payloads return 400 without changing the limit.
SDK callers use `getMemoryStatus()` and `setMaxConcurrentSessions(10)`.
Changes last until backend restart; startup then uses `MG_MAX_CONCURRENT` or 10.
The response advertises `concurrencyLimitMutable: true`. Older running backends
without that field cannot apply a live update; installing this code does not
change their already-loaded startup constant.

## How the memory ceiling is enforced

`MG_MAX_HEAP_MB` is applied twice because neither mechanism covers every
provider:

- `getMemoryLimitedEnv()` injects `--max-old-space-size` into `NODE_OPTIONS` on
  spawn. This binds a provider CLI that runs on Node.
- The reaper's rule 1 reclaims an idle session whose CLI has passed the same
  limit. This is the only enforcement a **natively compiled** CLI receives —
  `claude` 2.x ships as a compiled binary and ignores `NODE_OPTIONS` entirely.

Neither mechanism interrupts a running turn. A turn in flight is never
reclaimed; a session is only measured once it goes idle.

## Identifying harness-owned processes

The Processes surface lists stranded provider processes so they can be killed.
`provider-process-identity.ts` decides what qualifies, and it never matches on
executable name alone: `claude.exe` is also the Claude Desktop application, its
renderer subprocesses, and any CLI session the user started themselves. A
process is claimed only on positive evidence that Modus launched it — the legacy
Node-hosted `cli.js` path, an inline MCP configuration addressed to this
harness's port, or launch material written into a `modus-sensitive-` directory.

## Related

- `providers.md` — provider implementations and their teardown contracts.
- `architecture.md` — where session-manager sits in the harness.
