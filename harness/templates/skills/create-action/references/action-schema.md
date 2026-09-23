# Action Schema

Actions live at `<cwd>/.modus/actions/<name>/action.json`. The directory name is the action's ID.

## Command and Code configuration

Both paths default to `trigger: { type: "manual" }`, `enabled: true`,
`concurrency: 1`, and `timeoutMs: 300000`. Project actions default `cwd` to the
project root and execute on the connected backend machine.

### Command with typed inputs

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

Provide the project's `scripts/export.ts` before using this example. Each input
reference becomes one literal argument, never interpolated shell text.
`execution.shell: true` uses `executable` as a platform-shell script and cannot
be combined with arguments. Prefer executable plus argv for portability.
Command does not load `context.ts` and returns process output; use Code for
custom results and artifacts.

### Code with a managed process and artifact

`action.json`:

```json
{
  "name": "runtime-report",
  "execution": { "type": "code" },
  "artifacts": [{ "name": "report", "mime": "application/json" }]
}
```

`context.ts` (uses `CodeActionContext`, not the AI `ActionContext`):

```ts
import { writeFile } from "node:fs/promises";

export async function run(ctx) {
  const result = await ctx.process.run({ executable: "bun", args: ["--version"] });
  const path = ctx.artifacts.path("report.json");
  await writeFile(path, JSON.stringify({ version: result.stdout.trim() }));
  return {
    summary: "Recorded Bun version",
    data: { exitCode: result.exitCode },
    artifacts: [{ name: "report", path, mime: "application/json" }]
  };
}
```

The worker context supplies only:

- `runId`, `actionName`, `inputs`, `trigger`, `cwd`, `signal` (AbortSignal).
- `log(message)`.
- `process.run({ executable, args?, cwd?, check? })`: returns `exitCode`,
  `signal`, `stdout`, `stderr`, `truncated`. Nonzero exit throws by default;
  `check: false` permits explicit inspection. Use this for managed subprocesses.
- `artifacts.path(filename)`: a basename-only managed output path.
- `secrets.resolve(reference)`: asynchronously resolves a named secret.
- `actions.trigger(name, inputs?)`: explicit handoff to a manual/interval action;
  the recipient must declare invocation fields in its `inputSchema`.
- `sessions.create({ profile, prompt })`: explicit agent-session handoff.

Await every context request. Action handoff means accepted, not completed; inspect
the recipient's run separately. Code has no harness DB handles, AI artifact
helpers, `gather`, `verify`, or `afterRun`. Use ordinary file APIs as needed and
avoid importing harness runtime modules. Exact types are in the Modus docs
`generated/authoring-contracts` under `CodeActionContext`.

`run` returns void or `{ summary?, data?, artifacts?: [{ name, path, mime }] }`.
Returned files must exist and be nonempty; required config artifact declarations
must match returned names and MIME types. Relative returned paths resolve from
`cwd`. Results must be JSON-serializable; worker messages/results have a 256 KiB
limit.

### Shared input and execution rules

- `inputSchema` supports an object with scalar `string`, `number`, `integer`,
  or `boolean` properties. Field options: `title`, `description`, `default`,
  `enum`, `minLength`, `maxLength`, `minimum`, `maximum`. Root options:
  `type`, `properties`, `required`, `additionalProperties: false`.
- Unknown input keys and unsupported schema keywords are rejected. No coercion;
  invocation JSON is limited to 16 KiB. Static config `inputs` are separate;
  validated invocation values merge over them in Code/AI contexts. Command argv
  references use validated invocation values, so provide defaults or required fields.
- Manual HTTP invocation: `POST /api/actions/<name>/trigger` with `{ "inputs": {...} }`.
  SDK: `triggerAction(name, scope, inputs)`. Harness Context:
  `ctx.actions.trigger(name, inputs)`. These acknowledge dispatch, not completion.
- Command/Code webhooks take the entire JSON body as invocation inputs. Session
  and chain event payloads reach Code via `ctx.trigger.payload`; schemas for
  automatic triggers must be satisfiable using defaults.
- Command/Code reject `answerer`, `agentProfile`, `steps`, `provider`, `model`,
  `maxTurns`, `effort`, `tools`, `disallowedTools`, `providerControls`,
  `loadProjectSettings`, `moves`, `skills`, `maxRetries`, `maxTransientRetries`,
  `onGatherError`, `onTransientFailure`, `retryBackoff`, and webhook `sessionKey`.
- Optional `env` values are named secret references, for example
  `"env": { "API_KEY": { "secret": "service-key" } }`. Resolve at execution time;
  do not put secrets in inputs or command text. Retained-log redaction is best effort.
- `concurrency` and `timeoutMs` must be positive integers. Four Command/Code runs
  may run globally; Code permits four managed processes and eight pending context
  requests. There is no waiting queue or automatic retry.
