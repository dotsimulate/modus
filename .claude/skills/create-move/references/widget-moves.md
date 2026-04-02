# Widget Moves — Full Reference

Any move can have a widget. Widgets are React components that live in the move directory
and render in the right panel (or as a full page). Two primary patterns:

1. **Agent-first** — agent activates the move, widget opens alongside
2. **Standalone (mountOnAttach)** — widget opens immediately, agent involvement optional

## Widget declaration in move.json

```json
{
  "widget": {
    "component": "widget.tsx",
    "panel": "right",
    "label": "Tab Label",
    "icon": "icon-name",
    "autoOpen": true,
    "mountOnAttach": false,
    "cache": "instance"
  }
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `component` | yes | Filename in the move directory (e.g. `"widget.tsx"`) |
| `panel` | no | Only `"right"` for now |
| `label` | yes | Tab label in the panel |
| `icon` | no | Tab icon |
| `autoOpen` | no | Auto-open the panel on activation. Default `false`. |
| `mountOnAttach` | no | Mount widget before any agent involvement. Default `false`. Requires `api`. |
| `cache` | no | `"instance"` (default): DOM stays alive when hidden. `"module"`: JS cached, React can remount. `"none"`: always re-import. |

## Widget CSS

Put styles in `widget.css` next to `widget.tsx`. The harness auto-loads it when the
widget mounts — no imports in `main.tsx` or any harness file needed. CSS is served via
`/api/moves/:name/widget.css` and injected as a `<style>` tag in `<head>`.

Rules for widget CSS:
- Use `var(--*)` color tokens from `colors.css` — no hardcoded hex values
- Use `calc(Npx * var(--font-scale, 1))` for every `font-size`
- Set `accent-color: var(--text-secondary)` on native form controls
- Follow the compact panel guide: header (6px 12px) / body (flex:1, scroll) / footer
- Prefix all classes with a short move-specific prefix (e.g. `council-`, `wt-`) to avoid collisions

## Agent-first widgets

Default pattern. The move activates (gather runs, agent gets prompt), then the widget
opens in the right panel showing state.

```json
{
  "widget": {
    "component": "widget.tsx",
    "panel": "right",
    "label": "My Widget",
    "autoOpen": true
  }
}
```

Widget receives `callOp` to interact with the move's API handlers:

```tsx
import type { MoveWidgetProps } from "../../../../harness/ui/src/components/MoveWidget";

export default function MyWidget({ callOp }: MoveWidgetProps) {
  const handleAction = async () => {
    const result = await callOp("do-thing", { input: "hello" });
    console.log(result);
  };
  return <button onClick={handleAction}>Do Thing</button>;
}
```

## Standalone widgets (mountOnAttach)

Widget opens immediately on attach — before any message or agent involvement.
The user configures state via `callOp`, then optionally triggers the agent.

**Requires `api` declaration** — `callOp` needs registered handlers to work pre-activation.

```json
{
  "api": { "tokenPrefix": "mywid", "ops": { ... }, "state": { "persist": true } },
  "widget": {
    "component": "widget.tsx",
    "panel": "right",
    "label": "My Widget",
    "autoOpen": true,
    "mountOnAttach": true
  }
}
```

### Lifecycle

```
User picks move → POST /api/moves/:name/attach (NOT activate)
  → API registration + instance + state file created
  → Widget opens with callOp ready
  → No message sent, no agent yet

User interacts via callOp → state populated through handlers

User clicks "Bring in agent" → widget calls activate(optionalText)
  → gather() runs (reads state populated by widget)
  → Agent gets prompt + API token

User closes widget → detach → cleanup
```

### activate() prop

mountOnAttach widgets receive `activate` as a prop. **It is one-shot** — after the first
call, `activate` becomes `undefined`. Plan accordingly.

```tsx
import type { MoveWidgetProps } from "../../../../harness/ui/src/components/MoveWidget";

