# Action Schema

Actions live at `<cwd>/.modus/actions/<name>/action.json`. The directory name is the action's ID.

## Complete Schema

```jsonc
{
  // ── Identity (required) ──
  "name": "health-monitor",           // Must match directory name
  "description": "Check service health every 5 minutes",
  "enabled": false,                    // Always start disabled

  // ── What to Run (required) ──
  "agentProfile": "ops-agent",        // References .modus/profiles/agents/<name>.json

  // ── Multi-step sequence (optional) ──
  // Switches agent profiles mid-session. Each step runs in the same session.
  "steps": [
    { "profile": "reviewer", "contextMode": "full" },
    { "profile": "editor", "prompt": "Apply the review feedback." }
  ],
  // contextMode: "full" (default) | "summary" | "lastResponse"

  // ── Trigger (required) ──
  // Exactly one of the four trigger types:

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

## Verify + Retry Examples

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

## Override Precedence

```
Action config  >  Agent Profile  >  User Profile  >  Default
```

**Overridable:** `provider`, `model`, `effort`, `maxTurns`, `cwd`, `tools`,
`disallowedTools`, `loadProjectSettings`

**Not overridable:** `prompt` (from agent profile), `mcpServers`, `permissionPolicy`

## Concurrency

Controlled by `concurrency` config (default 1). When at the limit, new triggers
are dropped and logged. Multiple executions run independently with separate
run/cycle counters.

## Chain Depth Limit

Action chains have a max depth of 8 to prevent infinite loops. If A triggers B triggers C...
up to 8 levels, the 9th is refused.

## Session Timeout

Each action run has a 30-minute maximum. If the agent hasn't finished, the run is marked
as error with a timeout message.

## API Endpoints

- `GET /api/actions` — list all actions with runtime state
- `GET /api/actions/<name>` — single action detail
- `POST /api/actions/<name>/trigger` — manual trigger (bypasses interval + active hours)
- `POST /api/actions/<name>/hook?token=<token>` — webhook trigger
- `GET /api/actions/<name>/runs?limit=20` — run history
- `GET /api/actions/<name>/executions` — list executions
- `GET /api/actions/<name>/executions/<id>/runs` — runs for specific execution
- `POST /api/actions/<name>/executions` — start new execution
- `DELETE /api/actions/<name>/executions/<id>` — cancel execution
- `PATCH /api/actions/<name>` — update config (enabled, interval)
- `POST /api/actions/<name>/reset` — clear history, reset counters
- `POST /api/actions/reload` — reload from disk

## Naming Conventions

- Use kebab-case: `health-monitor`, `daily-report`, `deploy-review`
- Name describes what the action does, not when
- Directory name must match `name` field in action.json
