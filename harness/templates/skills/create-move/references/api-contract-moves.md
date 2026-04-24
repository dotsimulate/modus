# API Contract Moves — Full Reference

API contract moves give an agent persistent, token-authenticated access to a set of operations.
The agent calls ops via `modus_submit` with an API token. Handlers manage state and can notify
the agent of events.

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

interface MyState {
  score: number;
  history: string[];
}

export async function gather(ctx: MoveContext): Promise<string> {
  return `Instructions for the agent.\n\nToken: \`${ctx.apiToken}\`\n\n...`;
}

export const handlers: Record<string, MoveApiHandler> = {
  "op-name": async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const state = await ctx.state.get<MyState>();
    const input = data.someField;
    if (!input) return { ok: false, error: "someField is required" };

    await ctx.state.set({ score: 1, history: ["first"] });

    // Notify agent (pushes message into session)
    ctx.notify("Something happened");
    // With structured payload: agent sees [modus:event-type] {...}\nmessage
    ctx.notify("Event occurred", { type: "game-event", detail: "..." });

    return { ok: true, message: "Success" };
  },
};
```

## Caller distinction and security

`ctx.caller` is `"agent"` (via modus_submit) or `"user"` (via widget).

**Default-deny for sensitive operations:**

```ts
// Only user can reset
if (ctx.caller === "agent") return { ok: false, error: "Only user can reset" };

// Notify the other side on state changes
if (ctx.caller === "user") ctx.notify("User made a move");
```

**Budget and access control pattern** (proven in fal-image):

```ts
interface KeyRecord {
  instanceId: string;
  used: number;
  budget: number;
  revoked: boolean;
}

// In handler — reject if no record, revoked, or over budget
const key = keys.find(k => k.instanceId === ctx.instanceId);
if (!key) return { ok: false, error: "No key issued" };
if (key.revoked) return { ok: false, error: "Key revoked" };
if (key.used >= key.budget) return { ok: false, error: "Budget exhausted" };
```

**Security rules (learned from production):**
- Never store full API tokens on disk — display hints only
- The harness token registry is in-memory; resets on restart (file state survives, tokens don't)
- Default-deny: if no record exists for a caller, reject
- Param locking: user can lock parameters so agent overrides are silently corrected

## Handler data access

Handlers are self-contained. Use `ctx.state` for structured data across calls
and read/write files under `ctx.cwd` with `fs` for anything else.

## Stateless vs stateful

- **Stateful** (games, registries): `state.persist: true`, `ctx.state.get/set` in every handler
- **Stateless** (search, tools): `state.persist: false`, handlers query and return. State available
  for caching but won't survive restart.

## Instance lifecycle

- Each activation creates a new instance with a unique `instanceId`
- Token format: `mapi-{tokenPrefix}-{instanceId}`
- Persisted state: `.modus/moves/<name>/state/{instanceId}.json`
- Instances can be resumed across sessions
- Customize resume picker with `listInstances`:

```ts
export function listInstances(states: Array<{ instanceId: string; state: unknown }>) {
  return states.map(({ instanceId, state }) => ({
    label: (state as any)?.title ?? instanceId,
    value: instanceId,
  }));
}
```

## Complete move.json schema for API moves

```json
{
  "name": "string (required)",
  "label": "string (required)",
  "description": "string (required)",
  "icon": "string (optional)",
  "mode": "inline | branch | background",
  "inputs": [],
  "api": {
    "tokenPrefix": "string",
    "ops": {
      "op-name": {
        "description": "string",
        "schema": { "JSON Schema (optional)" }
      }
    },
    "state": { "persist": true }
  },
  "submit": { "required": false },
  "session": { "afterSubmit": "continue | end | switch:<moveName>" },
  "widget": { "..." },
  "page": { "..." },
  "tags": ["string"]
}
```
