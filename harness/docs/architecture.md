---
title: MO Architecture
lastUpdated: 2026-08-26
lastCommit: bae0487
covers: harness/index.ts harness/session-manager.ts harness/db.ts harness/activity.ts harness/terminal-db.ts harness/workspace-history.ts harness/workspace-history-index.ts harness/app-paths.ts harness/database-paths.ts harness/modus-home.ts harness/vault-policy.ts harness/vault-registry.ts harness/vault-api.ts harness/profiles.ts harness/profile-schemas.ts harness/providers/ harness/action-runner.ts harness/action-types.ts harness/move-runner.ts harness/move-types.ts harness/harness-context.ts harness/wake-scheduler.ts harness/client-extensions.ts harness/conversation-lenses.ts harness/ui/src/ .modus/ui/extensions/ .modus/lenses/ .modus/projections/
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

In path examples, `<current-home>` is Main's Modus home for Main or the selected
registered folder for a named Vault. Vault-owned config never falls back to Main.

## Repo Structure

```
modus/
  harness/                 # The application
    index.ts               # Hono HTTP server — all API routes
    session-manager.ts     # Session lifecycle, SSE, message routing
    profiles.ts            # Qualified profile loading, global merging, template vars
    profile-schemas.ts     # JSON Schema validation for profiles
    modus-plugins.ts       # Plugin manifests, registration, built-in core descriptor
    plugin-settings.ts     # User/project/global plugin setting storage
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
      codex-app-server.ts  # Codex stdio turn transport with acknowledged steering
      cursor.ts            # Cursor Agent CLI provider
      antigravity.ts       # Google Antigravity CLI provider
      gemini-cli.ts        # Hidden legacy paid/API/Vertex provider
      opencode.ts          # OpenCode CLI provider
      grok-build.ts        # xAI Grok Build ACP provider
      grok-build-acp.ts    # newline-delimited JSON-RPC transport
      pi-agent.ts          # PI agent (built-in + user/plugin declarative providers)
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
    git.ts                 # Git operations for session context
    plugin.json            # Built-in modus-core manifest over resources in place
    templates/profiles/    # Built-in merged profiles + home rehydration source
    <current-home>/profiles/ # Vault-owned profile config/state (see profiles doc)
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
    profiles/agents/       # Project-local agent profiles (qualified project:<name>)
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
| **Agent Profile** | HOW an agent behaves: model, tools, prompt, permissions | `<current-home>/profiles/agents/*.json` or `.modus/profiles/agents/*.json` |
| **User Profile** | WHO is using the system: project scope, visible agents, memory isolation | `<current-home>/profiles/users/*.json` |
| **Action** | WHEN automation runs: triggers, context gathering, verify, side effects | `.modus/actions/<name>/` |
| **Move** | WHAT the user wants done now: structured submission with token-gated validation | `.modus/moves/<name>/` |

A **skill** is not one of these. It is packaged text an agent can load —
knowledge, not protocol — with no enforcement, state, or widget. Skills exist so
authored knowledge can leave Modus; moves cannot. See [Skills](./skills.md).

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
`grok-build`, `opencode`, `openai-compat`, `ollama`, `openrouter`,
plus current-Vault and plugin declarative PI providers. `litellm` remains an
accepted compatibility alias of `openai-compat`. `antigravity` and `gemini-cli`
are hidden: reachable when a profile names one, absent from every listing (see
`providers.md` § Hidden providers).

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
- `/api/conversation-lenses` and `/api/conversation-projections/:id/module` —
  source-aware conversation recipes and trusted-local projection modules
- `/api/ui/*` — Theme/font registry, activation
- `/api/providers/*` — Provider listing, model discovery
- `/api/projects/*` — Project registry
- `/api/browse` — Server-side folder browser (also canonicalizes an OS-dialog pick)
- `/health` — Watchdog endpoint

Auth: browser clients use PIN verification. Operator clients use the
`HARNESS_TOKEN` bearer. Provider sessions receive a separate in-memory bearer
that is valid only for their exact built-in Modus MCP route and is revoked with
the provider session.

Credentials normally travel on the `Authorization` header. A small set of GET
routes additionally accept a **bounded browser-session** token in the query
string (`allowsQueryCredential` in `index.ts`), because `<img>`, `<audio>` and
`EventSource` cannot set headers. The `HARNESS_TOKEN` supervisor bearer is never
accepted there — it authorizes everything and cannot be revoked without a
restart.

`GET /api/file/raw` is deliberately **not** in that set. It reads any path on the
machine, so a URL for it must not carry a credential good for the rest of the
API. It takes a **ticket** instead: `POST /api/file/ticket` is
header-authenticated and returns a random, in-memory value bound to one resolved
path and valid for `FILE_TICKET_TTL_MS` (`file-ticket.ts`). A ticket is not a
bearer — it authorizes that one file read and nothing else, and it is reusable
within its window because a browser legitimately re-requests the same image.

## Writable roots and databases

`MODUS_HOME` defaults to `~/.modus` for Main. Main owns its complete home and
`vaults.json`, whose named rows point at independent folders. A named backend
requires both `MODUS_INSTANCE=<slug>` and an absolute `MODUS_VAULT_ROOT` from a
trusted launcher. For that process `modusHome` and `writableRoot` are exactly
the registered folder; the slug never derives or appends a path. The root contains:

- `vault-manifest.json` - versioned folder identity marker
- `profiles/`, `projects.json`, `plugins.json`, `providers/`, `skills/` - named authored config
- `secrets.env` - named secrets and optional browser PIN
- `vault.json` — per-Vault execution and egress policy
- `data/` — SQLite databases
- `logs/` — backend and desktop logs
- `runtime/` — ready/supervisor records and other live coordination files
- `cache/` — disposable runtime cache
- `history/` — workspace-history shadow repositories and indexes
- `checkpoints/` — managed checkpoints

The named temp root is `<MODUS_VAULT_ROOT>/tmp`. `default` and an unset value
select Main and preserve its existing roots.
Instance names accept only letters, numbers, dots, underscores, and hyphens;
they are canonicalized to lowercase for identity. Display casing belongs in the
Vault registry `name`.
`MODUS_DATA_DIR`, `MODUS_LOGS_DIR`, `MODUS_RUNTIME_DIR`, and `MODUS_CACHE_DIR`
may override named subdirectories only when they remain strict descendants of
the registered root. Desktop and CLI launchers remove inherited global values.
Named profiles, projects, plugins, skills, secrets, databases, runtime state,
history, checkpoints, and Modus Brain feedback never fall back to Main.
See [Vaults](./vaults.md) for registry, policy, API, and CLI semantics.

The primary `data/` directory contains three SQLite databases:

- `harness.db` — sessions, durable events, semantic messages, FTS search,
  moves, actions, missions, artifacts, wakes, and trace rows
- `activity.db` — high-volume audit/resource activity with an independent
  retention lifecycle
- `terminal.db` — terminal metadata; PTY output itself is streamed, not stored

Workspace history additionally owns one `index.sqlite` inside each shadow
history root under `<writableRoot>/history/`. The history and checkpoint roots
follow Vault selection rather than the `data/` override.

Sessions are archived via tags rather than normally deleted. Durable event rows
are append-only except for explicit maintenance such as streaming-delta pruning.

## Frontend

React app served by Vite in dev, static build in production. Key architectural
decisions:
- URL routing via `#userProfile/sessionId` hash
- External session store (`Map<sessionId, SessionState>`) with `useSyncExternalStore`
- SSE subscription per active session for real-time events
- One elected browser tab owns the global session-index stream and fallback poll;
  sibling tabs receive snapshots and patches through `BroadcastChannel`.
- Returning from browser suspension (`visibilitychange`, page restore, focus, or
  network recovery) forces an authoritative session-index refresh and reopens
  both the global lifecycle stream and active transcript stream. This is required
  on mobile, where backgrounding can freeze stale timers and dead fetches for hours.
- Event reducer transforms raw SDK events into renderable message structure
- ProfileProvider manages user profile selection and scoped visibility
- ClientExtensionsBoot fetches and loads enabled browser-side extension modules

### Backend target handoff

The frontend routes every API call through one live `BACKEND_TARGET` record
(`ui/src/backendTarget.ts`). Its `mode` is a capability decision, not just a display label:

| Mode | Meaning |
|---|---|
| `browser` | Same-origin web UI. `apiBase` is empty and there is no native desktop authority. |
| `managed-local` | A loopback backend supervised by this Tauri desktop process, including a selected named Vault. |
| `external-local` | A backend already running on the same machine, discovered rather than supervised by this window. |
| `remote` | A backend on another host. Backend paths and backend-supplied code must not be treated as local desktop resources. |

The desktop/bootstrap boundary hands the resolved target to the web bundle through query
parameters before React mounts:

| Parameter | Contract |
|---|---|
| `modusTarget` | Normalized HTTP origin used as `apiBase`. |
| `modusTargetId` | Stable client-side identity used to namespace saved state and detect backend replacement. |
| `modusTargetMode` | One of the four modes above. An explicit URL without a valid mode defaults to `external-local`. |
| `modusTargetLabel` | Human-readable connection label; it grants no authority. |
| `modusVault` | Named-Vault slug, retained only for `managed-local` targets. |
| `modusDiscover` | Bootstrap request (`local` or `external`) that is replaced with the concrete target after discovery. |

`main.tsx` performs native bootstrap or local discovery, probes the selected backend, rejects
an unexpected backend-identity change, rewrites the query to the concrete target, and then
calls `configureBackendTarget`. These parameters select an address and client identity; they
do not bypass the PIN/session or bearer-token authentication described above.

Client-local filesystem features must also agree with the target mode. A Tauri native folder
picker, reveal, or open-path action is valid only for `managed-local` and `external-local`,
where client and backend refer to the same host filesystem. `remote` and `browser` use the
backend-side browser/paths instead. The shared predicate is
`nativePickerApplies(isTauriRuntime(), BACKEND_TARGET.mode)` in `ui/src/native-picker.ts`.

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
- [Skills](./skills.md) — portable packaged instructions, attachment, and per-provider delivery
- [Harness Context](./harness-context.md) — unified server-side capability contract + session wake/mailbox
- [Notify & Channels](./notify.md) — channel egress primitive, webhook body shaping, action notify
- [Pages](./pages.md) — project-scoped custom pages, layouts, and page widget references
- [Conversation Lenses](./conversation-lenses.md) — selectable chat-route recipes, safety fallback, and authored projections
- [Panels](./panels.md) — side-panel architecture, widget registry, and persisted panel trees
- [Project UI](./project-ui.md) — theme/font system in .modus/ui/
- [Client Extensions](./client-extensions.md) — browser-side extension discovery and runtime API
- [Plugins](./plugins.md) — Vault-registered external `.modus/` bundles
- [PI Agent](./pi-agent-system.md) — the multi-provider lightweight agent
