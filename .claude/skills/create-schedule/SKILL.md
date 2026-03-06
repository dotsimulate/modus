---
name: create-schedule
description: >
  Create automated agent schedules in MO (modus operandi). Use when someone wants to:
  (1) run an agent on a timer or interval (monitoring, reports, maintenance),
  (2) set up recurring automated tasks with dynamic context gathering,
  (3) build automation that acts on agent responses (notifications, API calls, hardware),
  (4) configure cycle-based execution (batches of runs with limits),
  (5) create any scheduled or cron-like agent automation. Each schedule is a directory
  containing a schedule.json config and an optional context.ts module for dynamic prompts
  and post-run actions. TRIGGER on: "create a schedule", "automate", "run every",
  "scheduled task", "recurring agent", "cron", "monitor", "heartbeat", "periodic".
---

# Create Schedule

MO schedules run agent sessions automatically on intervals. Each schedule is a directory:

```
schedules/<name>/
  schedule.json    <- timing, agent profile ref, execution config
  context.ts       <- dynamic prompt builder + optional post-run actions
```

## Workflow

1. Determine what the user wants to automate
2. Identify or create the agent profile it should use (see `create-profile` skill)
3. Design the timing: interval, active hours, run/cycle limits
4. Write the `schedule.json`
5. Write the `context.ts` (dynamic context + optional afterRun hook)
6. Output both files with paths

## Gathering Requirements

Ask the user:

1. **What should happen?** (monitoring, reports, backups, notifications, data collection)
2. **How often?** ("every 30 seconds", "hourly", "once a day")
3. **Any time restrictions?** (only during work hours, only at night)
4. **How many runs?** (unlimited, 3 per batch, stop after 10 total)
5. **Should it act on the result?** (send notification, call API, write file, trigger hardware)
6. **Which agent profile?** (existing one, or create a new one)

## Two-Layer Execution Model

Schedules use two composable layers: **runs** and **cycles**.

```
Schedule
  Cycle #1                    <- cycleInterval boundary
    Run #1  (interval apart)
    Run #2  (interval apart)
    Run #3  (maxRuns reached, cycle complete)
  [wait for cycleInterval]
  Cycle #2
    Run #4
    Run #5
    Run #6
  [repeat until maxCycles]
```

**Run** = one agent session execution.
**Cycle** = a batch of runs. Run counter resets each cycle.

Without `cycleInterval`, runs are a flat sequence and `maxRuns` is a lifetime cap.

## Quick Examples

### Simple heartbeat (run 3 times, stop)

```json
{
  "name": "heartbeat",
  "description": "Quick system status check",
  "agentProfile": "ops-agent",
  "interval": "30s",
  "maxTurns": 3,
  "maxRuns": 3,
  "enabled": false
}
```

### Hourly report during work hours

```json
{
  "name": "hourly-report",
  "description": "Generate project status report every hour",
  "agentProfile": "research",
  "interval": "1h",
  "activeHours": { "start": "09:00", "end": "18:00" },
  "maxTurns": 10,
  "enabled": false
}
```

### Batch monitoring with cycles

```json
{
  "name": "health-monitor",
  "description": "Check services 3 times per hour, repeat hourly",
  "agentProfile": "ops-agent",
  "interval": "5m",
  "maxRuns": 3,
  "cycleInterval": "1h",
  "maxCycles": 24,
  "enabled": false
}
```

For the complete schema and all fields, read
[references/schedule-schema.md](references/schedule-schema.md).

For context.ts patterns (dynamic prompts, DB queries, afterRun hooks), read
[references/context-patterns.md](references/context-patterns.md).

## Key Rules

- Every schedule MUST reference an `agentProfile` that exists in `profiles/agents/`
- Schedules start `enabled: false` — user enables them deliberately
- `interval` format: `"30s"`, `"5m"`, `"1h"`, `"4h"`, `"1d"`
- `intervalFrom: "completion"` (default) = next run starts after previous finishes
- `intervalFrom: "start"` = next run starts from when previous started
- Schedule can override agent profile fields: `model`, `effort`, `maxTurns`, `tools`,
  `cwd`, `provider`, `disallowedTools`, `loadProjectSettings`
- Schedule CANNOT override: prompt (that comes from the agent profile), MCP servers,
  permission policies
- The `context.ts` `gather()` function builds the actual prompt sent to the agent.
  The agent profile's system prompt is still loaded — `gather()` provides the user message.
- `afterRun()` is for side effects AFTER the agent completes: notifications, API calls,
  file writes, webhook triggers, hardware control

## Creating the Full Stack

When a user wants end-to-end automation, create three things:

1. **Agent profile** — the agent's identity (use `create-profile` skill)
2. **Schedule config** — when and how to run it
3. **Context module** — what to ask and what to do with the answer

Output all three files with clear paths:
- `profiles/agents/<agent-name>.json`
- `schedules/<schedule-name>/schedule.json`
- `schedules/<schedule-name>/context.ts`
