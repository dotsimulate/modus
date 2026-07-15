---
title: MO Architecture
lastUpdated: 2026-07-07
lastCommit: bae0487
covers: harness/index.ts harness/session-manager.ts harness/db.ts harness/profiles.ts harness/profile-schemas.ts harness/providers/ harness/action-runner.ts harness/action-types.ts harness/move-runner.ts harness/move-types.ts harness/harness-context.ts harness/wake-scheduler.ts harness/client-extensions.ts harness/ui/src/ .modus/ui/extensions/
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
modus/
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
    client-extensions.ts   # Client extension discovery + precedence
    providers/             # Execution backends (see providers doc)
      registry.ts          # Provider name → implementation mapping
      types.ts             # SessionProvider interface + TurnContext
      claude-code.ts       # Claude Code SDK provider
      claude-code-pty.ts   # Persistent Claude Code CLI provider
      codex.ts             # OpenAI Codex CLI provider
      codex-cli-sdk.ts     # Codex CLI exec wrapper
      cursor.ts            # Cursor Agent CLI provider
      antigravity.ts       # Google Antigravity CLI provider
      gemini-cli.ts        # Hidden legacy paid/API/Vertex provider
      opencode.ts          # OpenCode CLI provider
      pi-agent.ts          # PI agent (multi-provider: litellm, ollama, openrouter)
      mcp-bridge.ts        # MCP server lifecycle management
      models.ts            # Model listing per provider
      tool-catalog.ts      # Shared built-in tool catalogs
      *-capabilities.ts    # Capability descriptions safe to import for listing
    action-runner.ts       # Action scheduling, execution, verify/retry
    action-types.ts        # Action type contracts
    move-runner.ts         # Move activation, token management, submit handling
    move-types.ts          # Move type contracts
    harness-context.ts     # Unified server-side capability contract (HarnessContext)
    wake-scheduler.ts      # Scheduled + event-driven session wakes (at/every/onEvent)
    modus-mcp.ts           # Built-in MCP server (modus_submit tool)
    prompt-loader.ts       # Handlebars template rendering for moves
    notify.ts              # Notification channels (egress primitive + action notify)
    watchdog.ts            # Process health monitoring
    git.ts                 # Git operations for session context
    templates/profiles/    # Shipped profile templates, seeded into ~/.modus/
    ~/.modus/profiles/     # User-owned profile config/state (see profiles doc)
      _global.json         # Shared MCP servers + provider defaults
      _users.json          # Template variable defaults
      agents/              # Agent profile JSONs
      users/               # User profile JSONs
      state/               # Runtime UI state
    ui/                    # React frontend (Vite + React)
      src/
        api/               # API client modules (one per domain)
        components/        # React components
        client-extensions.ts  # Frontend runtime for browser-side extensions
        providers/         # React context providers
        styles/            # CSS (see styling doc)
        hooks/             # Custom React hooks
        widgets/           # Dashboard widgets
        views.ts           # View registry — slugs, nav order, URL parsing
        project-ui-theme.ts  # Applies active theme/font CSS to document.head
        main.tsx           # App entry point
  .modus/                  # Project-local MO config (see modus-dir doc)
    _global.json           # Project MCP servers (merged with base)
    _project.json          # Project metadata
    profiles/agents/       # Project-local agent profiles (override base)
    actions/               # Automated workflows
    moves/                 # User-invoked structured operations
    ui/                    # Theme and font assets
      extensions/          # Project-local browser extension modules
  .claude/                 # Claude Code config + skills
