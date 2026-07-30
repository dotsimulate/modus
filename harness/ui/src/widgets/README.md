# Widget System

Widgets are the composable UI modules of the app. The same widget types are used in
three places: the `home` dashboard, page layouts (`harness/pages/*.json` and
`.modus/pages/*.json`), and the left/right panels.

Adding one takes two steps, and both are required:

- create a `*.widget.tsx` file in this folder whose **default export is the React
  component itself**
- import it in `registry.ts` and add an entry to `WIDGET_DEFS`, keyed by the type string

```ts
// registry.ts
import MyThingWidget from "./my-thing.widget";

export const WIDGET_DEFS: Record<string, WidgetDef> = {
  "my-thing": {
    type: "my-thing",
    component: MyThingWidget,
    minHeight: 80,
    preferredHeight: 150,
    maxHeight: 200,
  },
  // ...
};
```

Registration is explicit — there is no auto-discovery, and `index.ts` is only a
re-export barrel. A `*.widget.tsx` file that is never imported into `registry.ts` is
never bundled, so the widget simply does not exist: no build error, no runtime error,
nothing in any picker. If a new widget does not show up anywhere, check its registry
entry before anything else.

Only `type` and `component` are required. `WidgetDef` also accepts `miniComponent`
(a compact variant for dense dashboards and small panels), `zones`, `minHeight` /
`maxHeight` / `preferredHeight` for list mode, and `handles` for default UI intents.
See `types.ts`.

Once registered, the type string is what you reference from a user profile's
`dashboard.widgets`, a page layout leaf, or a profile's `ui.panelWidgets`.

## Contract

Every widget component receives:

- `config`
  the widget's config object — from `userProfile.dashboard.widgets`, a page layout
  leaf, or a panel entry
- `widgetId`
  stable instance id used for persisted UI state
- `onNavigate(view)`
  app-level navigation
- `onSelectSession(id)`
  opens a session in chat
- `active?`
  whether this instance is the visible one (e.g. the selected tab)
- `pageContext?`
  handle on the page's scoped state bus when rendered inside a page layout, absent
  on the `home` dashboard — this is how widgets on a page publish to and read from
  each other. See `harness/docs/pages.md`.

Base config fields (`WidgetBase` in `types.ts`):

```ts
type WidgetBase = {
  id?: string;
  type: string;
  title?: string;
  size?: WidgetSize;
  collapsed?: boolean;
  /** UI intents this widget instance declares it can receive. */
  handles?: Array<UiIntentType | UiIntentCapability>;
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

These are surfaced through `widget-components.tsx` and `widget-data.ts` to make the reusable layer easier to discover.

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
