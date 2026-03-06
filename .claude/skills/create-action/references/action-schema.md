# Action Schema

Actions live at `actions/<name>/action.json`. The directory name is the action's ID.

## Complete Schema

```jsonc
{
  // ── Identity (required) ──
  "name": "health-monitor",           // Must match directory name
  "description": "Check service health every 5 minutes",
  "enabled": false,                    // Always start disabled

  // ── What to Run (required) ──
  "agentProfile": "ops-agent",        // References profiles/agents/<name>.json

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

  // ── Cycle Layer ──
  "cycleInterval": "1h",              // outer rhythm — resets run counter each cycle
  "maxCycles": 24,                     // total cycle cap — auto-disables after N cycles

  // ── User Profile Scoping ──
  "userProfile": "ops-user",

  // ── Session Overrides (optional — agent profile provides defaults) ──
  "provider": "claude-code",
  "model": "claude-sonnet-4-6",
  "effort": "medium",
  "cwd": "/srv/monitoring",
  "tools": ["Read", "Bash", "Grep"],
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

## Override Precedence

```
Action config  >  Agent Profile  >  User Profile  >  Default
```

**Overridable:** `provider`, `model`, `effort`, `maxTurns`, `cwd`, `tools`,
`disallowedTools`, `loadProjectSettings`

**Not overridable:** `prompt` (from agent profile), `mcpServers`, `permissionPolicy`

## Concurrency

If a trigger fires while the action is already running, the trigger is **dropped and logged**.
No queuing, no overlapping runs.

## Chain Depth Limit

Action chains have a max depth of 8 to prevent infinite loops. If A triggers B triggers C...
up to 8 levels, the 9th is refused.

## Session Timeout

Each action run has a 30-minute maximum. If the agent hasn't finished, the run is marked
as error with a timeout message.

## API Endpoints

- `GET /api/actions` — list all actions with runtime state
- `POST /api/actions/<name>/trigger` — manual trigger (bypasses interval + active hours)
- `POST /api/actions/<name>/hook?token=<token>` — webhook trigger
- `GET /api/actions/<name>/runs?limit=20` — run history
- `PATCH /api/actions/<name>` — update config (enabled, interval)
- `POST /api/actions/<name>/reset` — clear history, reset counters
- `POST /api/actions/reload` — reload from disk

## Naming Conventions

- Use kebab-case: `health-monitor`, `daily-report`, `deploy-review`
- Name describes what the action does, not when
- Directory name must match `name` field in action.json
