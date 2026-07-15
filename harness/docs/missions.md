---
title: Missions
lastUpdated: 2026-07-07
covers: harness/mission-runner.ts harness/mission-types.ts harness/mission-db.ts harness/modus-mcp.ts
---

# Missions

Missions are the project-level orchestration primitive. They coordinate
multi-agent workflows over time — multiple steps, multiple roles, gate
validation, and traceable transfers between agents.

```
Prompts    → single-turn guidance
Moves      → structured interactions within a session
Actions    → automated triggers (cron, webhook, chain)
Missions   → multi-step, multi-agent project workflows
```

## How Missions Work

A mission is defined by a `mission.json` file in the project's
`.modus/missions/<name>/` directory. When started, the mission runner:

1. Loads and validates the definition
2. Snapshots it into the database (frozen — no runtime edits)
3. Spawns an **orchestrator** session with the full mission context injected
4. The orchestrator delegates steps to **worker** sessions
5. Workers do implementation work and report back via the command bus
6. The orchestrator reviews reports, checks gates, and advances steps
7. When all steps complete, the mission is done

### Role Separation (Architecture Contract)

| Role | Responsibility | Can Do |
|------|---------------|--------|
| **Runner** | Records, validates, persists, routes | DB writes, grant management, gate checking, prompt injection |
| **Orchestrator** | Decides how the mission proceeds | Delegate, advance, pause, gate, read |
| **Workers** | Do implementation work | Read, report (+ gate if reviewer) |

The runner NEVER makes progression decisions. Steps advance only when
the orchestrator explicitly calls the `advance` operation and all
required gates pass.

## Mission Definition Schema

File: `<project>/.modus/missions/<name>/mission.json`

```json
{
  "name": "build-website",
  "label": "Build Personal Website",
  "description": "Build a complete personal website from requirements to deployment-ready code.",
  "enabled": true,
  "brief": "brief.md",

  "roles": {
    "orchestrator": {
      "profile": "executor",
      "description": "Coordinates the build process, delegates work, reviews results"
    },
    "developer": {
      "profile": "mission-dev",
      "description": "Writes code, runs tests, commits changes"
    },
    "reviewer": {
      "profile": "mission-reviewer",
      "description": "Reviews code quality, checks requirements, passes gates"
    }
  },

  "steps": [
    {
      "id": "scaffold",
      "label": "Project Scaffolding",
      "role": "developer",
      "description": "Initialize the project structure, install dependencies, create base files.",
      "gates": [
        { "type": "commit" },
        { "type": "handoff" }
      ]
    },
    {
      "id": "implement",
      "label": "Core Implementation",
      "role": "developer",
      "reviewer": "reviewer",
      "description": "Build the core pages and components according to the brief.",
      "gates": [
        { "type": "commit" },
        { "type": "tests" },
        { "type": "review" }
      ]
    },
    {
      "id": "polish",
      "label": "Polish & Ship",
      "role": "developer",
      "description": "Final styling, accessibility check, README, deployment config.",
      "gates": [
        { "type": "commit" },
        { "type": "handoff" }
      ]
    }
  ],

  "cycle": {
    "enabled": true,
    "maxCycles": 5,
    "freshOrchestrator": true,
    "budget": { "usd": 25 }
  },

  "policy": {
    "requireTestsBeforeAdvance": true,
    "requireCommitBeforeAdvance": true,
    "requireHandoffOnTransfer": true,
    "allowParallelSteps": false,
    "maxConcurrentAgents": 1
  },

  "budgets": {
    "turnsPerSession": 30
  },

  "onFailure": {
    "strategy": "pause",
    "maxRetriesPerStep": 2
  },

  "tags": ["build", "website"]
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique identifier (matches directory name) |
| `label` | string | Human-readable title |
| `description` | string | What this mission accomplishes |
| `roles` | Record<string, RoleConfig> | Role-to-profile mappings |
| `steps` | StepDefinition[] | Ordered step sequence (frozen at run start) |
| `policy` | MissionPolicy | Execution constraints |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | true | Whether the mission can be started |
| `brief` | string | — | Path to a markdown brief file (resolved relative to mission dir) |
| `cycle.enabled` | boolean | false | Reset all steps after completion and continue |
| `cycle.maxCycles` | number \| null | null | Cap on total cycles |
| `cycle.freshOrchestrator` | boolean | false | Spawn a fresh orchestrator session each cycle |
| `cycle.budget.usd` | number \| null | — | Cycle budget hint captured in config |
| `budgets.usd` | number | — | Cost limit |
| `budgets.hours` | number | — | Time limit |
| `budgets.turnsPerSession` | number | — | Max turns per spawned session |
| `onFailure.strategy` | "pause" \| "stop" | — | What to do when a step fails |
| `onFailure.maxRetriesPerStep` | number | — | Retry limit per step |
| `tags` | string[] | [] | Searchable tags |

### Roles

Each role maps to an agent profile. The profile must be resolvable either from
the user's profile home or the project's `.modus/profiles/agents/`. Profile
resolution order:

1. Project-local: `<cwd>/.modus/profiles/agents/<name>.json`
2. User-home: `~/.modus/profiles/agents/<name>.json`

The `orchestrator` role is special — the runner spawns the orchestrator
session first and injects the full mission context as the session prompt.
If no explicit `orchestrator` role exists, the runner falls back to the
first role defined.

Worker profiles should be good at their domain (coding, reviewing, etc.)
but don't need mission-specific knowledge — the runner injects mission
context (step brief, command bus instructions, token) into every worker
session prompt.

### Steps

Steps are ordered and executed sequentially (V1 — `allowParallelSteps`
is always false). Each step has:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique step identifier |
| `label` | string | Human-readable step name |
| `role` | string | Which role owns this step |
| `reviewer` | string? | Optional reviewer role (gets gate permissions) |
| `description` | string? | Detailed instructions for the worker |
| `gates` | GateDefinition[] | Required checkpoints before step can advance |

### Gates

Gates are checkpoints that must pass before a step can be advanced.
The runner validates all required gates when the orchestrator calls `advance`.

| Gate Type | What It Verifies |
|-----------|-----------------|
| `handoff` | A structured handoff summary was provided in the report |
| `tests` | Tests were run and results were reported |
| `commit` | Code was committed (commit hashes in report) |
| `review` | A reviewer agent passed a review gate |

Gates are recorded via the `gate` operation on the command bus. The
orchestrator (and reviewers with gate permission) can record gate results.
Each gate records pass/fail with optional evidence.

### Policy

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `requireTestsBeforeAdvance` | boolean | false | Tests gate must pass to advance |
| `requireCommitBeforeAdvance` | boolean | false | Commit gate must pass to advance |
| `requireHandoffOnTransfer` | boolean | false | Handoff summary required on delegation |
| `allowParallelSteps` | boolean | false | V1: always false |
| `maxConcurrentAgents` | number | — | Max concurrent worker sessions |

## The Mission Brief

The brief is a markdown file that describes what the mission should
accomplish in detail. It's resolved at mission start and included in
both orchestrator and worker prompts.

File: `<project>/.modus/missions/<name>/brief.md`

```markdown
# Personal Website for {{name}}

