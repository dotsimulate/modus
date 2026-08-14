---
title: Session Lifecycle & Reclamation
lastUpdated: 2026-08-12
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

## The reaper

`startSessionReaper()` sweeps every 60 seconds.

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

All values are environment variables read at startup.

| Variable | Default | Effect |
|---|---|---|
| `MG_MAX_HEAP_MB` | `4096` | Memory ceiling for one agent runtime. Also the reaper's `cliRssLimitBytes`. |
| `MG_MAX_CONCURRENT` | `6` | Concurrent sessions allowed to spawn. |
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

These are read from `process.env` when the module loads, so they must be present
in the backend's environment before it starts. There is no in-app setting and no
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
