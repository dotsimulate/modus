---
title: Panels
audience: agents
lastUpdated: 2026-04-08
covers: harness/ui/src/providers/LayoutProvider.tsx harness/ui/src/components/PanelSurface.tsx harness/ui/src/components/PanelTreeRenderer.tsx harness/ui/src/components/LeftPanel.tsx harness/ui/src/components/RightPanel.tsx harness/ui/src/components/WidgetPicker.tsx harness/ui/src/widgets/index.ts harness/sdk/types.ts
---

# Panels

The left and right side panels are shared widget containers. Their runtime state lives in
`LayoutProvider`, their flat rendering path goes through `PanelSurface`, and their recursive
tree rendering path goes through `PanelTreeRenderer`.

## Architecture

| Part | Responsibility |
|------|----------------|
| `LayoutProvider` | Resolves defaults, reads persisted per-view layout, exposes panel state and mutators |
| `LeftPanel` | Renders left container, picker, and either `PanelSurface` or `PanelTreeRenderer` |
| `RightPanel` | Same for right side, plus move widgets and right-panel context |
| `PanelSurface` | Shared renderer for flat `list` and `tabs` modes |
| `PanelTreeRenderer` | Recursive renderer for `split` / `tabs` / `list` / `widget` trees |
| `WidgetPicker` | Add/remove/reorder widgets and switch between `tabs` and `list` |

Both panels support two display modes for flat layouts:
- `list`: stacked collapsible widgets
- `tabs`: a tab strip with one visible widget at a time

## Widget System

Widgets are auto-discovered from `harness/ui/src/widgets/*.widget.tsx`:

```ts
const modules = import.meta.glob<{ default: WidgetDef }>(
  "./*.widget.tsx",
  { eager: true },
);
```

Core types:

```ts
export type WidgetDef = {
  type: string;
  component: ComponentType<WidgetProps<any>>;
  zones?: ("dashboard" | "left-panel" | "right-panel")[];
  minHeight?: number;
  maxHeight?: number;
  preferredHeight?: number;
};

export type WidgetBase = {
  id?: string;
  type: string;
  title?: string;
  size?: "full" | "half" | "third";
  collapsed?: boolean;
};
```

Notes:
- `WIDGET_DEFS` stores metadata keyed by widget type.
- `WIDGETS` stores the actual React components keyed by widget type.
- If `zones` is omitted, the widget is allowed in all three zones.
- `minHeight`, `maxHeight`, and `preferredHeight` are applied by `PanelSurface` in list mode.

`WidgetPicker` uses `zones` to filter candidates, can add or remove widget instances, reorders
the flat widget array, and can switch panel mode when `onModeChange` is available.

## PanelSurface

`PanelSurface` is the shared flat renderer used by both page panels and side panels.

It accepts:

```ts
type PanelSurfaceItem = {
  id: string;
  label: string;
  title?: string;
  icon?: ReactNode;
  minHeight?: number;
  maxHeight?: number;
  preferredHeight?: number;
  defaultCollapsed?: boolean;
  onClose?: () => void;
  render: (active: boolean) => ReactNode;
};
```

Behavior:
- In `tabs` mode, it tracks `activeItemId` locally and renders one item at a time.
- In `list` mode, each item renders through `CollapsibleSurfaceItem`.
- Collapse state persists with `useWidgetUiState`.
- Tab strips support horizontal wheel scrolling.
- Optional `picker`, header, and body class props let left and right panels reuse the same core.

## PanelNode Tree

The new panel schema is a recursive tree defined in `harness/ui/src/widgets/index.ts`:

```ts
export type PanelLeaf = {
  kind: "widget";
  id?: string;
  widget: WidgetBase;
};

export type PanelNode =
  | {
      kind: "split";
      id?: string;
      axis: "horizontal" | "vertical";
      sizes?: number[];
      children: PanelNode[];
    }
  | {
      kind: "tabs";
      id?: string;
      activeTab?: string;
      children: PanelLeaf[];
    }
  | {
      kind: "list";
      id?: string;
      children: PanelLeaf[];
    }
  | PanelLeaf;
```