- Cancellation/timeout tears down owned process trees and holds capacity through
  cleanup. Restart records unfinished work as `interrupted` without replay.
  Reset is rejected while an operation remains active.
- Run history has `operation.outcome`: `running`, `succeeded`, `failed`,
  `could-not-start`, `timed-out`, `cancelled`, `interrupted`, `skipped`.
  Legacy statuses remain `done`/`error`/`skipped` for chains and notifications.
  Stdout and stderr retain separate 32 KiB tails; stderr alone does not mean failure.
- Existing trusted-local capability rules apply: execution uses `shell`, action
  handoff uses `actionTrigger`, session handoff uses `sessionSpawn`. A reviewed
  action with a capability explicitly false is denied; omission is allowed.
  Worker isolation provides crash containment, not a security sandbox.

## AI configuration

Omit `execution`. Set `agentProfile` to a resolvable project, Vault, or plugin
profile. `answerer` defaults to `session`. To use a tool-less completion, set
`answerer: "completion"` and return a string from `gather()`. Completion rejects
`steps`, `maxTurns`, `effort`, `tools`, `disallowedTools`, `providerControls`,
`loadProjectSettings`, `moves`, and `skills`; it uses `modelCall` permission and
creates no session. Explicit `provider`/`model` override the chosen profile.

The following configuration illustrates the **AI Session path**. Retry, session
options, and AI artifact helpers below do not apply to Command/Code.

```jsonc
{
  // ── Identity (required) ──
  "name": "health-monitor",           // Must match directory name
  "description": "Check service health every 5 minutes",
  "enabled": false,                    // Park automatic triggers; default is true

  // ── What to Run (required) ──
  "agentProfile": "ops-agent",        // Resolvable project, Vault, or plugin profile

  // ── Multi-step sequence (optional) ──
  // Switches agent profiles mid-session. Each step runs in the same session.
  "steps": [
    { "profile": "reviewer", "contextMode": "full" },
    { "profile": "editor", "prompt": "Apply the review feedback." }
  ],
  // contextMode: "full" (default) | "summary" | "lastResponse"

  // ── Trigger (optional; defaults to manual) ──
  // Choose one of the five trigger types:

  // Interval trigger:
  "trigger": {
    "type": "interval",
    "every": "5m",                     // "30s", "5m", "1h", "4h", "1d"
    "from": "completion",              // "completion" (default) or "start"
    "activeHours": {                   // optional time window
      "start": "09:00",               // 24h format, local time
      "end": "22:00"                   // wraps midnight: 22:00-06:00 = 10pm to 6am
    }
  },

  // Webhook trigger:
  // "trigger": { "type": "webhook" }
  // Token is auto-generated on first load. URL: POST /api/actions/<name>/hook?token=<token>

  // Manual trigger:
  // "trigger": { "type": "manual" }

  // Action chain trigger:
  // "trigger": { "type": "action", "source": "other-action-name", "condition": "done" }
  // condition: "done" | "error" | "any"

  // Session event trigger:
  // "trigger": { "type": "session", "on": { "role": "assistant", "round": 1, "at": "end" } }
  // on also accepts "archived" or "deleted"; excludeTags defaults to ["internal"].

  // ── Run Layer ──
  "maxRuns": 3,                        // per-cycle limit (or lifetime cap without cycleInterval)
  "maxTurns": 5,                       // override agent profile's maxTurns
  "maxRetries": 2,                     // verify retries per run (default 0)

  // ── Resilience ──
  "onGatherError": "fail",            // "fail" (default) or "retry" (feeds error into retry loop)
  "maxTransientRetries": 2,            // network error retries (default 2)
  "retryBackoff": "2m",               // delay between transient retries (default "2m")
  "onTransientFailure": "retry",       // "retry" (default) or "skip"

  // ── Cycle Layer ──
  "cycleInterval": "1h",              // outer rhythm — resets run counter each cycle
  "maxCycles": 24,                     // total cycle cap — auto-disables after N cycles

  // ── Execution Layer ──
  "concurrency": 1,                    // max simultaneous executions (default 1)
  "onExhausted": "archive",           // "archive" (default), "idle", or "restart"

  // ── Artifacts ──
  "artifacts": [
    { "name": "cartoon", "mime": "image/svg+xml" },
    { "name": "metadata", "mime": "application/json", "required": false }
  ],
  // name: logical name, used with ctx.artifact("cartoon") → .../cartoon.svg
  // mime: determines file extension (image/svg+xml → .svg, application/json → .json, etc.)
  // required: default true — auto-verify fails if missing or empty

  // ── Notifications ──
  "notify": [
    { "on": "error", "channel": "webhook-alerts" },
    { "on": ["done", "exhausted"], "channel": "file-log",
      "message": "{action} run #{run}: {status} ({cost})" }
  ],
  // on: "done" | "error" | "error-transient" | "failed-verification" | "exhausted"
  // channel: references notificationChannels in _global.json
  // message: template with {action}, {run}, {status}, {error}, {cost}, {duration}, {profile}

  // ── Moves (activate on the spawned session) ──
  "moves": [
    { "name": "check-in" },                    // move name (harness/moves/ or .modus/moves/)
    { "name": "catalog", "inputs": { "scope": "recent" } }  // with static inputs
  ],
  // Each move's gather() runs and output is prepended to the action prompt.
  // API contract moves get their token registered on the spawned session.
  // Persistent moves are skipped (activate via ambient registry after spawn).

  // ── User Profile Scoping ──
  "userProfile": "ops-user",

  // ── Session Overrides (optional — agent profile provides defaults) ──
  "provider": "claude-code",
  "model": "claude-opus-4-8[1m]",
  "effort": "medium",
  "cwd": "/srv/monitoring",
  "tools": ["Read", "Bash", "Grep", "Glob"],
  "disallowedTools": ["Write"],
  "loadProjectSettings": false
}
```