```

## Core Primitives

MO has five primitives. They compose but don't overlap.

| Primitive | What it defines | Lives in |
|-----------|----------------|----------|
| **Session** | A single agent conversation with full event log | `harness.db` |
| **Agent Profile** | HOW an agent behaves: model, tools, prompt, permissions | `~/.modus/profiles/agents/*.json` or `.modus/profiles/agents/*.json` |
| **User Profile** | WHO is using the system: project scope, visible agents, memory isolation | `~/.modus/profiles/users/*.json` |
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

Registered providers: `claude-code`, `claude-code-pty`, `codex`, `cursor`,
`antigravity`, `opencode`, `litellm`, `ollama`, `openrouter`.

The last three are PI agent variants — a lightweight agent loop for
OpenAI-compatible APIs.

See [Providers](./providers.md).

## Harness Context

The **Harness Context** (`harness-context.ts:HarnessContext`) is the unified
server-side capability contract. Moves, actions, and api-handlers all drive the
same engines (session-manager, action-runner, move-runner, db, notify) through one
namespaced object — `sessions`, `channels`, `moves`, `actions`, `state`, `db`,
`secrets`, `shell`, `artifacts`, `terminal`, `log` — built by
`buildHarnessContext(self)`. Capability gating (builtin/reviewed/experimental
trust) is enforced at each namespace method boundary.

The historic surfaces (`HarnessBridge`, `MoveApiContext`, `ActionContext`, and the
api-handler signature) are now thin adapters over this contract — same call sites,
same behavior. Scheduled and event-driven session wakes are owned by
`wake-scheduler.ts:scheduleWake`. See [Harness Context](./harness-context.md) and
[Notify & Channels](./notify.md).

## HTTP API

All routes are defined in `harness/index.ts`. The API is RESTful JSON over
Hono. SSE is used for real-time session event streaming.

Key route groups:
- `/api/auth/*` — PIN gate, setup, verification
- `/api/profiles/*` — Agent profile CRUD
- `/api/user-profiles/*` — User profile CRUD + state
- `/api/sessions/*` — Session lifecycle, events SSE, messages, branching
- `/api/actions/*` — Action config, executions, triggers
- `/api/client-extensions*` — Client extension manifest + module serving
- `/api/ui/*` — Theme/font registry, activation
- `/api/providers/*` — Provider listing, model discovery
- `/api/projects/*` — Project registry
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
- ClientExtensionsBoot fetches and loads enabled browser-side extension modules

### View Registry

`ui/src/views.ts` is the single source of truth for static view slugs and helper
constructors for configured pages. Static slugs are `home` and `chat`; the only
hardcoded nav link is `chat` with label `sessions`. Config pages add
`page:<id>` views, and move pages add `move-page:<name>` views.

### Session Web

The `web` view (`components/SessionWeb.tsx`) renders a zoomable, pannable DAG
of session relationships. Three node types appear on the canvas:

- **Session** — a card for each session involved in at least one handoff or
  commit link. Laid out by handoff depth: root sessions on the left, spawned
  children stepping right. When no handoff relationships exist, the most recent
  sessions are shown as a flat grid.
- **Handoff document** — a document node placed between source and target
  sessions, representing the `.md` briefing written by a handoff move run.
- **Commit** — git commits linked to a session via `commit:<hash>` session tags,
  stacked below their associated session node.

Edges encode provenance: handoff edges connect the session that ran the move to
the session it spawned; document edges route through the handoff document node
when one exists; commit edges connect sessions to their tagged commits.

Data is fetched from three sources on load: the sessions list, recent move runs
(used to resolve handoff edges and document paths), and the git log (used to
resolve commit nodes).

Interactions: click any node to open a detail panel; double-click a session node
to open it inline in `SessionWindow`; double-click a document node to read it in
`ChatFileViewer`. The canvas supports scroll-to-zoom and drag-to-pan. A reset
button re-centers the view on the newest session.

## Related Docs

- [Primitives](./primitives.md) — sessions, profiles, actions, moves in detail
- [Profile System](./profile-system.md) — profile schemas and loading
- [Config Resolution](./config-resolution.md) — three-tier resolution chain
- [Providers](./providers.md) — execution backends and the SessionProvider interface
- [Actions](./actions.md) — automation: triggers, cycles, verify, artifacts
- [Moves](./moves.md) — user-invoked structured operations via modus_submit
- [Harness Context](./harness-context.md) — unified server-side capability contract + session wake/mailbox
- [Notify & Channels](./notify.md) — channel egress primitive, webhook body shaping, action notify
- [Pages](./pages.md) — project-scoped custom pages, layouts, and page widget references
- [Panels](./panels.md) — side-panel architecture, widget registry, and persisted panel trees
- [Project UI](./project-ui.md) — theme/font system in .modus/ui/
- [Client Extensions](./client-extensions.md) — browser-side extension discovery and runtime API
- [Plugins](./plugins.md) — machine-wide registered `.modus/` bundles
- [PI Agent](./pi-agent-system.md) — the multi-provider lightweight agent
