---
name: create-mission
description: >
  Create multi-agent missions in MO (modus operandi). Use when someone wants to:
  (1) build a project from scratch using multiple agents,
  (2) set up a multi-step workflow that exceeds a single agent's context,
  (3) orchestrate work that benefits from checkpoints, gates, or phased execution,
  (4) create a mission definition (mission.json + brief) for any project.
  TRIGGER on: "create a mission", "build me a", "mission", "multi-agent project",
  "orchestrate agents", "build a project", "new project mission", "mission-style".
---

# Create Mission

A mission lets a user's request **span multiple agent sessions** in a
controllable way. It's a flexible primitive backed by simple configuration
files — a `mission.json` that defines steps, roles, and gates, and a
`brief.md` that describes what to build.

The value is NOT "different specialists." It's structured progression
through work too large for a single uninterrupted session, with
checkpoints that prevent compounding errors.

## When a Mission Is Useful

A mission fits when any of these are true:
- The work would overflow a single agent's context window
- You need verifiable checkpoints between phases (gates)
- The orchestrator needs to make judgment calls between steps
- A failure in one phase shouldn't corrupt all previous work
- You want git-tracked, auditable progress

A mission does NOT fit when:
- One agent can do the whole thing in one session
- The work is exploratory with no clear phases
- There's nothing to gate or checkpoint

## Mission Shapes

Each shape is a process pattern. The brief makes it specific.
Pick the shape that fits the user's goal, then write a brief.

### research → synthesize → build
The agent gathers information, distills it, then builds from it.
Good for: projects where understanding precedes implementation.
The research step accumulates context the build step needs but can't hold.

### audit → fix → verify
Analyze what exists, fix what's wrong, prove the fixes work.
Good for: codebase analysis, security hardening, performance, compliance.
Gates ensure each fix is verified before moving on.

### scaffold → iterate → ship
Create a skeleton, build it out with review cycles, finalize.
Good for: new project builds of any kind.
The orchestrator reviews between iterations to catch compounding errors.

### explore → prototype → evaluate
Try multiple approaches, build quick versions, compare and recommend.
Good for: technical decisions, architecture exploration.
Each prototype gets a fresh context instead of a polluted one.

### decompose → implement → integrate
Break a big thing into parts, build each, bring them together.
Good for: large features, system builds that exceed one session.
Each part is committed and gated independently.

### ingest → transform → present
Take raw input, process it, output something useful.
Good for: data pipelines, documentation generation, content processing.
Gates verify each stage's output before the next consumes it.

### spec → implement → validate
Write a formal specification, build to it, test against it.
Good for: contract-first APIs, protocol implementations.
The spec is the source of truth; the validate step enforces it.

### observe → hypothesize → test
Study a system, form theories, test them systematically.
Good for: debugging complex issues, performance analysis.
Each hypothesis is tested in isolation with fresh context.

## Roles — Keep Them Minimal

**Most missions need exactly 2 roles: orchestrator + one worker type.**

Every additional role spawns a new agent session that must rebuild
context from scratch. This is expensive — the new agent has to read
the brief, read the project, read previous outputs, and figure out
where things stand. Minimize roles to minimize context waste.

### The orchestrator IS the reviewer

The orchestrator has full mission context — it's been watching every
step unfold. It is naturally the best reviewer because it already
understands the intent, the brief, the previous decisions, and the
current state. **Use the orchestrator for review gates by default.**

Set `"reviewer": "orchestrator"` on steps that need a review gate.
The orchestrator reviews the worker's report, checks the output,
and passes or fails the gate — all without spawning a new session.

### When to use a dedicated reviewer

Only create a separate reviewer role when ALL of these are true:
- The mission is so large that review context alone would overflow
  the orchestrator's window
- The review requires specialized tools the orchestrator doesn't have
- The review protocol is intensive enough to justify a cold-start

This is rare. For most missions, the orchestrator handles review.

### Available profiles

| Profile | Best For | Model |
|---------|----------|-------|
| `executor` | orchestrator (review + coordination) | opus |
| `mission-dev` | developer/builder/worker | sonnet |

The `mission-reviewer` profile exists for the rare case where a
dedicated read-only reviewer is needed. It is read-only (no Edit/Write)
— do NOT assign it steps that require writing files or making commits.

