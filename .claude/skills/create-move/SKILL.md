---
name: create-move
description: >
  Create moves in MO (modus operandi) — the universal interaction primitive.
  Moves are composable: any move can combine API ops, widgets, pages, persistence,
  multi-agent orchestration, and different execution modes. Use when someone wants to:
  (1) create any new capability, game, tool, or workflow,
  (2) build a widget-backed interactive experience (standalone or agent-assisted),
  (3) give an agent structured API access to something via ops,
  (4) inject ambient context into every turn (persistent/RAG moves),
  (5) orchestrate multi-agent sessions (councils, debates, pipelines),
  (6) create a full page in the app nav (memory browser, dashboards),
  (7) spawn background/branch sessions for heavy work.
  Each move is a directory with move.json + context.ts inside .modus/moves/<name>/.
  TRIGGER on: "create a move", "new move", "build a move", "add a capability",
  "make a game", "interactive move", "api contract", "agent tool", "ambient move",
  "persistent move", "widget", "full page", "multi-agent", "council-like".
---

# Create Move

Moves are the universal interaction primitive in MO. They can be anything:
games, tools, ambient context injectors, full app pages, multi-agent orchestrators,
media pipelines, or simple prompt injections.

- **Profiles** define HOW an agent behaves
- **Actions** define WHEN automation runs
- **Moves** define WHAT happens — from a one-line context injection to a full interactive app

Each move is a directory:

```
.modus/moves/<name>/
  move.json     <- declaration (composable facets — see below)
  context.ts    <- gather() + optional handlers/onSubmit/onAssistantTurn
  widget.tsx    <- optional UI component
  widget.css    <- optional widget styles (auto-loaded by harness when present)
  state/        <- auto-created for persisted API state
```

Built-in moves: `harness/moves/`. Project-local: `.modus/moves/` (overrides built-ins by name).

## Workflow

1. **Read 1-2 existing moves** similar to what you're building (see examples at bottom)
2. **Determine which facets apply** (see Composable Facets below)
3. Read the relevant reference(s) for each facet
4. Design move.json combining the facets
5. Write context.ts (gather + whatever the facets require)
6. Write widget.tsx if the move has a UI surface
7. Output to `.modus/moves/<name>/`

## Composable Facets

Moves are not exclusive categories — they combine **facets**. For each move, decide
which facets apply. Most real moves use 2-4 facets together.

### 1. Agent Interaction — how does the agent participate?

| Pattern | When | Key fields | Reference |
|---------|------|------------|-----------|
| **Gather-only** | Just inject context, no submission | `submit.required: false` | Below |
| **Submit** | Agent does work, calls modus_submit once | `submit.required: true`, optional `schema`/`schemaHint` | Below |
| **API contract** | Agent interacts repeatedly via named ops | `api` block + `handlers` in context.ts | [references/api-contract-moves.md](references/api-contract-moves.md) |
| **No agent** | Widget-only, agent uninvolved | `widget.mountOnAttach: true`, no gather activation | [references/widget-moves.md](references/widget-moves.md) |

### 2. UI Surface — does it have a visual interface?

| Pattern | When | Key fields | Reference |
|---------|------|------------|-----------|
| **No UI** | Headless — prompt injection or background work | Omit `widget` and `page` | — |
| **Widget (agent-first)** | UI alongside agent work | `widget` block, `autoOpen: true` | [references/widget-moves.md](references/widget-moves.md) |
| **Widget (standalone)** | UI opens before agent, user configures first | `widget.mountOnAttach: true` + `api` | [references/widget-moves.md](references/widget-moves.md) |
| **Full page** | Owns a page in the app nav | `page` block | [references/widget-moves.md](references/widget-moves.md) (page section) |

### 3. Lifecycle — how long does it live?

| Pattern | When | Key fields | Reference |
|---------|------|------------|-----------|
| **One-shot** | Activate, do work, done | Default behavior | — |
| **Persistent/ambient** | Re-runs gather() every turn | `persistent: true` | [references/persistent-moves.md](references/persistent-moves.md) |
| **Multi-instance** | Resumable instances with state | `api.state.persist: true` | [references/api-contract-moves.md](references/api-contract-moves.md) |