`normalizePanelLayout(mode, widgets)` converts a flat widget array into a root
`{ kind: mode, id: "root", children: PanelLeaf[] }` node.

`PanelTreeRenderer` behavior:
- `widget` nodes render a single widget directly.
- `tabs` and `list` nodes are converted into `PanelSurfaceItem[]` and passed to `PanelSurface`.
- `split` nodes render recursively as flex containers using `axis` and `sizes`.
- Each split child gets `flex: "<size> <size> 0%"` when `sizes[index] > 0`, otherwise `1 1 0%`.

Current side-panel components only switch to `PanelTreeRenderer` when the root tree is a
`split` node. Non-split trees still render through the flat `widgets + mode` path even if a
persisted tree exists.

## LayoutProvider

`LayoutProvider` is the state authority for side panels.

It manages:
- `leftPanelOpen`, `leftPanelWidth`, `leftPanelMode`, `leftPanelWidgets`, `leftPanelTree`
- `rightPanelOpen`, `rightPanelWidth`, `rightPanelMode`, `rightPanelWidgets`, `rightPanelTree`
- right-panel browser path and requested widget view
- resize handlers, toggles, and persistence callbacks

View defaults live in `VIEW_PANEL_DEFAULTS`. Current entries include `chat`, `actions`,
`profiles`, `web`, `trace`, `git`, and `home`. Width defaults are `280` left and `360` right;
fallback right mode is `tabs`, fallback left mode is `list`.

Resolution order:

1. Per-view user layout from `activeUP.layouts[view]`
2. Legacy `activeUP.leftPanel.widgets` for chat-left compatibility only
3. Built-in defaults from `VIEW_PANEL_DEFAULTS`

Tree resolution:

1. Persisted `layouts[view].left.tree` or `layouts[view].right.tree`
2. `normalizePanelLayout(resolvedMode, resolvedWidgets)`

Chat has extra per-session behavior:
- open state, widths, scroll position, file viewer tabs, active file, and right browser path
  are cached per session and persisted through `modus.saveSessionUiState()`
- state is restored on session switch in chat view only
- non-chat view changes reset to view defaults plus persisted per-view mode overrides

## Left and Right Panels

`LeftPanel` and `RightPanel` are thin containers around the shared rendering primitives.

`LeftPanel`:
- filters invalid widget types
- converts widgets into `PanelSurfaceItem[]`
- exposes `WidgetPicker`
- removes widgets through `onClose`
- uses `PanelTreeRenderer` only when `tree.kind === "split"`

`RightPanel` adds:
- `RightPanelContextProvider` for browser-path aware widgets
- move widgets appended after regular widgets
- icon-only tabs for some built-in widget types
- `requestView` handling, which can auto-open the panel if a matching widget exists

## Persistence

User-profile persistence lives in `UserProfileUiConfig` in `harness/sdk/types.ts`:

```ts
export type UserProfileUiConfig = {
  leftPanel?: {
    widgets?: string[];
  };
  layouts?: Record<string, {
    left?: {
      mode?: "list" | "tabs";
      widgets?: Array<string | { id?: string; type: string; [key: string]: unknown }>;
      tree?: unknown;
    };
    right?: {
      mode?: "list" | "tabs";
      widgets?: Array<string | { id?: string; type: string; [key: string]: unknown }>;
      tree?: unknown;
    };
  }>;
  // ...
};
```

Persistence flow:
- `onLeftPanelWidgetsChange()` patches `layouts[view].left.widgets`.
- In chat view, that same patch also writes legacy `leftPanel.widgets` as widget type strings.
- `onRightPanelWidgetsChange()` patches `layouts[view].right.widgets`.
- `onLeftPanelModeChange()` and `onRightPanelModeChange()` patch `mode`.
- `onLeftPanelTreeChange()` and `onRightPanelTreeChange()` patch `tree`.
- All of these use `modus.patchUserProfileUiConfig(...)`, then refresh profiles.

Persisted widget arrays may contain either plain type strings or full `WidgetBase`-like objects.
`normalizePanelWidgets()` converts them into widget configs with stable generated ids when needed.