export default function MyWidget({ callOp, activate }: MoveWidgetProps) {
  const [ready, setReady] = useState(false);

  const handleSetup = async () => {
    await callOp("set-config", { key: "mode", value: "advanced" });
    setReady(true);
  };

  const handleActivate = async () => {
    if (activate) await activate(); // one-shot — becomes undefined after
  };

  return (
    <div>
      <button onClick={handleSetup}>Configure</button>
      {activate && ready && (
        <button onClick={handleActivate}>Bring in agent</button>
      )}
    </div>
  );
}
```

**Critical:** If the user needs to re-engage the agent after activation (e.g., reissue a key),
use an API op as a fallback — don't rely on `activate()` being available again.

### No composer chip

mountOnAttach moves do NOT create a chip in the composer. The widget is the sole interface.
Regular messages send normally without triggering the move.

## Full page moves

A move can own a page in the app nav via the `page` declaration. This is independent of
the `widget` — a move can have both (widget in right panel + full page in nav), or just one.

```json
{
  "page": {
    "id": "memory",
    "title": "memory",
    "icon": "brain",
    "nav": true
  }
}
```

| Field | Description |
|-------|-------------|
| `id` | Page ID used in URL hash (`#move-page:memory`) |
| `title` | Display title in the nav bar |
| `icon` | Optional nav link icon |
| `nav` | Show in main nav bar. Default `true`. |

The page component is the same `widget.tsx` — it renders full-width when accessed via the nav.
Example: the `memory` move has both a right-panel widget tab and a full-page nav entry.

## Widget caching strategies

| Strategy | Behavior | Use case |
|----------|----------|----------|
| `"instance"` (default) | DOM stays alive when tab is hidden | Games, media players — full state preservation |
| `"module"` | JS module cached, React unmounts/remounts freely | Dashboards — no import flash, component state resets |
| `"none"` | Always re-import the module | Development/iteration |

## Widget event subscription (SSE)

Widgets can subscribe to real-time state updates pushed from handlers via SSE.
When a handler calls `ctx.notify("msg", { type: "event-type" })`, the widget
receives the event through the existing SSE infrastructure.

The widget receives events via the `callOp` response or by polling `read-state`.
For real-time updates, the harness emits `widget-change` events that the UI listens for.

## Comparison: agent-first vs mountOnAttach

| Aspect | Agent-first | mountOnAttach |
|--------|-------------|---------------|
| When widget opens | After activation | Immediately on attach |
| Agent involved | Always | Only when activate() called |
| Composer chip | Yes | No |
| activate() prop | `undefined` | Function (one-shot) |
| API registration | During activate | During attach (pre-message) |
| Use case | Agent-driven with UI feedback | User-driven with optional agent |

## CSS and styling

Move widgets are dynamically loaded — they render inside the right panel's tab system.
Follow the compact panel CSS guide (`TODO/2026-03-19-compact-panel-css-guide.md`):

- Use `var(--*)` color tokens from `colors.css` — no hardcoded hex
- Use `calc(Npx * var(--font-scale, 1))` for all font sizes
- Use `--font-mono` for data-heavy content
- Set `accent-color` on native form controls

## Timeouts and heavy work

- **Auto-gather** (persistent, ambient): 10s. Must return fast.
- **User-initiated activation** (widget `activate()`, user invoke): **2 minutes**.

**Widget-first moves that need to launch processes or create sessions MUST do it
in gather().** Ops (handlers) have NO `ctx.run()` and NO `ctx.harness` — only
`ctx.state`, `ctx.notify`, `ctx.store`. The 2-minute activation timeout exists for
exactly this use case. Put heavy async work in gather(), triggered by `activate()`.

## Shipped examples

| Move | Pattern | Notable |
|------|---------|---------|
| `chess` | mountOnAttach, API contract | Color selection → game loop |
| `fal-image` | mountOnAttach, budget/security | Param locking, key registry |
| `memory` | Agent-first widget + full page | Dual surface (panel tab + nav page) |
| `animate-this` | Agent-first, instance cache | Video preview in widget |
| `council` | mountOnAttach, multi-agent | Config panel → debate orchestration |
