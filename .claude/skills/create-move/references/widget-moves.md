# Widget-First (mountOnAttach) Moves — Full Reference

Widget-first moves open their widget immediately when attached to the composer,
BEFORE any message is sent or agent is involved. The user interacts with the widget
(configuring state via `callOp`), then optionally triggers agent involvement via
the `activate()` prop.

## When to use mountOnAttach

- The move is primarily a **standalone tool** (calendar, game setup, config panel)
- The user should **see and interact with UI before the agent knows about it**
- Agent involvement is **optional or deferred** ("Bring in agent" button)

## move.json — widget block with mountOnAttach

```json
{
  "name": "my-widget-move",
  "label": "My Widget",
  "description": "A standalone widget that optionally involves the agent",
  "icon": "layout",
  "mode": "inline",
  "inputs": [],
  "api": {
    "tokenPrefix": "mywid",
    "ops": {
      "get-state": { "description": "Read current state" },
      "set-config": {
        "description": "Set a config value",
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

### Key fields

| Field | Required | Description |
|-------|----------|-------------|
| `widget.mountOnAttach` | yes | `true` — widget opens on attach, before any message |
| `widget.autoOpen` | recommended | `true` — auto-opens the right panel |
| `api` | yes | Required — mountOnAttach needs API registration for `callOp` to work pre-activation |
| `submit.required` | typically `false` | Agent doesn't need to submit; the widget drives interaction |

## Lifecycle

```
User picks move from prompt picker
  → UI calls POST /api/moves/:name/attach (NOT activate)
  → Backend creates API registration + instance + state file
  → Widget opens in right panel with callOp ready
  → No message sent, no agent involvement yet

User interacts with widget
  → callOp("set-config", { ... }) writes to state
  → Widget reads state back via callOp("get-state")
  → All UI-driven, agent unaware

User clicks "Bring in agent" (optional)
  → Widget calls activate(optionalText)
  → Backend runs gather() which reads the state the widget populated
  → Prompt injected into session as a message
  → Agent now has context and API token

User clicks X on widget tab
  → Frontend calls detach API
  → Backend cleans up registration + disk state
  → Widget removed from panel
```

**Critical:** mountOnAttach moves do NOT create an attached chip in the composer.
The widget is the sole interface. Regular messages send normally without triggering
the move. The agent only gets involved when `activate()` is called from the widget.

## widget.tsx — using activate()

The widget receives `activate` as a prop (only for mountOnAttach moves).
It's `undefined` for non-mountOnAttach widgets.

```tsx
import { useState } from "react";
import type { MoveWidgetProps } from "../../../../harness/ui/src/components/MoveWidget";

export default function MyWidget({ callOp, activate }: MoveWidgetProps) {
  const [config, setConfig] = useState<string>("default");

  // Save config to state via API op
  const handleSave = async () => {
    await callOp("set-config", { key: "mode", value: config });
  };

  // Bring agent in — runs gather() which reads the config from state
  const handleActivate = async () => {
    if (activate) {
      await activate(); // optional text arg appended after gather output
    }
  };

  return (
    <div>
      {/* ... widget UI ... */}
      <select value={config} onChange={e => setConfig(e.target.value)}>
        <option value="a">Option A</option>
        <option value="b">Option B</option>
      </select>
      <button onClick={handleSave}>Save</button>

      {/* Only shown for mountOnAttach moves */}
      {activate && (
        <button onClick={handleActivate}>Bring in agent</button>
      )}
    </div>
  );
}
```

## context.ts — reading widget-populated state in gather()

```ts
import type { MoveContext, MoveApiContext, MoveApiHandler } from "../../../harness/move-types";

interface MyState {
  config: Record<string, string>;
}

export async function gather(ctx: MoveContext): Promise<string> {
  // State was populated by the widget via callOp before activate() was called
  // We don't have ctx.state in gather — read via a handler pattern or
  // access persisted state from disk if needed
  return `You have access to My Widget.\n\nToken: \`${ctx.apiToken}\`\n\n...`;
}

export const handlers: Record<string, MoveApiHandler> = {
  "get-state": async (ctx: MoveApiContext) => {
    const state = await ctx.state.get<MyState>();
    return { ok: true, message: JSON.stringify(state ?? { config: {} }) };
  },
  "set-config": async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const state = (await ctx.state.get<MyState>()) ?? { config: {} };
    state.config[data.key as string] = data.value as string;
    await ctx.state.set(state);
    return { ok: true, message: "Saved" };
  },
};
```

## Comparison: normal widget vs mountOnAttach

| Aspect | Normal widget | mountOnAttach widget |
|--------|--------------|---------------------|
| When widget opens | After activation (message sent) | Immediately on attach |
| Agent involved | Always (gather runs on attach) | Only when activate() called |
| Composer chip | Yes (move attached to message) | No chip — widget is the interface |
| activate() prop | `undefined` | Function available |
| API registration | Created during activate | Created during attach (pre-message) |
| Use case | Agent-driven with UI feedback | User-driven with optional agent |

## Examples in this project

- **Calendar** (`.modus/moves/calendar/`) — standalone calendar widget, "Bring in agent" for queries
- **Chess** (`.modus/moves/chess/`) — color selection screen, then "Start Game" activates agent