### 4. Execution Mode — where does it run?

| Mode | Behavior | Use case |
|------|----------|----------|
| `inline` (default) | Current agent handles it | Games, tools, prompts, widgets |
| `branch` | Spawns a sibling session | Heavy tasks, different profile |
| `background` | Fire-and-forget with status tracking | Long-running work |

### 5. Multi-Agent — does it orchestrate other agents?

| Pattern | When | Key | Reference |
|---------|------|-----|-----------|
| **Single agent** | One agent, one session | Default | — |
| **Orchestrated** | Spawns/manages multiple sessions | `harness.createSession` + watchers | [references/multi-agent-moves.md](references/multi-agent-moves.md) |

**Common compositions** — see [references/composition-patterns.md](references/composition-patterns.md)
for real examples showing how facets combine.

## Quick Reference: Minimal Examples

### Gather-only (simplest possible move)

```json
{
  "name": "my-context",
  "label": "My Context",
  "description": "Inject context into the session",
  "icon": "eye",
  "submit": { "required": false },
  "session": { "afterSubmit": "continue" },
  "tags": ["context"]
}
```

```ts
import type { MoveContext } from "../../../harness/move-types";

export async function gather(ctx: MoveContext): Promise<string | null> {
  const data = await ctx.run("git diff HEAD~3..HEAD --stat");
  if (!data.trim()) return null; // gather-bail: nothing to inject
  return `Recent changes:\n\`\`\`\n${data}\n\`\`\``;
}
```

### API contract (agent interacts via ops)

```json
{
  "name": "my-tool",
  "label": "My Tool",
  "description": "Give the agent access to a tool",
  "icon": "wrench",
  "api": {
    "tokenPrefix": "mytool",
    "ops": {
      "do-thing": {
        "description": "Do the thing",
        "schema": {
          "type": "object",
          "properties": { "input": { "type": "string" } },
          "required": ["input"]
        }
      },
      "status": { "description": "Check current status" }
    },
    "state": { "persist": true }
  },
  "submit": { "required": false },
  "session": { "afterSubmit": "continue" },
  "tags": ["tool"]
}
```

```ts
import type { MoveContext, MoveApiContext, MoveApiHandler } from "../../../harness/move-types";

export async function gather(ctx: MoveContext): Promise<string> {
  return `You have access to My Tool.\n\nToken: \`${ctx.apiToken}\`\n\n...instructions...`;
}

export const handlers: Record<string, MoveApiHandler> = {
  "do-thing": async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const state = await ctx.state.get<{ count: number }>() ?? { count: 0 };
    await ctx.state.set({ count: state.count + 1 });
    return { ok: true, message: `Done (${state.count + 1} times)` };
  },
  status: async (ctx: MoveApiContext) => {
    const state = await ctx.state.get<{ count: number }>();
    return { ok: true, message: `Count: ${state?.count ?? 0}` };
  },
};
```

### Persistent/ambient (context every turn)

```json
{
  "name": "my-ambient",
  "label": "My Ambient Context",
  "description": "Inject context into every turn",
  "icon": "radio",
  "persistent": true,
  "tags": ["ambient"]
}
```

```ts
import type { MoveContext } from "../../../harness/move-types";

