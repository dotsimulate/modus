---
name: create-action
description: >
  Create automated agent actions in MO (modus operandi). Use when someone wants to:
  (1) run an agent on a timer or interval (monitoring, reports, maintenance),
  (2) trigger an agent from a webhook (GitHub, home automation, external services),
  (3) chain agents so one fires after another completes,
  (4) set up recurring automated tasks with dynamic context gathering,
  (5) build automation that acts on agent responses (notifications, API calls, hardware),
  (6) configure cycle-based execution (batches of runs with limits),
  (7) create any automated agent workflow. Each action is a directory containing an
  action.json config and a context.ts module for dynamic prompts and post-run actions.
  TRIGGER on: "create an action", "automate", "run every", "scheduled task",
  "recurring agent", "cron", "monitor", "heartbeat", "periodic", "webhook trigger",
  "chain actions", "run after", "on completion".
---

# Create Action

Actions are the automation primitive in MO: **trigger -> gather() -> session -> afterRun()**.

Each action is a directory:

```
actions/<name>/
  action.json    <- trigger, agent profile ref, execution config
  context.ts     <- dynamic prompt builder + optional post-run hook
```

## Workflow

1. Determine what to automate and which trigger type fits
2. Identify or create the agent profile (see `create-profile` skill)
3. Design the trigger config and execution limits
4. Write `action.json`
5. Write `context.ts` (dynamic context + optional afterRun hook)
6. Output both files with paths

## Four Trigger Types

| Type | When it fires | Key config |
|------|--------------|------------|
| `interval` | Every N seconds/minutes/hours | `every`, `from`, `activeHours` |
| `webhook` | HTTP POST to `/api/actions/<name>/hook?token=...` | `token` (auto-generated) |
| `manual` | UI button or API call | (none) |
| `action` | After another action completes | `source`, `condition` |

## Quick Examples

### Interval: heartbeat every 30s, 3 runs then stop

```json
{
  "name": "heartbeat",
  "description": "Quick system status check",
  "agentProfile": "ops-agent",
  "trigger": { "type": "interval", "every": "30s" },
  "maxTurns": 3, "maxRuns": 3, "enabled": false
}
```

### Webhook: triggered by GitHub push

```json
{
  "name": "deploy-review",
  "description": "Review deployment on push",
  "agentProfile": "code-reviewer",
  "trigger": { "type": "webhook" },
  "maxTurns": 10, "enabled": true
}
```

### Chain: run after another action completes successfully

```json
{
  "name": "post-deploy-test",
  "description": "Run tests after deploy-review succeeds",
  "agentProfile": "test-runner",
  "trigger": { "type": "action", "source": "deploy-review", "condition": "done" },
  "maxTurns": 15, "enabled": true
}
```

### Manual: on-demand analysis

```json
{
  "name": "deep-analysis",
  "description": "Comprehensive codebase analysis",
  "agentProfile": "research",
  "trigger": { "type": "manual" },
  "maxTurns": 20, "enabled": true
}
```

For the complete schema: [references/action-schema.md](references/action-schema.md).

For context.ts patterns (dynamic prompts, DB queries, afterRun hooks, webhook payloads):
[references/context-patterns.md](references/context-patterns.md).

## Two-Layer Execution Model

Actions use **runs** and **cycles**:

```
Action
  Cycle #1
    Run #1  (trigger apart)
    Run #2
    Run #3  (maxRuns reached, cycle complete)
  [wait for cycleInterval]
  Cycle #2
    ...
```

Without `cycleInterval`, `maxRuns` is a lifetime cap.

## Key Rules

- Every action MUST reference an `agentProfile` in `profiles/agents/`
- Actions start `enabled: false` — user enables them deliberately
- Interval format: `"30s"`, `"5m"`, `"1h"`, `"4h"`, `"1d"`
- Concurrency: if a trigger fires while the action is already running, it's dropped and logged
- Chain depth limit: max 8 levels of action->action chaining to prevent loops
- `afterRun()` failures are isolated — they don't change the run's status
- `gather()` returns the user message; the agent profile's system prompt is still loaded
- Action can override: `model`, `effort`, `maxTurns`, `tools`, `cwd`, `provider`,
  `disallowedTools`, `loadProjectSettings`
- Action CANNOT override: prompt, MCP servers, permission policies

## Creating the Full Stack

1. **Agent profile** — the agent's identity (`create-profile` skill)
2. **Action config** — trigger and execution config
3. **Context module** — what to ask and what to do with the answer

Output paths:
- `profiles/agents/<agent-name>.json`
- `actions/<action-name>/action.json`
- `actions/<action-name>/context.ts`
