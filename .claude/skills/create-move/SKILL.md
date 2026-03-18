---
name: create-move
description: >
  Create moves in MO (modus operandi) — the user-facing invocation primitive.
  Moves define WHAT the user wants done right now. Use when someone wants to:
  (1) create a new move (game, tool, capability, workflow),
  (2) give an agent API access to something via ops (API contract moves),
  (3) build a widget-backed interactive experience,
  (4) create a gather-only prompt injection move,
  (5) create a branch/background move that spawns a separate session.
  Each move is a directory with move.json + context.ts inside .modus/moves/<name>/.
  TRIGGER on: "create a move", "new move", "build a move", "add a capability",
  "make a game", "interactive move", "api contract", "agent tool".
---

# Create Move

Moves are the user-facing invocation primitive in MO:
- **Profiles** define HOW an agent behaves
- **Actions** define WHEN automation runs
- **Moves** define WHAT the user wants done right now

Each move is a directory:

```
.modus/moves/<name>/
  move.json     <- declaration (API, widget, inputs, execution mode)
  context.ts    <- gather() + optional handlers/onSubmit
  widget.tsx    <- optional UI component (if widget declared)
  state/        <- auto-created for persisted API state
```

Built-in moves live in `harness/moves/`. Project-local moves live in `.modus/moves/` and override built-ins with the same name.

## Workflow

1. Determine what kind of move (see decision tree)
2. Read the relevant reference for schema details
3. Design the move.json config
4. Write context.ts (gather + handlers or onSubmit)
5. Output both files to `.modus/moves/<name>/`

## Decision Tree

**"Agent needs to interact with something repeatedly via API ops"** (games, tools, capabilities)
  → **API contract move**. Read [references/api-contract-moves.md](references/api-contract-moves.md).
  Key: `api` block in move.json, `handlers` export in context.ts.
  Examples: chess, wordle, nano-banana.

**"Just inject context/instructions into the session"** (prompt-only, no submission needed)
  → **Gather-only move**. Simplest type. `gather()` returns a prompt string. No API, no submit.
  `submit.required: false`, `session.afterSubmit: "continue"`.

**"Agent should do work and report back with structured output"** (one-shot tasks)
  → **Submit move**. `gather()` provides instructions, agent calls `modus_submit` once.
  `submit.required: true`, optional `schema`/`schemaHint`, `onSubmit()` in context.ts.

**"Spawn a separate session for the work"** (heavy tasks, different profile)
  → **Branch/background move**. `mode: "branch"` or `"background"`, set `agentProfile`.
  Read [references/branch-moves.md](references/branch-moves.md) (same patterns as submit moves but spawned).

**"Standalone tool/UI that optionally involves the agent"** (widget-first)
  → **mountOnAttach move**. Widget opens immediately on attach, no agent until user triggers.
  Read [references/widget-moves.md](references/widget-moves.md).
  Key: `widget.mountOnAttach: true`, `api` block required, `activate()` prop in widget.
  Examples: calendar, chess (color selection → start game).

**"Needs a UI widget alongside the agent"** (agent-first with visual feedback)
  → Any move type can add a `widget` block. Same reference: [references/widget-moves.md](references/widget-moves.md).

## Three Execution Modes

| Mode | Behavior | Use case |
|------|----------|----------|
| `inline` (default) | Current agent handles it | Games, tools, capabilities, prompts |
| `branch` | Spawns a sibling session | Heavy tasks, different agent profile |
| `background` | Fire-and-forget with status tracking | Long-running work |

## Quick Examples

### Minimal gather-only move

```json
{
  "name": "code-review-context",
  "label": "Code Review Context",
  "description": "Inject recent git diff as context for code review",
  "icon": "eye",
  "mode": "inline",
  "inputs": [],
  "submit": { "required": false },
  "session": { "afterSubmit": "continue" },
  "tags": ["dev"]
}
```

