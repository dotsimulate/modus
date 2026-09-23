---
name: create-action
description: >
  Create or update Modus Actions: finite commands, custom code, model completions,
  or agent sessions with manual, interval, webhook, session-event, or chain triggers.
  Use for build/test buttons, scheduled tasks, webhook automation, and named jobs
  with run history.
---

# Create Action

Actions are named operations with triggers and recorded results. Author them under
`<project>/.modus/actions/<name>/`. Choose execution independently of the trigger.

## Choose the execution path

| Work | Configuration | Files and entry point |
|------|---------------|-----------------------|
| Finite executable, such as build or test | `execution: { type: "command", executable, args? }` | `action.json` only; never loads `context.ts` |
| Custom logic, structured output, artifacts, or handoff | `execution: { type: "code" }` | `action.json` + `context.ts` exporting `run(ctx)` |
| Tool-less model response | Omit `execution`; set `answerer: "completion"` and `agentProfile` | `action.json` + string-returning `gather(ctx)` in `context.ts` |
| Agent session with tools | Omit `execution`; `answerer: "session"` is the default; set `agentProfile` | `action.json` + `gather(ctx)` in `context.ts` |

Command and Code create no sessions and reject AI profile, model/session, moves,
skills, steps, and retry settings. Code does not call `gather`, `verify`, or
`afterRun`. Read [references/action-schema.md](references/action-schema.md) for
inputs, Code context/results, limits, and invocation. The AI patterns below and
in [references/context-patterns.md](references/context-patterns.md) use a separate
`ActionContext`; they do not describe `CodeActionContext`.

## Workflow

1. Inspect existing project actions and identify the work, trigger, inputs, and output.
2. Choose Command, Code, Completion, or Session. Reuse a suitable profile only for AI.
3. Define the working directory, limits, and any `inputSchema`.
4. Write only the files needed by the selected path. Preserve existing activation
   choices. `trigger` defaults to `manual`, `enabled` to `true`. Use `enabled: false`
   when automatic triggers should remain parked; explicit Run still works for
   disabled manual/interval actions.
5. Validate against the current contract. For an authorized smoke run, inspect the
   receipt, logs, and expected output. Trigger acknowledgement is not completion.
   Report the files written and what was actually verified.

Commands run on the connected backend machine, with project root as the default
`cwd` for project actions. Verify executable availability and script arguments on
that target. Finite jobs use Run, logs, results, and cancellation in the Actions
manager or `action-card` page widget; they do not open a PTY.

## Minimal Command

`<project>/.modus/actions/build/action.json`:

```json
{
  "name": "build",
  "execution": { "type": "command", "executable": "bun", "args": ["run", "build"] }
}
```

This assumes the project defines a `build` script. No profile or context module
is needed. See the schema reference for parameterized commands and Code examples.

## Five Trigger Types

| Type | When it fires | Key config |
|------|--------------|------------|
| `interval` | Every N seconds/minutes/hours | `every`, `from`, `activeHours` |
| `webhook` | HTTP POST to `/api/actions/<name>/hook?token=...` | `token` (auto-generated) |
| `manual` | UI button or API call | (none) |
| `action` | After another action completes | `source`, `condition` |
| `session` | Matching session event | `on`, `excludeTags` |

## AI examples and execution guidance

The remaining examples and pipeline guidance apply when `execution` is omitted:
`gather -> session/completion -> verify -> afterRun -> notify -> chain`.
Session features such as `moves` and `steps` require the Session answerer.
Completion requires string gather output and rejects session-only fields; check
the schema reference before adapting a Session example.

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

## AI authoring rules

- **context.ts is portable** — it can live in ANY project's `.modus/actions/` directory.
  Type imports in reference examples are relative to built-in source locations;
  resolve a real declaration in the target project or omit those annotations.
  Do not copy an unresolved `../../action-types` import into a project action.
  Everything else is on `ctx`: run history via `ctx.db.getRunSummaries()`, SVG rendering
  via `ctx.svgToPngBase64()`, logging via `ctx.log()`. Use `fs` for reading project files.
- **For project-local context** — read files from the project directory using `fs` and
  `ctx.actionDir`. For structured context gathering, use `moves` on the action to attach
  companion moves that read memory and build prompts.
- AI actions reference a resolvable project, Vault, or plugin `agentProfile`.
  Create a new project profile only when needed.
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
- Set AI retry budgets to suit the task and model cost; Command/Code have no automatic retry.

## Creating an AI action

1. **Agent profile** — the agent's identity (`create-profile` skill)
2. **Action config** — trigger, execution, verify, artifacts, notifications
3. **Context module** — what to ask, how to verify, what to do with the answer

Output paths:
- `<cwd>/.modus/profiles/agents/<agent-name>.json`
- `<cwd>/.modus/actions/<action-name>/action.json`
- `<cwd>/.modus/actions/<action-name>/context.ts`
