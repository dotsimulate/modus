---
title: Core Primitives
audience: agents
lastUpdated: 2026-03-11
lastCommit: cf9d454
---

# Core Primitives

Five primitives compose to form the MO system. This doc covers what each one
is, where it lives, and how they connect.

## Sessions

A session is a single agent conversation. It has a full event log, cost
tracking, tags, and branching support.

**Lifecycle**: starting → running → idle → (running again on follow-up) → idle
Sessions do NOT transition to "done" in normal use. They stay idle.

**Storage**: `sessions` table in `harness.db`. Events stored in `events` table
with sequence numbers. FTS5 search index built from event content.

**Key fields**: id, profile, model, provider, status, cwd, user_profile,
tags (JSON array), parent_session_id (for branches), title.

**SSE streaming**: clients subscribe to `/api/sessions/:id/events` for
real-time event delivery. Events are persisted to DB and broadcast to
subscribers simultaneously.

**Branching**: `POST /api/sessions/:id/branch` creates a new session forked
from a specific message in the parent. Events are copied up to the branch
point.

**Managed by**: `session-manager.ts` (lifecycle, routing), `db.ts` (persistence).

## Agent Profiles

Define HOW an agent behaves. JSON files in `profiles/agents/` (base) or
`.modus/profiles/agents/` (project-local override).

**Key fields**: prompt, description, provider, model, tools, disallowedTools,
maxTurns, effort, permissionPolicy, mcpServers, promptMode, loadProjectSettings,
skills, ui (label, placeholder, showThinking).

**Template vars**: prompt supports `{{key}}` interpolation from `_users.json`
defaults, overridden by user profile `templateVars`.

**promptMode**: `"append"` adds the prompt after Claude Code's built-in system
prompt. `"custom"` replaces it entirely.

**Resolution**: project-local profiles override base profiles of the same name.
`getProfile(name, cwd)` checks `.modus/profiles/agents/` first, falls back to
`harness/profiles/agents/`.

**Source**: `profiles.ts`, `profile-schemas.ts`.

## User Profiles

Define WHO is using the system. Scoping layer for visibility and defaults.

**Key fields**: displayName, projects (array of paths), agentProfiles (visible
agent names), defaultAgentProfile, provider, model, templateVars, memory
(scope + inheritGlobal), actions, dashboard.

**Scoping**: user profile filters which agent profiles appear in the UI, which
project paths are available in the CWD picker, and which actions are visible.

**State**: separate from config. `profiles/state/<name>.json` stores runtime UI
state (last selected profile, window positions, etc.). Gitignored.

**Not the same as agent profiles**: user profiles control the view/scope. Agent
profiles control agent behavior. They compose — a user profile selects which
agent profiles are available and provides template vars that agent prompts use.

**Source**: `profiles.ts`, `profiles/users/*.json`.

## Actions

Define WHEN automation runs. Each action is a directory with config and code.

**Directory**: `.modus/actions/<name>/` containing:
- `action.json` — ActionConfig
- `context.ts` — ActionModule (gather, optional verify, optional afterRun)

**Triggers**: interval (timer), webhook (HTTP), manual (API call), action
(chain after another action), session (fires on session events like message
rounds or archival).

**Execution model**: action-runner manages scheduling. Each trigger creates an
execution. Executions have runs. Runs have cycles.
- **Run**: one agent session spawned and monitored
- **Cycle**: a batch of runs within a cycleInterval (resets run counter)
- **Execution**: one lifecycle instance of the action

**Pipeline**: trigger → gather() → spawn session → monitor → verify() →
afterRun() → notify. Each stage can fail, retry, or skip.

**Artifacts**: actions can declare expected output files. Verify can check
they exist. afterRun can process them.

**Source**: `action-runner.ts`, `action-types.ts`.

## Moves

Define WHAT the user wants done right now. User-facing structured operations.

**Directory**: `.modus/moves/<name>/` containing:
- `move.json` — MoveConfig
- `context.ts` — MoveModule (optional gather, optional onSubmit)
- `prompt.hbs` — Handlebars template (optional, inline prompt is fine)

**Execution modes**:
- `inline` — current session handles it, injected as a message
- `branch` — spawns a sibling session
- `background` — fire-and-forget

**Token flow**: activating a move generates a short-lived token (10min TTL).
The agent receives the token in its prompt and calls `modus_submit(token, data)`
when done. Harness validates against schema, calls onSubmit(), and marks complete.

**modus_submit**: built-in MCP tool available in every session via the modus
MCP server. It's the bridge between agent output and harness-side effects.

**Source**: `move-runner.ts`, `move-types.ts`, `modus-mcp.ts`.

## How They Connect

```
User Profile ──selects──→ Agent Profile ──configures──→ Session
     │                         │                           ↑
     │                         │                    Action triggers
     │                         │                    Move activates into
     │                         ↓                           │
     └── scopes ──→ Actions, Moves ────────────────────────┘
```

- Actions spawn sessions using agent profiles
- Moves inject into existing sessions or branch new ones
- Moves can use modus_submit to trigger side effects (via onSubmit's HarnessBridge)
- Actions can chain: one action's completion triggers another
- Session events can trigger actions (session triggers)
- User profiles scope which actions and agent profiles are visible