## Requirements
- Single-page portfolio site
- Sections: hero, about, projects, contact
- Tech stack: HTML, CSS, vanilla JS (no framework)
- Mobile-responsive
- Fast loading (no heavy dependencies)

## Design Direction
- Minimal, dark theme
- Monospace typography
- Subtle animations on scroll

## Content
- Name: {{name}}
- Role: Infrastructure engineer
- Projects: list from GitHub

## Deployment
- Static files only (works on any host)
- Include a simple build script if needed
```

The brief supports `{{templateVars}}` from the user profile — these get
interpolated at mission start via the same template system as profile prompts.

## Command Bus

All mission operations flow through `modus_submit` — the same MCP tool
used by moves and API ops. Mission tokens use the `mis-` prefix for
routing discrimination.

### Token Grants

When the runner spawns a session, it mints a token with specific
operation permissions:

| Role | Allowed Operations |
|------|-------------------|
| Orchestrator | read, delegate, report, gate, advance, pause |
| Worker | read, report |
| Reviewer | read, report, gate |

Tokens are in-memory, expire after 1 hour, and are scoped to a single
mission run + role + session.

### Operations

All operations use this format via `modus_submit`:

```json
{ "token": "<mission-token>", "data": { "op": "<operation>", ...params } }
```

**read** — Get current mission state (steps, assignments, gates)
```json
{ "token": "mis-xxx", "data": { "op": "read" } }
```

**delegate** — Assign a step to a worker (orchestrator only)
```json
{
  "token": "mis-xxx",
  "data": {
    "op": "delegate",
    "stepId": "implement",
    "role": "developer",
    "brief": "Build the homepage with hero and about sections. Use semantic HTML.",
    "transferSummary": "Scaffolding complete. Package.json and base structure in place."
  }
}
```
The runner spawns a new worker session with the role's profile, injects
the step context + brief, and mints a worker token.

**report** — Worker reports step completion or failure
```json
{
  "token": "mis-xxx",
  "data": {
    "op": "report",
    "stepId": "implement",
    "status": "completed",
    "summary": "Built homepage with hero, about, and projects sections.",
    "filesChanged": ["src/index.html", "src/styles.css", "src/app.js"],
    "commits": ["a1b2c3d"],
    "testResults": "3 tests passing"
  }
}
```
The runner records the report, creates a transfer record, and delivers
a structured `MissionResponse` to the orchestrator via the normal session
interaction path (`interactWithSession`), not an ad hoc side channel.

**gate** — Record a gate result (orchestrator + reviewers)
```json
{
  "token": "mis-xxx",
  "data": {
    "op": "gate",
    "stepId": "implement",
    "gate": "review",
    "status": "pass",
    "evidence": "Code follows requirements. Clean structure. Tests present."
  }
}
```

**advance** — Complete a step and move to the next (orchestrator only)
```json
{
  "token": "mis-xxx",
  "data": { "op": "advance", "stepId": "implement" }
}
```
The runner validates all required gates pass before allowing the advance.
If gates aren't met, the advance is rejected with details.

**pause** — Pause the mission (orchestrator or external API)
```json
{
  "token": "mis-xxx",
  "data": { "op": "pause", "reason": "Waiting for user input on design direction" }
}
```

### Mission Responses

When a worker reports or a gate is recorded, the orchestrator receives
a structured message:

```json
{
  "type": "worker_report",
  "stepId": "implement",
  "workerStatus": "completed",
  "summary": "Built homepage with hero, about, and projects sections.",
  "filesChanged": ["src/index.html", "src/styles.css"],
  "commits": ["a1b2c3d"],
  "allGatesPassed": false,
  "gateSnapshot": [
    { "gate": "commit", "status": "pass" },
    { "gate": "tests", "status": "pending" },
    { "gate": "review", "status": "pending" }
  ]
}
```

The orchestrator uses `allGatesPassed` and `gateSnapshot` to decide
the next action (advance, record gates, retry, reassign, or pause).

## Cycling and Resume

Missions can optionally cycle:

- When `cycle.enabled` is false, completing the final step marks the mission run `completed`.
- When `cycle.enabled` is true and `maxCycles` is not reached, the runner resets all step rows,
  clears gate results, increments `currentCycle`, and starts step 1 again.
- With `cycle.freshOrchestrator: true`, the current orchestrator session is retired at cycle
  boundary and a fresh orchestrator session is spawned with a cycle-context preamble.
- Without `freshOrchestrator`, the same orchestrator session continues and is told to begin the
  next cycle immediately.

Resume behavior:

- `/api/missions/runs/:id/resume` can resume runs in `paused` or `error`.
- The runner spawns a new orchestrator session, injects resume context summarizing completed steps,
  and clears `haltKind` / `haltMessage`.
- If all steps were already done and cycling is enabled, resume rolls into the next cycle; otherwise
  it marks the run completed.

## Runtime State

Mission execution state is persisted in `harness.db`:

| Table | Purpose |
|-------|---------|
| `mission_runs` | Top-level run record (status, current step, halt info) |
| `mission_step_runs` | Per-step execution state |
| `mission_assignments` | Worker assignment records |
| `mission_transfers` | Transfer graph (delegation, report, review, escalation) |
| `mission_gate_results` | Gate pass/fail records with evidence |

On harness restart, any in-flight runs are marked as errored (stale-run repair).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/missions?cwd=` | List mission definitions for a project |
| GET | `/api/missions/:name?cwd=` | Get a specific mission definition |
| POST | `/api/missions/start` | Start a mission run |
| GET | `/api/missions/runs` | List mission runs |
| GET | `/api/missions/runs/:id` | Get run details |
| GET | `/api/missions/runs/:id/steps` | Get step execution details |
| GET | `/api/missions/runs/:id/assignments` | Get worker assignments |
| GET | `/api/missions/runs/:id/transfers` | Get transfer graph |
| GET | `/api/missions/runs/:id/gates` | Get gate results |
| GET | `/api/missions/runs/:id/sessions` | Get spawned session IDs |
| POST | `/api/missions/runs/:id/pause` | Pause a running mission |
| POST | `/api/missions/runs/:id/resume` | Resume a paused mission |

