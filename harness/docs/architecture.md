---
title: MO Architecture
audience: agents
lastUpdated: 2026-03-11
lastCommit: cf9d454
---

# MO Architecture

MO is a personal AI agent harness. It manages agent sessions, composes
configuration from layered profiles, automates agent workflows, and
provides a web UI for interaction. The stack is TypeScript on Bun with
Hono (backend) and React (frontend).

This document is the entry point. It covers structure, how things connect,
and links to detailed docs for each subsystem. Read source code for exact
schemas and implementation — these docs describe shape and relationships,
not exhaustive field lists.

## Repo Structure

```
agent_dev_zone/
  harness/                 # The application
    index.ts               # Hono HTTP server — all API routes
    session-manager.ts     # Session lifecycle, SSE, message routing
    profiles.ts            # Profile loading, merging, template vars
    profile-schemas.ts     # JSON Schema validation for profiles
    db.ts                  # SQLite (harness.db) — sessions, events, search
    activity.ts            # Activity log (activity.db) — audit trail
    secrets.ts             # API key isolation + PIN auth
    init.ts                # Project initialization (.modus/ scaffolding)
    project-ui.ts          # Theme/font registry and activation
    providers/             # Execution backends (see providers doc)
      registry.ts          # Provider name → implementation mapping
      types.ts             # SessionProvider interface + TurnContext
      claude-code.ts       # Claude Code SDK provider
      codex.ts             # OpenAI Codex provider
      gemini-cli.ts        # Gemini CLI provider
      pi-agent.ts          # PI agent (multi-provider: anthropic, openai, litellm, ollama, openrouter)
      mcp-bridge.ts        # MCP server lifecycle management
      models.ts            # Model listing per provider
    action-runner.ts       # Action scheduling, execution, verify/retry
    action-types.ts        # Action type contracts
    move-runner.ts         # Move activation, token management, submit handling
    move-types.ts          # Move type contracts
    modus-mcp.ts           # Built-in MCP server (modus_submit tool)
    prompt-loader.ts       # Handlebars template rendering for moves
    notify.ts              # Notification channels (webhook dispatch)
    watchdog.ts            # Process health monitoring
    git.ts                 # Git operations for session context
    profiles/              # Configuration files (see profiles doc)
      _global.json         # Shared MCP servers + provider defaults
      _users.json          # Template variable defaults
      _projects.json       # Project registry (id → name + path)
      agents/              # Agent profile JSONs
      users/               # User profile JSONs
      state/               # Runtime UI state (gitignored)
    ui/                    # React frontend (Vite + React)
      src/
        api/               # API client modules (one per domain)
        components/        # React components
        providers/         # React context providers
        styles/            # CSS (see styling doc)
        hooks/             # Custom React hooks
        widgets/           # Dashboard widgets
        main.tsx           # App entry point
  .modus/                  # Project-local MO config (see modus-dir doc)
    _global.json           # Project MCP servers (merged with base)
    _project.json          # Project metadata
    profiles/agents/       # Project-local agent profiles (override base)
    actions/               # Automated workflows
    moves/                 # User-invoked structured operations
    memory/                # Project-scoped agent memory
    ui/                    # Theme and font assets
  agent_memory/            # Agent memory MCP server (Python/uv)
  .claude/                 # Claude Code config + skills
```

## Core Primitives

MO has five primitives. They compose but don't overlap.

| Primitive | What it defines | Lives in |
|-----------|----------------|----------|
| **Session** | A single agent conversation with full event log | `harness.db` |
| **Agent Profile** | HOW an agent behaves: model, tools, prompt, permissions | `profiles/agents/*.json` or `.modus/profiles/agents/*.json` |
| **User Profile** | WHO is using the system: project scope, visible agents, memory isolation | `profiles/users/*.json` |
| **Action** | WHEN automation runs: triggers, context gathering, verify, side effects | `.modus/actions/<name>/` |
| **Move** | WHAT the user wants done now: structured submission with token-gated validation | `.modus/moves/<name>/` |

See [Primitives](./primitives.md) for how each works and how they connect.

## Config Composition

All runtime config resolves through a cascade. First non-undefined wins:

```
session override → agent profile → user profile → hardcoded default
```

MCP servers merge additively across layers:
```
built-in modus server + _global.json + .modus/_global.json + profile mcpServers
```

Agent prompts support `{{key}}` template variables sourced from `_users.json`
and overridden by user profile `templateVars`.

See [Profile System](./profile-system.md) and [Config Resolution](./config-resolution.md).

## Provider System

Providers are execution backends. Session-manager delegates to them via the
`SessionProvider` interface (defined in `providers/types.ts`).

Registered providers: `claude-code`, `codex`, `gemini-cli`, `anthropic`,
`openai`, `litellm`, `ollama`, `openrouter`.

The last five are all PI agent variants — a lightweight agent loop that works
with any OpenAI-compatible API.

See [Providers](./providers.md).

## HTTP API

All routes are defined in `harness/index.ts`. The API is RESTful JSON over
Hono. SSE is used for real-time session event streaming.

Key route groups:
- `/api/auth/*` — PIN gate, setup, verification
- `/api/profiles/*` — Agent profile CRUD
- `/api/user-profiles/*` — User profile CRUD + state
- `/api/sessions/*` — Session lifecycle, events SSE, messages, branching
- `/api/actions/*` — Action config, executions, triggers
- `/api/ui/*` — Theme/font registry, activation
- `/api/providers/*` — Provider listing, model discovery
- `/api/projects/*` — Project registry
- `/api/memories` — Memory search proxy
- `/api/browse` — Server-side folder browser
- `/health` — Watchdog endpoint

Auth: browser clients use PIN verification. Agent sessions use Bearer token
(`HARNESS_TOKEN`).

## Database

Two SQLite databases:
- `harness.db` — sessions, events, search index (FTS5), move runs, action runs
- `activity.db` — audit trail (session starts, profile switches, errors, etc.)

Sessions are never deleted, only archived via tags. Events are append-only
with optional pruning of streaming deltas.

## Frontend

React app served by Vite in dev, static build in production. Key architectural
decisions:
- URL routing via `#userProfile/sessionId` hash
- External session store (`Map<sessionId, SessionState>`) with `useSyncExternalStore`
- SSE subscription per active session for real-time events
- Event reducer transforms raw SDK events into renderable message structure
- ProfileProvider manages user profile selection and scoped visibility

## Related Docs

- [Primitives](./primitives.md) — sessions, profiles, actions, moves in detail
- [Profile System](./profile-system.md) — profile schemas and loading
- [Config Resolution](./config-resolution.md) — three-tier resolution chain
- [Providers](./providers.md) — execution backends and the SessionProvider interface
- [Actions](./actions.md) — automation: triggers, cycles, verify, artifacts
- [Moves](./moves.md) — user-invoked structured operations via modus_submit
- [Project UI](./project-ui.md) — theme/font system in .modus/ui/
- [PI Agent](./pi-agent-system.md) — the multi-provider lightweight agent
