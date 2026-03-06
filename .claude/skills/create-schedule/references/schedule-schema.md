# Schedule Schema

Schedules live at `schedules/<name>/schedule.json`. The directory name is the
schedule's ID.

## Complete Schema

```jsonc
{
  // ── Identity (required) ──

  "name": "health-monitor",           // Must match directory name
  "description": "Check service health every 5 minutes",
  "enabled": false,                    // Always start disabled

  // ── What to Run (required) ──

  // References an agent profile in profiles/agents/<name>.json
  "agentProfile": "ops-agent",

  // ── Timing (required: interval) ──

  // How often to run. Format: "<number><unit>"
  // Units: "s" (seconds), "m" (minutes), "h" (hours), "d" (days)
  "interval": "5m",

  // When to measure the interval from (default: "completion")
  // "completion" = next run starts N after this run ENDS (rest time = interval)
  // "start" = next run starts N after this run STARTS (fixed cadence)
  "intervalFrom": "completion",

  // Restrict runs to a time window (24h format, local time)
  "activeHours": {
    "start": "09:00",
    "end": "22:00"
    // Wraps midnight: {"start": "22:00", "end": "06:00"} = 10 PM to 6 AM
  },

  // ── Run Layer ──

  // Max runs per cycle (or lifetime cap if no cycleInterval)
  // When reached without cycleInterval: schedule auto-disables
  // When reached with cycleInterval: waits for next cycle
  "maxRuns": 3,

  // Override agent profile's maxTurns for scheduled runs
  "maxTurns": 5,

  // ── Cycle Layer ──

  // Time between cycle boundaries. Resets run counter each cycle.
  // Omit for flat execution (no cycles).
  "cycleInterval": "1h",

  // Total cycle cap. Schedule auto-disables after N cycles complete.
  "maxCycles": 24,

  // ── User Profile Scoping ──

  // User profile for session context (memory scoping, template vars)
  "userProfile": "ops-user",

  // ── Session Overrides (optional — agent profile provides defaults) ──

  "provider": "claude-code",           // Override agent's provider
  "model": "claude-sonnet-4-6",       // Override agent's model
  "effort": "medium",                  // Override agent's effort
  "cwd": "/srv/monitoring",            // Override working directory
  "tools": ["Read", "Bash", "Grep"],   // Override tool allowlist
  "disallowedTools": ["Write"],         // Override tool blocklist
  "loadProjectSettings": false          // Override CLAUDE.md loading
}
```

## Timing Examples

### Every 30 seconds, 3 runs total, then stop

```json
{
  "interval": "30s",
  "maxRuns": 3
}
```

### Every hour during business hours

```json
{
  "interval": "1h",
  "activeHours": { "start": "09:00", "end": "17:00" }
}
```

### 3 runs per hour, 8 hours of cycles

```json
{
  "interval": "10m",
  "maxRuns": 3,
  "cycleInterval": "1h",
  "maxCycles": 8
}
```

### Once daily at night

```json
{
  "interval": "1d",
  "activeHours": { "start": "02:00", "end": "04:00" }
}
```

### Fixed cadence (ignore run duration)

```json
{
  "interval": "15m",
  "intervalFrom": "start"
}
```

## Override Precedence

Schedule fields override agent profile fields for that run:

```
Schedule config  >  Agent Profile  >  User Profile  >  Default
```

**Overridable:** `provider`, `model`, `effort`, `maxTurns`, `cwd`, `tools`,
`disallowedTools`, `loadProjectSettings`

**Not overridable from schedule:** `prompt` (always from agent profile),
`mcpServers`, `permissionPolicy`, `promptMode`, `claudeMdExcludes`

## Session Timeout

Each scheduled session has a 30-minute maximum lifetime. If the agent hasn't
finished by then, the run is marked as error with a timeout message.

## Scheduler Behavior

- Tick interval: 10 seconds (scheduler checks all schedules every 10s)
- When `enabled: true` and conditions met: spawn session, track in `schedule_runs` DB
- Manual trigger: `POST /api/schedules/<name>/trigger` (bypasses interval + active hours)
- Reset: `POST /api/schedules/<name>/reset` (clears history, resets counters)

## Naming Conventions

- Use kebab-case: `health-monitor`, `daily-report`, `log-rotate`
- Name should describe what the schedule does, not when
- Directory name must match the `name` field in schedule.json