## Trigger Examples

### Interval: every 30s, 3 runs total

```json
{ "trigger": { "type": "interval", "every": "30s" }, "maxRuns": 3 }
```

### Interval: hourly during business hours

```json
{
  "trigger": {
    "type": "interval", "every": "1h",
    "activeHours": { "start": "09:00", "end": "17:00" }
  }
}
```

### Interval: 3 runs per hour, 8 cycles

```json
{
  "trigger": { "type": "interval", "every": "10m" },
  "maxRuns": 3, "cycleInterval": "1h", "maxCycles": 8
}
```

### Webhook: external trigger

```json
{ "trigger": { "type": "webhook" } }
```

### Chain: fire after another action succeeds

```json
{ "trigger": { "type": "action", "source": "data-collector", "condition": "done" } }
```

### Chain: fire on any completion (success or error)

```json
{ "trigger": { "type": "action", "source": "health-check", "condition": "any" } }
```

## AI Verify + Retry Examples

### File-producing action with auto-verify (no verify() needed)

```json
{
  "name": "generate-cartoon",
  "agentProfile": "artist",
  "trigger": { "type": "interval", "every": "1h" },
  "artifacts": [{ "name": "cartoon", "mime": "image/svg+xml" }],
  "maxRetries": 2,
  "maxRuns": 10
}
```

### Action with custom verify + transient resilience

```json
{
  "name": "api-report",
  "agentProfile": "analyst",
  "trigger": { "type": "interval", "every": "4h" },
  "maxRetries": 1,
  "maxTransientRetries": 3,
  "retryBackoff": "5m",
  "notify": [{ "on": "error", "channel": "webhook-alerts" }]
}
```

## AI Override Precedence

```
Action config  >  Agent Profile  >  User Profile  >  Default
```

**Overridable:** `provider`, `model`, `effort`, `maxTurns`, `cwd`, `tools`,
`disallowedTools`, `loadProjectSettings`

**Not overridable:** `prompt` (from agent profile), `mcpServers`, `permissionPolicy`

## AI Concurrency

Controlled by `concurrency` config (default 1). When at the limit, new triggers
are dropped and logged. Multiple executions run independently with separate
run/cycle counters.

## Chain Depth Limit

Action chains have a max depth of 8 to prevent infinite loops. If A triggers B triggers C...
up to 8 levels, the 9th is refused.

## Session Timeout

Each AI session run has a 30-minute maximum. If the agent hasn't finished, the run is marked
as error with a timeout message.

## API Endpoints

- `GET /api/actions` — list all actions with runtime state
- `GET /api/actions/<name>` — single action detail
- `POST /api/actions/<name>/trigger` — manual trigger with optional `{ "inputs": {...} }` (bypasses interval + active hours)
- `POST /api/actions/<name>/hook?token=<token>` — webhook trigger
- `GET /api/actions/<name>/runs?limit=20` — run history
- `GET /api/actions/<name>/executions` — list executions
- `GET /api/actions/<name>/executions/<id>/runs` — runs for specific execution
- `POST /api/actions/<name>/executions` — start new execution
- `DELETE /api/actions/<name>/executions/<id>` — cancel execution
- `PATCH /api/actions/<name>` — update config (enabled, interval)
- `POST /api/actions/<name>/reset` — archive old executions and reset counters; preserves history, rejected while an operation is busy
- `POST /api/actions/reload` — reload from disk

## Naming Conventions

- Use kebab-case: `health-monitor`, `daily-report`, `deploy-review`
- Name describes what the action does, not when
- Directory name must match `name` field in action.json
