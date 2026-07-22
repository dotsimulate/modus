---
name: create-mission
description: >
  Create multi-agent missions in MO (modus operandi). Use when someone wants to:
  (1) build a project from scratch using multiple agents,
  (2) set up a multi-step workflow that exceeds a single agent's context,
  (3) orchestrate work that benefits from checkpoints, gates, or phased execution,
  (4) create open-ended exploration or discovery missions that cycle autonomously,
  (5) create a mission definition (mission.json + brief) for any project.
  TRIGGER on: "create a mission", "build me a", "mission", "multi-agent project",
  "orchestrate agents", "build a project", "new project mission", "mission-style",
  "exploration mission", "discovery mission", "cycling mission".
---

# Create Mission

A mission lets work **span multiple agent sessions** with structured
checkpoints. The creator agent designs the scaffolding — the
**orchestrator** does the actual planning at runtime.

## The Core Principle

**The creator scaffolds. The orchestrator plans.**

The creator agent runs once and disappears. It cannot predict what the
orchestrator will find, what will fail, or what threads are worth
following. A mission definition is scaffolding that keeps work moving
forward — it is NOT a detailed plan.

- The **brief** is a goal, not a roadmap
- The **steps** are phase boundaries, not instructions
- The **orchestrator** makes all judgment calls at runtime
- The **cycle config** controls repetition and budget

When a user asks you to create a mission, they are asking you to
engineer the correct *shape* around their goal — not to decide the
exact steps to reach it.

## Two Mission Modes

### Directed Mode (default)

Steps execute once, in order. Use for work with a known endpoint:
building something, fixing something, shipping something.

```
step A → step B → step C → done
```

### Cycling Mode

Steps repeat in cycles until a budget is hit or the orchestrator
decides the goal is met. Use for open-ended work: exploration,
discovery, monitoring, maintenance, batch processing.

```
step A → step B → step C → (orchestrator evaluates) → step A → ...
```

Enable cycling in mission.json:
```json
{
  "cycle": {
    "enabled": true,
    "maxCycles": null,
    "freshOrchestrator": true,
    "budget": { "usd": 50 }
  }
}
```

When `freshOrchestrator` is true, the orchestrator gets a **fresh session**
each cycle. This prevents context degradation across many cycles and enables
the bootstrap pattern — where agents read curated memory files on startup
and update them before session end. Without it, the orchestrator accumulates
stale conversation history and degrades over time.

The orchestrator ends cycling by issuing a `pause` with reason, or
cycling stops when `maxCycles` or `budget` is reached. With no limits
set, it runs until the user stops it manually.

## When a Mission Fits

A mission fits when any of these are true:
- The work would overflow a single agent's context window
- You need checkpoints between phases (gates)
- The orchestrator needs to make judgment calls between steps
- A failure in one phase shouldn't corrupt previous work
- The work is ongoing/cyclical with no fixed endpoint

A mission does NOT fit when:
- One agent can do the whole thing in one session
- There's nothing to gate or checkpoint

## Shapes

Shapes are structural patterns. The brief makes them specific.
Pick the shape, then write a brief that gives the orchestrator a goal.

### Directed Shapes

These run once. Each step advances toward a known endpoint.

**research → synthesize → build**
Gather information, distill it, build from it.
Good for: projects where understanding precedes implementation.

**audit → fix → verify**
Analyze what exists, fix what's wrong, prove the fixes work.
Good for: codebase analysis, security, performance, compliance.

**scaffold → iterate → ship**
Create a skeleton, build it out, finalize.
Good for: new projects of any kind.

**decompose → implement → integrate**
Break a big thing into parts, build each, wire them together.
Good for: large features that exceed one session.

**spec → implement → validate**
Write a spec, build to it, test against it.
Good for: contract-first APIs, protocol implementations.

### Cycling Shapes

These repeat. The orchestrator decides when to stop or what to
target next. Each cycle produces independent, committed output.

**ideate → build → evaluate** (single worker step)
The orchestrator bootstraps fresh, folds in previous findings, ideates
the cycle's target, writes a build brief, and delegates. The worker
builds ambitiously and writes findings to a staging area. The
orchestrator evaluates results, promotes what's valuable, and updates
its bootstrap before the session ends. Uses `freshOrchestrator: true`.
Good for: discovery, exploration, knowledge extraction, research.

**scan → triage → resolve**
Scan for issues, prioritize them, fix the highest-priority ones.
Good for: bug sweeps, maintenance, monitoring, health checks.
The orchestrator re-scans after each cycle to pick the next target.

