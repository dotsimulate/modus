# Mission Definition Schema

Full reference for `mission.json`. Read this when you need field-level
detail beyond what SKILL.md covers.

## Complete Structure

```json
{
  "name": "string",
  "label": "string",
  "description": "string",
  "enabled": true,
  "brief": "brief.md",

  "roles": {
    "<role-name>": {
      "profile": "<agent-profile-name>",
      "description": "optional role description"
    }
  },

  "steps": [
    {
      "id": "string",
      "label": "string",
      "role": "<role-name>",
      "reviewer": "<role-name, optional>",
      "description": "optional detailed instructions for worker",
      "gates": [
        { "type": "commit | tests | review | handoff", "required": true }
      ]
    }
  ],

  "policy": {
    "requireTestsBeforeAdvance": false,
    "requireCommitBeforeAdvance": false,
    "requireHandoffOnTransfer": false,
    "allowParallelSteps": false,
    "maxConcurrentAgents": 1
  },

  "budgets": {
    "usd": null,
    "hours": null,
    "turnsPerSession": 30
  },

  "onFailure": {
    "strategy": "pause | stop",
    "maxRetriesPerStep": 2
  },

  "tags": []
}
```

## Field Reference

### Top Level

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | yes | string | Unique ID, must match directory name |
| `label` | yes | string | Human-readable title |
| `description` | yes | string | What this mission accomplishes |
| `enabled` | no | boolean | Default true. Set false to disable |
| `brief` | no | string | Path to markdown brief, relative to mission dir |
| `roles` | yes | object | Role-to-profile mapping |
| `steps` | yes | array | Ordered step definitions |
| `policy` | yes | object | Execution constraints |
| `budgets` | no | object | Resource limits |
| `onFailure` | no | object | Failure handling strategy |
| `tags` | no | string[] | Searchable tags |

### Roles

Keys are role names, values are `{ profile, description? }`.

The `orchestrator` role is special — the runner spawns it first and
injects the full mission context. If no `orchestrator` role is defined,
the runner falls back to the first role.

Profile resolution order:
1. Project-local: `<cwd>/.modus/profiles/agents/<profile>.json`
2. Harness-level: `harness/profiles/agents/<profile>.json`

### Steps

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | yes | string | Unique step identifier |
| `label` | yes | string | Human-readable name |
| `role` | yes | string | Role that owns this step |
| `reviewer` | no | string | Role that reviews (gets gate permission) |
| `description` | no | string | Detailed instructions for the worker |
| `gates` | yes | array | Checkpoints before step can advance |

Steps execute sequentially (parallel not supported in V1).
Step IDs must be unique within the mission.
The `role` and optional `reviewer` must reference defined roles.

### Gates

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `type` | yes | string | One of: `commit`, `tests`, `review`, `handoff` |
| `required` | no | boolean | Default true. Set false for optional gates |

Gate semantics:
- **commit**: Worker reported commit hashes in their report
- **tests**: Worker reported test results in their report
- **review**: A reviewer agent recorded a passing review gate
- **handoff**: Worker included a handoff summary in their report

The runner validates ALL required gates pass before allowing `advance`.

### Policy

| Field | Default | Description |
|-------|---------|-------------|
| `requireTestsBeforeAdvance` | false | Tests gate must pass on every step with a tests gate |
| `requireCommitBeforeAdvance` | false | Commit gate must pass on every step with a commit gate |
| `requireHandoffOnTransfer` | false | Handoff summary required on every delegation |
| `allowParallelSteps` | false | V1: always false |
| `maxConcurrentAgents` | — | Max concurrent worker sessions |

### Budgets

| Field | Description |
|-------|-------------|
| `usd` | Maximum cost in USD |
| `hours` | Maximum wall-clock hours |
| `turnsPerSession` | Max turns per spawned agent session |

### onFailure

| Field | Description |
|-------|-------------|
| `strategy` | `"pause"` (halt for human review) or `"stop"` (abort mission) |
| `maxRetriesPerStep` | How many times to retry a failed step |

## Command Bus Reference

All mission operations flow through `modus_submit` with `mis-` prefixed
tokens. The runner auto-injects tokens and instructions into agent prompts.

### Operations

| Op | Who Can Use | Payload |
|----|-------------|---------|
| `read` | all | `{}` |
| `delegate` | orchestrator | `{ stepId, role, brief, transferSummary? }` |
| `report` | workers | `{ stepId, status, summary, filesChanged?, commits?, testResults?, handoffSummary? }` |
| `gate` | orchestrator + reviewers | `{ stepId, gate, status, evidence? }` |
| `advance` | orchestrator | `{ stepId }` |
| `pause` | orchestrator | `{ reason }` |

### Mission Response (delivered to orchestrator)

When a worker reports or a gate is recorded, the orchestrator receives:

```json
{
  "type": "worker_report | gate_update",
  "stepId": "...",
  "allGatesPassed": true,
  "gateSnapshot": [
    { "gate": "commit", "status": "pass" },
    { "gate": "tests", "status": "pending" }
  ],
  "workerStatus": "completed | failed",
  "summary": "...",
  "filesChanged": [],
  "commits": []
}
```

The orchestrator uses `allGatesPassed` and `gateSnapshot` to decide
the next action: advance, record gates, retry, reassign, or pause.