### Starting a Mission

```json
POST /api/missions/start
{
  "missionName": "build-website",
  "cwd": "/home/user/projects/my-website",
  "userProfile": "alex"
}
```

The `cwd` must point to the project root where `.modus/missions/<name>/`
lives. The `userProfile` is optional and provides template variables for
brief interpolation. If `cwd` is omitted and `userProfile` is provided, the
API resolves `cwd` from the first project path on that user profile.

## SDK Client Methods

```typescript
const client = new ModusClient({ url: "http://localhost:3777" });

// List available missions
const missions = await client.listMissions("/path/to/project");

// Start a mission
const { runId } = await client.startMission({
  missionName: "build-website",
  cwd: "/path/to/project",
  userProfile: "alex",
});

// Monitor progress
const run = await client.getMissionRun(runId);
const steps = await client.getMissionSteps(runId);
const gates = await client.getMissionGates(runId);
const transfers = await client.getMissionTransfers(runId);

// Control
await client.pauseMission(runId, "need user input");
await client.resumeMission(runId);
```

Run summaries now include both `runNumber` and `currentCycle`, so UIs can distinguish
the nth run of a mission definition from the current cycle inside that run.

## Setting Up a Mission-Ready Project

A new project needs this minimum structure to run missions:

```
my-project/
  .modus/
    missions/
      build/
        mission.json     # Mission definition
        brief.md         # Project requirements (optional)
    profiles/
      agents/            # Project-local profiles (optional)
  .git/                  # Recommended: git init for GitOps tracking
```