**ingest → transform → output**
Take raw input, process it, produce useful output.
Good for: batch processing, data pipelines, content generation.
The orchestrator manages the input queue and quality checks.

## Roles — Keep Them Minimal

**Most missions need exactly 2 roles: orchestrator + one worker.**

Every additional role spawns a new session that must rebuild context
from scratch. This is expensive. The new agent reads the brief, reads
the project, reads previous outputs, figures out where things stand.
More roles = more cold starts = more wasted tokens.

**The orchestrator IS the reviewer.** It has full mission context —
it's been watching every step. It naturally understands the intent,
the brief, previous decisions, and current state. Use the orchestrator
for review gates by default: set `"reviewer": "orchestrator"` on steps.

Only create a 3rd role when ALL of these are true:
- Review context alone would overflow the orchestrator's window
- The review requires specialized tools the orchestrator doesn't have
- The review protocol justifies a cold-start

This is rare. If you find yourself creating 3+ roles, stop and ask
whether the work should be one mission with 2 roles or genuinely
needs the extra cold-start overhead.

### Available profiles

| Profile | Best For | Model |
|---------|----------|-------|
| `executor` | orchestrator (review + coordination) | opus |
| `mission-dev` | developer/builder/worker | sonnet |

Any profile can serve any role. Project-local profiles can be created
at `<project>/.modus/profiles/agents/<name>.json`.

## Step Design

### For Directed Missions: 3-5 steps

Each step is a meaningful phase that produces committed output.
Steps are **phase boundaries**, not task descriptions. Tell the
step what phase it represents and what gates to enforce — let the
orchestrator and workers figure out the details.

Signs you have too many steps:
- Multiple consecutive steps have the same role
- Steps could be merged without exceeding context limits
- You're writing detailed instructions in step descriptions

Signs you have too few steps:
- A single step would overflow context
- There's no checkpoint between phases that could diverge

### For Cycling Missions: 2-3 steps per cycle

Each cycle should be lightweight enough to repeat many times.
The orchestrator evaluates after each cycle and decides: continue,
change target, or stop.

Step descriptions in cycling missions should be **structural**:
```
"Investigate the current target. Write findings to context/. Update status.md."
```

NOT **prescriptive**:
```
"Read queue.md. Pick domain #4. Catalog all parameters using td_inspect.
Write report to discoveries/prospector/{domain}_{date}.md. Update queue.md
marking domain as PROSPECTED. Hand off to engineer with a clear list..."
```

The first tells the worker what phase it's in. The second tries to
predict exactly what the worker should do — that's the orchestrator's
job at runtime.

## Writing the Brief

The brief is the most important file. It tells the orchestrator
what to accomplish and what constraints to respect. It does NOT
tell the orchestrator how to plan the work.

### A good brief contains:

1. **The goal** — what does success look like? (1-3 sentences)
2. **Constraints** — what to avoid, what's off-limits, what matters
3. **Done condition** — how the orchestrator knows it's finished
4. **Context pointers** — where to find relevant state (not the state itself)
5. **Quality bar** — what "good enough" means for outputs

### A good brief does NOT contain:

- **Detailed domain queues** — the orchestrator discovers and prioritizes
- **Step-by-step protocols** — that's what mission.json steps are for
- **Exact output paths** — the orchestrator decides file organization
- **Methodology prescriptions** — "use systematic cataloging" vs "follow threads" is an orchestrator decision
- **Role-specific instructions** — step descriptions handle this minimally

### Brief length

A brief for a directed mission: **half a page to one page.**
A brief for a cycling mission: **one paragraph to half a page.**

The less you prescribe, the more the orchestrator can adapt.
Cycling missions especially should be brief — each cycle gives the
orchestrator a chance to re-evaluate, so front-loading a plan is
actively counterproductive.

Supports `{{templateVars}}` from user profile.

### Example: Cycling discovery brief

```markdown
# API Surface Discovery

## Goal
Build a verified reference library documenting non-obvious behaviors,
edge cases, and undocumented capabilities across the platform's API.

## Constraints
- All claims must be backed by reproducible test evidence
- No external dependencies beyond the platform's standard API
- Protected/system paths are read-only
- Follow existing module patterns in the project

## Done Condition
Run until stopped. Each cycle should produce at least one new
verified finding or improved reference entry.

## Quality Bar
A finding ships when it has a clear description, was tested live,
handles known edge cases, and adds genuine value.
```

