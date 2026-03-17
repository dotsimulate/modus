# API Contract Moves — Full Reference

API contract moves give an agent persistent, token-authenticated access to a set of operations.
The agent calls ops via `modus_submit` with an API token. Handlers manage state and can notify
the agent of events (e.g., opponent's turn in a game).

## move.json — api block

```json
{
  "api": {
    "tokenPrefix": "chess",
    "ops": {
      "move": {
        "description": "Submit a chess move in SAN notation",
        "schema": {
          "type": "object",
          "properties": { "move": { "type": "string" } },
          "required": ["move"]
        }
      },
      "board": { "description": "View current board state" },
      "resign": { "description": "Resign the game" }
    },
    "state": { "persist": true }
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `tokenPrefix` | string | Token prefix. Tokens are `mapi-{prefix}-{instanceId}` |
| `ops` | Record | Named operations. Each has `description` and optional `schema` |
| `state.persist` | boolean | `true` = state persisted to disk (survives restart). `false` = in-memory only |

## context.ts — handler pattern

```ts
import type { MoveContext, MoveApiContext, MoveApiHandler } from "../../../harness/move-types";

// State type — define the shape of your persisted state
interface MyState {
  score: number;
  history: string[];
}

// gather() — called once on activation, returns prompt for the agent
export async function gather(ctx: MoveContext): Promise<string> {
  // ctx.apiToken — the token the agent uses with modus_submit
  // ctx.instanceId — unique instance ID (can resume across sessions)
  // ctx.db — read-only database access
  // ctx.run — shell command execution
  // ctx.cwd — working directory
  // ctx.userProfile — user profile name
  // ctx.inputs — user form inputs from move.json inputs[]
  return `Instructions for the agent.\n\nToken: \`${ctx.apiToken}\`\n\n...`;
}

// handlers — one per op declared in move.json
export const handlers: Record<string, MoveApiHandler> = {
  "op-name": async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    // Read state
    const state = await ctx.state.get<MyState>();

    // Validate input
    const input = data.someField;
    if (!input) return { ok: false, error: "someField is required" };

    // Do work, update state
    const newState: MyState = { score: 1, history: ["first"] };
    await ctx.state.set(newState);

    // Notify agent (pushes message into their session)
    ctx.notify("Something happened");

    // Notify with structured payload (agent sees: [modus:event-type] {...}\nmessage)
    ctx.notify("Event occurred", { type: "game-event", detail: "..." });

    // Return result — agent sees this as the modus_submit response
    return { ok: true, message: "Success" };
    // or: return { ok: false, error: "What went wrong" };
  },
};
```

## Caller distinction

`ctx.caller` is `"agent"` when called via modus_submit, `"user"` when called via widget.
Use this to gate operations:

```ts
// Only user can reset
if (ctx.caller === "agent") return { ok: false, error: "Only user can reset" };

// Notify the other side on state changes
if (ctx.caller === "user") ctx.notify("User made a move");
```

## Accessing the database from handlers

Handlers get `ctx.sessionId` but NOT `ctx.db`. To query sessions/messages from handlers,
import db functions directly:

```ts
import { getSession, searchSessions, getSessionMessages } from "../../../harness/db";

// In a handler:
const session = getSession(ctx.sessionId);
const hits = searchSessions("query", 10);
```

## Stateless vs stateful

- **Stateful** (games, pets): `state.persist: true`, use `ctx.state.get/set` in every handler
- **Stateless** (search, tools): `state.persist: false`, handlers just query and return results.
  State API is still available for caching but won't survive restart.

## Instance lifecycle

- Each activation creates a new instance with a unique `instanceId`
- Token format: `mapi-{tokenPrefix}-{instanceId}`
- Persisted state lives in `.modus/moves/<name>/state/{instanceId}.json`
- Instances can be resumed across sessions (agent provides the token again)

## Scoping to caller context

Handlers don't get `cwd` or `userProfile` directly. To scope queries to the calling
session's project, look up the session:

```ts
function getCallerScope(ctx: MoveApiContext) {
  const s = getSession(ctx.sessionId);
  return { cwd: s?.cwd, userProfile: s?.user_profile };
}
```

## Complete move.json schema for API moves

```json
{
  "name": "string (required)",
  "label": "string (required, display name)",
  "description": "string (required)",
  "icon": "string (optional, icon name)",
  "mode": "inline | branch | background",
  "inputs": [],
  "api": {
    "tokenPrefix": "string",
    "ops": {
      "op-name": {
        "description": "string",
        "schema": { "JSON Schema object (optional)" }
      }
    },
    "state": { "persist": true }
  },
  "submit": { "required": false },
  "session": { "afterSubmit": "continue | end | switch:<moveName>" },
  "widget": {
    "component": "widget.tsx",
    "panel": "right",
    "label": "Tab Label",
    "icon": "icon-name",
    "autoOpen": true
  },
  "tags": ["string"]
}
```
