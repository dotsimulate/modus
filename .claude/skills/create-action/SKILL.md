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

Actions are the automation primitive in MO:
**trigger -> gather() -> session -> verify() -> finalize -> notify -> chain**

Each action is a directory:

```
actions/<name>/
  action.json    <- trigger, agent profile ref, execution config
  context.ts     <- dynamic prompt builder + optional verify + optional afterRun hook
```

## Workflow

1. Determine what to automate and which trigger type fits
2. Identify or create the agent profile (see `create-profile` skill)
3. Design the trigger config and execution limits
4. Decide if verify/retry is needed (file-producing actions, quality checks)
5. Write `action.json` (including artifacts, notify, retry config if needed)
6. Write `context.ts` (gather + optional verify + optional afterRun)
7. Output both files with paths

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

### Heartbeat with moves: scheduled companion check-in

```json
{
  "name": "morning-checkin",
  "description": "Daily check-in conversation with structured context",
  "agentProfile": "companion-agent",
  "trigger": { "type": "interval", "every": "1d",
    "activeHours": { "start": "09:00", "end": "10:00" } },
  "moves": [
    { "name": "check-in" }
  ],
  "maxTurns": 20, "enabled": false
}
```

The `moves` array attaches moves to the action's spawned session. Each move's
`gather()` runs and its output is prepended to the action's prompt. This means:

- The **action** handles WHEN (schedule, triggers, retries)
- The **move** handles WHAT (structured context — reading memory, building prompts)
- They compose without either needing to know about the other's internals

This is particularly powerful for companion agents. Instead of duplicating memory-reading
logic in the action's context.ts, you reference a companion move that already knows how
to read memory, reference previous status, and guide a conversation. The action just
provides the schedule.

Moves with `api` blocks also work — the API token is automatically registered on the
spawned session, so the agent can call ops immediately.

```json
{
  "moves": [
    { "name": "check-in" },
    { "name": "catalog", "inputs": { "scope": "recent" } }
  ]
}
```

Multiple moves compose — each gather() output is prepended in order. Persistent moves
are skipped (they activate after session spawn through the normal ambient registry).

For the complete schema: [references/action-schema.md](references/action-schema.md).

For context.ts patterns (dynamic prompts, DB queries, afterRun hooks, webhook payloads):
[references/context-patterns.md](references/context-patterns.md).

## Execution Model

Actions use **executions**, **runs**, and **cycles**:

```
Action
  Execution #1
    Cycle #1
      Run #1  (with verify retry loop if maxRetries > 0)
      Run #2
      Run #3  (maxRuns reached, cycle complete)
    [wait for cycleInterval]
    Cycle #2
      ...
    [maxCycles reached → onExhausted]
```

Without `cycleInterval`, `maxRuns` is a lifetime cap. Each execution is a separate
lifecycle instance — actions can have concurrent executions via `concurrency` config.

## Verify / Retry Pipeline

When `maxRetries > 0`, each run enters a verify loop:

```
gather() → session → verify() → accept/retry
```

- `verify()` in context.ts inspects the result and returns `{ ok: true }` or
  `{ ok: false, reason: "...", retry?: true }`
- If retry is true and attempts remain, `gather()` is re-called with
  `ctx.lastVerifyError` set so it can adapt the prompt
- Same `runId` throughout — `session_id` updated to latest attempt
- If no `verify()` but `artifacts` are declared, auto-verify checks file
  existence and non-empty size for each required artifact
- `failed-verification` status when all retries exhausted

## Artifacts

Declare expected output files in `action.json`:

```json
"artifacts": [
  { "name": "cartoon", "mime": "image/svg+xml" },
  { "name": "report", "mime": "application/json", "required": false }
]
```

In `context.ts`, use `ctx.artifact("cartoon")` to get the expected file path
(extension derived from mime: `.svg`, `.json`, etc.). The agent should write
its output to this path. If no `verify()` exists, auto-verify checks that
each required artifact exists and is non-empty.

Lower-level: `ctx.artifactDir()` returns the run's output directory,
`ctx.artifactPath("filename.ext")` returns a path within it. Use `artifact()`
when you have declared specs; use `artifactPath()` for ad-hoc files.

## Notifications

Declarative alerts — no custom afterRun code needed:

```json
"notify": [
  { "on": "error", "channel": "webhook-alerts" },
  { "on": ["done", "exhausted"], "channel": "file-log", "message": "{action}: {status} (${cost})" }
]
```

Channels are defined in `_global.json` under `notificationChannels`:
- `"webhook"`: `{ "type": "webhook", "url": "https://...", "method": "POST", "headers": {} }`
- `"file"`: `{ "type": "file", "path": "/path/to/alerts.jsonl" }`

Template variables: `{action}`, `{run}`, `{status}`, `{error}`, `{cost}`, `{duration}`, `{profile}`

## Transient Resilience

Network errors are automatically retried (separate from verify retries):
- `maxTransientRetries`: how many times (default 2)
- `retryBackoff`: delay between retries (default "2m")
- `onTransientFailure`: `"retry"` (default) or `"skip"`
- Transient errors: ECONNREFUSED, ETIMEDOUT, 429, 502, 503, etc.
- Transient failures don't count against `maxRuns`

## Multi-Step Sequences

An action can switch agent profiles mid-session:

```json
"steps": [
  { "profile": "editor-agent", "contextMode": "full" },
  { "profile": "reviewer-agent", "prompt": "Review the above edit." }
]
```

Steps run in the same session. `gather()` provides the initial prompt for the
first profile (`agentProfile`), then each step either uses a static `prompt`
or calls `gather()` again with `ctx.stepIndex` set.

## Key Rules

- **context.ts is portable** — it can live in ANY project's `.modus/actions/` directory.
  The only import you need is the type import: `import type { ... } from "../../action-types"`.
  Everything else is on `ctx`: run history via `ctx.db.getRunSummaries()`, SVG rendering
  via `ctx.svgToPngBase64()`, logging via `ctx.log()`. Use `fs` for reading project files.
- **For project-local context** — read files from the project directory using `fs` and
  `ctx.actionDir`. For structured context gathering, use `moves` on the action to attach
  companion moves that read memory and build prompts.
- Every action MUST reference an `agentProfile` in `<cwd>/.modus/profiles/agents/`
- Actions start `enabled: false` — user enables them deliberately
- Interval format: `"30s"`, `"5m"`, `"1h"`, `"4h"`, `"1d"`
- Concurrency controlled by `concurrency` config (default 1)
- Chain depth limit: max 8 levels of action→action chaining
- `afterRun()` only runs on success (not on failed-verification or error)
- `afterRun()` failures are logged but don't change the run's status
- `gather()` returns the user message; the agent profile's system prompt is still loaded
- `verify()` takes precedence over auto-verify from artifact specs
- Action can override: `model`, `effort`, `maxTurns`, `tools`, `cwd`, `provider`,
  `disallowedTools`, `loadProjectSettings`
- Action CANNOT override: prompt, MCP servers, permission policies
- Cost awareness: retry Haiku freely (cheap), cap Opus retries at 1-2

## Creating the Full Stack

1. **Agent profile** — the agent's identity (`create-profile` skill)
2. **Action config** — trigger, execution, verify, artifacts, notifications
3. **Context module** — what to ask, how to verify, what to do with the answer

Output paths:
- `<cwd>/.modus/profiles/agents/<agent-name>.json`
- `<cwd>/.modus/actions/<action-name>/action.json`
- `<cwd>/.modus/actions/<action-name>/context.ts`