The profiles referenced in `mission.json` roles can be:
- **User-home** (in `~/.modus/profiles/agents/`) — shared across projects
- **Project-local** (in `<project>/.modus/profiles/agents/`) — scoped to this project

For most missions, user-home profiles are sufficient. Create
project-local profiles only when the mission needs specialized behavior
not covered by user-home profiles.

### GitOps Convention

Missions that build projects should follow these conventions:

1. **Workers commit at the end of each step** — the `commit` gate enforces this
2. **Commit messages reference the mission** — include step ID or mission name
3. **Each step is a logical unit** — one step = one coherent set of changes
4. **The handoff gate ensures context transfer** — summaries explain what was done and what's next
5. **The review gate ensures quality** — reviewers check before advancing

The mission runner tracks commits through the `report` operation's
`commits` field and the `commit` gate's evidence. There's no built-in
git integration — workers use standard git commands and report results.

## Designing Missions

### Step Granularity

Steps should be:
- **Atomic enough** to be meaningful (one logical phase of work)
- **Large enough** to avoid excessive overhead (spawning sessions has cost)
- **Ordered by dependency** (each step builds on the previous)

Good step breakdown for a website build:
1. **Scaffold** — project structure, dependencies, base files
2. **Implement** — core pages and components
3. **Polish** — styling, accessibility, README, deployment

Bad step breakdown (too granular):
1. Create package.json
2. Install dependencies
3. Create index.html
4. Add CSS file
...

### Role Design

- **Developer** — writes code, runs tests, commits. Needs file write + bash access.
- **Reviewer** — reads code, evaluates quality, passes/fails gates. Can be read-only.
- **Orchestrator** — delegates, tracks progress, makes decisions. Doesn't write code.
- **Designer** — creates mockups, style guides. Could be a specialized developer.

Roles map to profiles. A single profile can serve multiple roles if
the skills overlap (e.g., a senior dev profile could be both developer
and reviewer in a small mission).

### Gate Strategy

- Use `commit` gates on every step that produces code
- Use `tests` gates when the step adds testable functionality
- Use `review` gates on steps where quality matters (core implementation)
- Use `handoff` gates when the next step depends on understanding the previous

### Brief Writing

The brief is the most important part of a mission definition. It should:
- State the end goal clearly
- List specific requirements (not vague aspirations)
- Specify technology constraints
- Include any design direction
- Define "done" explicitly

A good brief reads like a project spec — an agent should be able to
build from it without asking questions.

## Relationship to Other Primitives

| Primitive | Scope | Lifetime | Agents |
|-----------|-------|----------|--------|
| Prompt | Single turn | One message | One |
| Move | Structured interaction | One session | One |
| Action | Automated trigger | Recurring | One |
| Mission | Multi-step project | Hours/days | Multiple |

Missions can use moves within worker sessions (if the worker's profile
has moves configured). Missions can be triggered by actions. Missions
produce activity log entries that are queryable.

## Files

| File | Purpose |
|------|---------|
| `harness/mission-runner.ts` | Runner: loading, starting, command handling, prompt generation |
| `harness/mission-types.ts` | Type definitions and contracts |
| `harness/mission-db.ts` | Database schema, CRUD, stale-run repair |
| `harness/modus-mcp.ts` | Token routing (`mis-` prefix discrimination) |
| `harness/sdk/client.ts` | SDK client methods |
| `harness/index.ts` | REST API endpoints |
