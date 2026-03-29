---
name: create-mission
description: >
  Create and launch multi-agent missions in MO (modus operandi). Use when someone wants to:
  (1) build a project from scratch using multiple agents (website, game, app, tool),
  (2) set up a multi-step workflow with different agent roles (developer, reviewer, designer),
  (3) orchestrate agent collaboration with git-tracked progress and quality gates,
  (4) create a mission definition (mission.json + brief) for any project,
  (5) scaffold a new project directory as mission-ready.
  TRIGGER on: "create a mission", "build me a", "mission", "multi-agent project",
  "orchestrate agents", "build a project", "new project mission", "mission-style".
---

# Create Mission

Missions coordinate multi-agent workflows: an orchestrator delegates steps
to workers, workers report results, gates enforce quality, and the whole
thing is git-tracked and traceable.

**define roles -> order steps -> set gates -> write brief -> start**

## Workflow

1. Understand what the user wants to build
2. Decide step breakdown (scaffold -> implement -> polish is the default)
3. Map roles to profiles (see profile table below)
4. Set gates per step (commit, tests, review, handoff)
5. Write the brief — this is the most important part
6. Write mission.json
7. Scaffold the project directory if needed (`mkdir -p`, `git init`)
8. Start the mission

## Project Structure

```
<project>/
  .modus/
    missions/<name>/
      mission.json    <- roles, steps, gates, policy
      brief.md        <- project requirements (injected into all agent prompts)
  .git/               <- recommended: git init for tracked progress
```

## Quick Start

Copy the template files from this skill's assets/ directory:
- `assets/mission.json` — complete template, customize for your project
- `assets/brief.md` — brief template, replace with real requirements

Write them to `<project>/.modus/missions/<name>/`.

## Profiles for Mission Roles

These profiles exist at the harness level (available to all projects):

| Profile | Best For | Model | Tools |
|---------|----------|-------|-------|
| `executor` | orchestrator | opus | full |
| `mission-dev` | developer/builder | sonnet | full + bypass |
| `mission-reviewer` | code review, gates | sonnet | read-only |
| `git-ops` | git specialist | sonnet | bash + read |

Any harness or project-local profile can be used. The mission runner
auto-injects mission context (command bus, token, step brief) into
every session — profiles don't need mission-specific knowledge.

To use a project-local profile instead, create it at:
`<project>/.modus/profiles/agents/<name>.json`

## Gates

| Gate | Purpose | Use When |
|------|---------|----------|
| `commit` | Code was committed | Every step producing code |
| `tests` | Tests were run | Steps adding testable functionality |
| `review` | Reviewer approved | Steps where quality matters |
| `handoff` | Context transferred | Next step depends on understanding this one |

## Step Patterns

**Simple Build** (3 steps) — websites, tools, scripts:
`scaffold -> core implementation -> polish & ship`

**Build + Review** (4 steps) — production apps:
`scaffold -> implement -> review & iterate -> ship`

**Game Build** (4 steps):
`scaffold + game loop -> core mechanics -> content -> polish + balance`

## Writing the Brief

The brief is the most important file. It's injected into orchestrator
and worker prompts. Write it like a project spec — specific enough
that an agent can build from it without asking questions.

Must include:
- What to build (clear end-goal)
- Requirements (specific, testable bullet points)
- Tech constraints (stack, runtime, things to avoid)
- Definition of done

Supports `{{templateVars}}` from user profile (e.g. `{{name}}`, `{{stack}}`).

## Starting a Mission

The harness exposes `POST /api/missions/start`:

```json
{
  "missionName": "<name>",
  "cwd": "<absolute-path-to-project>",
  "userProfile": "<optional-user-profile>"
}
```

The `missionName` must match the directory name under `.modus/missions/`.
The `cwd` must be the project root containing `.modus/`.

If you have the modus MCP tool available, you can also use the SDK.

## Key Constraints

- Steps are frozen at run start — cannot add/remove/reorder mid-mission
- Only the orchestrator advances steps (runner validates gates, never decides)
- Workers interact via `modus_submit` MCP tool (auto-injected into all sessions)
- Brief is snapshotted at start — mid-run edits to brief.md have no effect
- On harness restart, in-flight missions are marked as errored

## Full Schema Reference

For the complete mission.json schema with all fields, defaults, and
detailed explanations, read [references/schema.md](references/schema.md).