Any profile can serve any role. Project-local profiles can be created
at `<project>/.modus/profiles/agents/<name>.json`.

## Shared Context — The Mission Log

Each mission creates a shared context folder at:
```
<project>/.modus/missions/<name>/context/
```

This folder contains files that are **read and updated throughout
the mission** by all roles. It prevents context loss between sessions:

### Required files

**`status.md`** — Living mission status document.
The orchestrator updates this after each step completes. Workers read
it at the start of their session to understand where things stand.

Structure:
```markdown
# Mission Status

## Completed Steps
- [step-id]: what was done, key decisions, files changed

## Current Step
- [step-id]: what's in progress, who's working on it

## Key Decisions
- Decision 1: rationale
- Decision 2: rationale

## Known Issues
- Issue 1: status
```

**`brief.md`** — The mission brief (already exists, placed at mission root).

### Optional files

Workers and the orchestrator can create additional context files as
needed (findings documents, specs, critique notes, etc.). These live
in the mission's context folder and are referenced by step descriptions.

### How step descriptions should reference context

Step descriptions should tell workers to read and write context files:
```json
{
  "description": "Read context/status.md for current state. Research X. Write findings to context/research-findings.md. Update context/status.md when done."
}
```

This way each worker starts by reading the accumulated context rather
than having to re-discover everything from the codebase.

## Step Design — Fewer, Meatier Steps

**3-5 steps is the sweet spot for most missions.** Each step should
represent a meaningful phase that produces real, committed output.

Signs you have too many steps:
- A step only touches 1-2 files
- Multiple consecutive steps have the same role
- Steps could be merged without exceeding context limits
- The total step count exceeds the number of files you expect to change

Signs you have too few steps:
- A single step would overflow an agent's context window
- There's no checkpoint between phases that could diverge
- A failure partway through would require redoing everything

**Merge aggressively.** Two thin steps that touch overlapping files
should be one step. Critique → iteration cycles should be one step
where the worker self-critiques, not two steps with separate agents.

## Workflow

1. **Understand the user's goal** — what do they want to end up with?
2. **Identify why multi-agent helps** — what overflows, what needs gates, what benefits from fresh context between phases?
3. **Select a shape** — which pattern above fits the work?
4. **Write the brief** — this is the real work. The brief tells the orchestrator what to accomplish. Be specific about the goal, flexible about how.
5. **Write mission.json** — map the shape to steps, assign 2 roles (orchestrator + worker), set gates. See [references/schema.md](references/schema.md) for the full schema.
6. **Create context/** — add an initial `status.md` to the mission's context folder.
7. **Place the files** — `<project>/.modus/missions/<name>/mission.json` + `brief.md` + `context/status.md`

## Writing the Brief

The brief is the most important file. It's injected into every agent's
prompt. Write it for the ORCHESTRATOR — they decide how to interpret
each step. Don't over-specify implementation details.

A good brief:
- States the end goal clearly
- Lists concrete requirements (testable, not vague)
- Specifies constraints (tech stack, what to avoid)
- Defines "done"
- Tells workers to read `context/status.md` before starting work
- Leaves room for the orchestrator to make judgment calls

A bad brief:
- Dictates exactly what code to write (that's what workers figure out)
- Is vague ("make something cool")
- Duplicates what the step descriptions already say
- Creates separate roles for work the orchestrator can handle

Supports `{{templateVars}}` from user profile (e.g. `{{name}}`, `{{stack}}`).

## Gates

| Gate | Enforces |
|------|----------|
| `commit` | Code was committed before advancing |
| `tests` | Tests were run and reported |
| `review` | The reviewer (usually orchestrator) approved the work |
| `handoff` | Context was documented for the next step (update status.md) |

Gates prevent compounding errors. Use them on steps where a failure
would be expensive to unwind.

The `handoff` gate is especially important — it ensures `context/status.md`
is updated before the next step starts, keeping shared context current.

## Shape Templates

Template mission.json files for each shape are in `assets/shapes/`.
Copy the one that fits and customize the brief.

## Starting a Mission

Agents cannot start missions directly (by design — auth boundary).
After writing mission.json + brief.md + context/status.md, the user
starts it from the dashboard UI, which shows all available missions
with start/pause/resume.

## Full Schema Reference

For complete field-level documentation of mission.json, read
[references/schema.md](references/schema.md).
