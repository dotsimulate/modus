# Widget System

Widgets are dashboard modules rendered on the `home` view.

The current system is intentionally lightweight:

- create a `*.widget.tsx` file in this folder
- export a default `{ type, component }`
- add the widget to a user profile's `dashboard.widgets`

No registry file update is required. `import.meta.glob()` in `index.ts` auto-registers it.

## Contract

Every widget component receives:

- `config`
  the widget's config object from `userProfile.dashboard.widgets`
- `widgetId`
  stable instance id used for persisted UI state
- `onNavigate(view)`
  app-level navigation
- `onSelectSession(id)`
  opens a session in chat

Base config fields:

```ts
type WidgetBase = {
  id?: string;
  type: string;
  title?: string;
  size?: "full" | "half" | "third";
  collapsed?: boolean;
};
```

Example:

```json
{
  "dashboard": {
    "widgets": [
      { "id": "sessions-main", "type": "sessions", "title": "recent", "size": "full" },
      { "id": "stats-main", "type": "stats", "size": "half" }
    ]
  }
}
```

## Widget Scope

Widgets can import any existing UI code.

Commonly useful sources:

- `../api`
- `../components`
- `../providers`
- `../utils`
- `./widget-components`
- `./widget-data`

There is no technical sandbox around widgets today.

## Shared Shell

`Dashboard.tsx` provides:

- widget header
- title rendering
- collapsed state
- shared wrapper classes

Per-instance collapsed/sort/filter UI state should use `useWidgetUiState()` from `ui-state.ts`.

## Recommended Reuse

Use these first before creating new local primitives:

- `ActivityChart`
- `HBar`
- `CustomSelect`
- `Markdown`
- `WidgetEmptyState`
- `useWidgetPollingValue()`

These are surfaced through `widget-components.ts` and `widget-data.ts` to make the reusable layer easier to discover.

## Data Patterns

Most widgets are scoped by active user profile and sometimes active cwd.

Preferred pattern:

1. read active scope from `useProfiles()`
2. fetch through `../api`
3. use `useWidgetPollingValue()` for periodic refresh
4. use `useWidgetUiState()` for local persisted UI state

Avoid open-coding `setInterval` unless the widget has unusual timing or cancellation needs.

## Empty / Loading States

Use `WidgetEmptyState` for simple loading, empty, and unavailable states.

Examples:

```tsx
if (loading) return <WidgetEmptyState>loading stats...</WidgetEmptyState>;
if (!rows.length) return <WidgetEmptyState>no sessions</WidgetEmptyState>;
```

## When To Add A Shared Primitive

Promote a widget-local pattern when it is reused by at least two widgets and has the same behavioral contract.

Good candidates:

- polling hooks
- empty states
- section headers
- tab/toggle controls
- small chart primitives

Bad candidates:

- large provider-specific summaries
- bespoke layouts
- one-off visual experiments