export async function gather(ctx: MoveContext): Promise<string | null> {
  const status = await ctx.run("bun test --reporter=summary 2>&1 | tail -5");
  if (status.includes("0 fail")) return null; // bail — all passing, nothing to inject
  return `## Test Status\n\`\`\`\n${status}\n\`\`\``;
}
```

## Key Rules

- **context.ts imports**: `import type { ... } from "../../../harness/move-types"` for types.
  Import db functions directly from `"../../../harness/db"` when needed.
- **gather() returns `string | null`** — string injects into the session, `null` bails (skips).
- **API tokens**: `ctx.apiToken` is auto-created for API contract moves. Pass it in gather().
- **State**: `ctx.state` is NOT available in gather(). Use `ctx.run()` or direct imports.
  Handlers get `ctx.state.get<T>()` / `ctx.state.set(value)` / `ctx.state.delete()`.
- **Notify**: `ctx.notify(message)` pushes a message into the agent's session from a handler.
  Typed: `ctx.notify("msg", { type: "event-name", ...payload })`.
- **Caller**: `ctx.caller` is `"agent"` or `"user"`. Gate ops accordingly — default deny for
  sensitive operations.
- **Inputs**: Declared in move.json `inputs[]`, accessed via `ctx.inputs` in gather().
- **DB**: `ctx.db` in gather() provides `listSessions()`, `getSession()`, `searchSessions()`,
  `getMoveHistory()`. Handlers import db functions directly from `"../../../harness/db"`.
- **Shell**: `ctx.run(cmd)` runs a command and returns stdout.
- **Direct imports**: context.ts runs in the harness process — it can import any harness module
  (e.g., `getSessionUiState` from db, `queryTouches` from trace).
- **Widget CSS**: Put styles in `widget.css` next to `widget.tsx`. The harness auto-loads it
  via `/api/moves/:name/widget.css` when the widget mounts — no harness imports needed.
  Use `var(--*)` color tokens, `calc(Npx * var(--font-scale, 1))` for font sizes,
  and follow the compact panel guide patterns.
- **No core edits needed** — moves are self-contained in `.modus/moves/<name>/`.

## MoveContext (gather/onSubmit)

```ts
interface MoveContext {
  moveName: string;
  sessionId: string;
  session: {
    lastAssistantText: string;
    seq: number;
    profile: string | undefined;
    exchangeCount: number;
  };
  cwd: string;
  userProfile: string | undefined;
  inputs: Record<string, unknown>;
  db: MoveDB;
  run: (cmd: string) => Promise<string>;
  harness: HarnessBridge;           // createSession, sendMessage, triggerAction, notify
  meta: (key: string, value: unknown) => void;
  token?: string;                   // one-shot submit token
  schema?: string;                  // schema hint
  date?: string;                    // current ISO date
  apiToken?: string;                // API contract token (mapi- prefix)
  instanceId?: string;              // API instance ID
}
```

## MoveApiContext (handlers)

```ts
interface MoveApiContext {
  instanceId: string;
  sessionId: string;
  moveName: string;
  cwd: string;
  caller: "agent" | "user";
  state: { get<T>(): Promise<T | undefined>; set(v: unknown): Promise<void>; delete(): Promise<void> };
  notify: (message: string, emit?: { type: string; [key: string]: unknown }) => void;
}
```

## MoveModule (full context.ts export surface)

```ts
interface MoveModule {
  gather?(ctx: MoveContext): Promise<string | null>;
  onSubmit?(ctx: MoveContext, data: Record<string, unknown>, inputs: Record<string, unknown>): Promise<SubmitResult>;
  onAssistantTurn?(ctx: MoveAssistantTurnContext): Promise<void>;
  handlers?: Record<string, MoveApiHandler>;
  listInstances?(states: Array<{ instanceId: string; state: unknown }>): Array<{ label: string; value: string }>;
}
```

- **onAssistantTurn** — react to each assistant response on an active instance.
  See [references/multi-agent-moves.md](references/multi-agent-moves.md).
- **listInstances** — customize how saved instances appear in the resume picker.

## Before Building: Read Existing Moves

**Always** read 1-2 existing moves similar to what you're building before writing code.
Moves in `.modus/moves/` are the best reference. Key examples by facet:

| Move | Facets | Good reference for |
|------|--------|--------------------|
| `open-tabs` | persistent, gather-bail | Simplest ambient move |
| `chess` | API contract, mountOnAttach widget | Widget-first game loop |
| `council` | API contract, widget, multi-agent, onAssistantTurn | Multi-session orchestration |
| `memory` | API contract, widget, full page | Page + widget + ops |
| `fal-image` | API contract, mountOnAttach, budget/security | Access control patterns |
| `animate-this` | API contract, widget, submit, branch pipeline | Media pipeline with inputs |