That's it. The orchestrator decides what domains to explore, what
methodology to use, what order to work in, and when to change
direction based on what it actually finds.

### Example: Directed build brief

```markdown
# Search CLI Tool

## Goal
Build a command-line tool that queries the project's registry
and returns formatted results. Users should be able to search by
name, category, and version.

## Requirements
- Reads from the project's registry JSON
- Supports: search by name (fuzzy), filter by category, filter by version range
- Output formats: table (default), json, csv
- Single Python file, no external dependencies beyond stdlib

## Done Condition
All three search modes work correctly with all three output formats.
Edge cases: empty results, malformed input, missing registry file.
```

## Shared Context

Each mission has a context folder at:
```
<project>/.modus/missions/<name>/context/
```

### Required: status.md

The orchestrator updates this after each step/cycle. Workers read it
at session start. Keep it minimal — current state, key decisions,
known issues. This is a living document, not a log.

### Optional context files

Workers and orchestrators create additional files as needed. Don't
prescribe these in the mission definition — let them emerge from
the work. The step descriptions just say "write findings to context/"
and the agents organize as they go.

## Gates

| Gate | Enforces |
|------|----------|
| `commit` | Code was committed before advancing |
| `tests` | Tests were run and reported |
| `review` | The reviewer (usually orchestrator) approved |
| `handoff` | Context was documented for the next step |

Gates prevent compounding errors. The `handoff` gate is especially
important for cycling missions — it ensures status.md is current
before the next cycle starts.

## Scope Guidance

When a user asks for N missions on the same topic, push back:

**"Is this one mission with N methodologies, or truly N independent
efforts with different goals?"**

If the methodologies serve the same goal (e.g., "systematic exploration"
and "thread-following exploration" and "independent verification" all
serve "discover TD behaviors"), that's ONE cycling mission where the
orchestrator picks methodology per cycle — not three separate missions.

Multiple missions are appropriate when:
- Goals are genuinely independent (building a CLI tool AND exploring TD internals)
- Different budgets or timelines apply
- Different teams or contexts are involved

Multiple missions are NOT appropriate when:
- Same goal, different approaches (one mission, orchestrator decides approach)
- Same goal, different domains (one cycling mission with a queue)
- Parallel tracks toward the same output (one mission, sequential or gated)

## Workflow

1. **Understand the goal** — what does the user want to end up with?
2. **Pick the mode** — is this directed (known endpoint) or cycling (open-ended)?
3. **Pick the shape** — which structural pattern fits?
4. **Write the brief** — goal + constraints + done condition. Not a plan.
5. **Write mission.json** — 2 roles, 2-4 steps, gates. See [references/schema.md](references/schema.md).
6. **Create context/status.md** — initial state only.
7. **Place files** — `<project>/.modus/missions/<name>/`

## Shape Templates

Template mission.json files are in `assets/shapes/`. Copy and customize.
Directed templates: `research-synthesize-build.json`, `audit-fix-verify.json`, etc.
Cycling templates: `ideate-build-evaluate.json`, `scan-triage-resolve.json`.

## Starting a Mission

Agents cannot start missions directly (auth boundary). After placing
the files, the user starts from the dashboard UI.

## Full Schema Reference

For complete field-level documentation, read [references/schema.md](references/schema.md).

## Anti-Patterns (from real failures)

### The Prescriptive Brief
A creator agent wrote a brief with 25 prioritized domains, exact
folder paths for every output, step-by-step cycle protocols, and
role-specific instructions. The orchestrator had nothing to decide —
and when reality diverged from the plan, there was no flexibility.

**Fix:** Brief states the goal. Orchestrator plans at runtime.

### The Role Explosion
A creator agent split one goal across 3 missions with 3 roles each
(9 total agents). All three missions had identical structure with
different role names. The overhead of 9 cold-starts per cycle
dwarfed the actual work.

**Fix:** One mission, 2 roles, cycling mode. Orchestrator picks
methodology per cycle.

### The Linear Hack
A mission needed to cycle but the schema had no cycling support.
The creator hacked "if still running, hand off back to step 1"
into step descriptions. This was fragile and unclear.

**Fix:** Use `"cycle": { "enabled": true }` in mission.json.

### The Creator-as-Planner
The creator agent decided domain order, methodology, file organization,
and quality criteria — decisions that only make sense at runtime with
actual context. When the orchestrator found cross-domain connections,
it couldn't reorder because the brief prescribed the sequence.

**Fix:** The creator designs structure. The orchestrator plans.