```ts
import type { MoveContext } from "../../../harness/move-types";

export async function gather(ctx: MoveContext): Promise<string> {
  const diff = await ctx.run("git diff HEAD~3..HEAD --stat");
  return `Review these recent changes:\n\`\`\`\n${diff}\n\`\`\``;
}
```

### API contract move (capability)

```json
{
  "name": "my-tool",
  "label": "My Tool",
  "description": "Give the agent access to a tool via API ops",
  "icon": "wrench",
  "mode": "inline",
  "inputs": [],
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
    // ctx.state.get/set for state, ctx.notify() to message agent, ctx.caller for who called
    return { ok: true, message: "Done" };
  },
  status: async (ctx: MoveApiContext) => {
    return { ok: true, message: "All good" };
  },
};
```

### Widget-first (mountOnAttach) move

```json
{
  "name": "my-widget",
  "label": "My Widget",
  "description": "Standalone widget, optionally brings in agent",
  "icon": "layout",
  "mode": "inline",
  "inputs": [],
  "api": {
    "tokenPrefix": "mywid",
    "ops": {
      "get-state": { "description": "Read current state" },
      "configure": {
        "description": "Set config before activation",
        "schema": {
          "type": "object",
          "properties": { "key": { "type": "string" }, "value": { "type": "string" } },
          "required": ["key", "value"]
        }
      }
    },
    "state": { "persist": true }
  },
  "submit": { "required": false },
  "session": { "afterSubmit": "continue" },
  "widget": {
    "component": "widget.tsx",
    "panel": "right",
    "label": "My Widget",
    "icon": "layout",
    "autoOpen": true,
    "mountOnAttach": true
  },
  "tags": ["widget-first"]
}
```

Widget receives `activate` prop — call it to trigger gather() + agent involvement.
No composer chip. No agent until the widget says so. See [references/widget-moves.md](references/widget-moves.md).

## Key Rules

- **context.ts imports**: Use `import type { ... } from "../../../harness/move-types"` for types. Import db functions directly from `"../../../harness/db"` when needed.
- **gather() returns the prompt string** — this is injected into the session.
- **API tokens**: `ctx.apiToken` is auto-created for API contract moves. Pass it to the agent in gather().
- **State**: `ctx.state.get<T>()` / `ctx.state.set(value)` / `ctx.state.delete()`. Persist to disk with `state.persist: true`.
- **Notify**: `ctx.notify(message)` pushes a message into the agent's session from a handler.
- **Caller**: `ctx.caller` is `"agent"` (via modus_submit) or `"user"` (via widget). Gate ops accordingly.
- **Inputs**: Declared in move.json `inputs[]`, accessed via `ctx.inputs` in gather().
- **DB access**: `ctx.db` in gather() provides `listSessions()`, `getSession()`, `searchSessions()`, `getMoveHistory()`.
- **Shell access**: `ctx.run(cmd)` in gather() runs a shell command and returns stdout.
- **Widget**: Declare in move.json, implement as widget.tsx in the move directory.
- **No core edits needed** — moves are self-contained in `.modus/moves/<name>/`.

## MoveApiContext (for handlers)

```ts
interface MoveApiContext {
  instanceId: string;
  sessionId: string;
  moveName: string;
  caller: "agent" | "user";
  state: { get<T>(): Promise<T | undefined>; set(v: unknown): Promise<void>; delete(): Promise<void> };
  notify: (message: string, emit?: { type: string; [key: string]: unknown }) => void;
}
```

## MoveContext (for gather/onSubmit)

```ts
interface MoveContext {
  moveName: string;
  sessionId: string;
  cwd: string;
  userProfile: string | undefined;
  inputs: Record<string, unknown>;
  db: MoveDB;
  run: (cmd: string) => Promise<string>;
  harness: HarnessBridge;
  meta: (key: string, value: unknown) => void;
  token?: string;        // one-shot submit token
  schema?: string;       // schema hint
  date?: string;         // current ISO date
  apiToken?: string;     // API contract token (mapi- prefix)
  instanceId?: string;   // API instance ID
}
```

For detailed schemas: [references/api-contract-moves.md](references/api-contract-moves.md)
