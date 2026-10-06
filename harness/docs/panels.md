---
title: Panels
lastUpdated: 2026-10-06
covers: harness/ui/src/providers/LayoutProvider.tsx harness/ui/src/providers/LayoutContext.ts harness/ui/src/providers/FileViewerProvider.tsx harness/ui/src/components/PanelSurface.tsx harness/ui/src/components/PanelTreeRenderer.tsx harness/ui/src/components/LeftPanel.tsx harness/ui/src/components/RightPanel.tsx harness/ui/src/components/RightPanelContext.tsx harness/ui/src/components/WidgetPicker.tsx harness/ui/src/components/pageScope.tsx harness/ui/src/widgets/registry.ts harness/ui/src/widgets/types.ts harness/ui/src/widgets/layout.ts harness/ui/src/widgets/ui-state.ts harness/sdk/types.ts
---

# Panels

Panels are the composable container primitive shared by two surfaces:

1. **App-level side panels** (`LeftPanel`, `RightPanel`) — persistent chrome
   around the center view, managed by `LayoutProvider`.
2. **Page panels** — `tabs`, `list`, `split`, `grid`, `overlay`, `scope` nodes inside a
   page's `layout` tree, managed by `PanelTreeRenderer` and the per-page
   `PageStateBus`.

Both surfaces reuse the same low-level pieces: `PanelSurface` for flat
rendering, `PanelTreeRenderer` for recursive trees, `WidgetPicker` for mutating
widget lists, and the same widget registry. This document is the reference for
how they fit together.

For page-level rules (load order, override resolution, forking, scope bus, event
flow) see `pages.md`. This file focuses on panel mechanics.

---

## 1. Architecture

| Part | Responsibility |
|------|----------------|
| `LayoutProvider` | State authority for the app-level panels — open/closed, width, mode, widgets, trees, per-session cache, persistence. |
| `LayoutContext` | Hook surface (`useLayout`) consumed by `App.tsx`, `LeftPanel`, `RightPanel`. |
| `LeftPanel` | Thin shell around `PanelSurface` + `WidgetPicker`. |
| `RightPanel` | Same, plus move widgets, action terminals, browser-path context, `requestView` handling. |
| `PanelSurface` | Flat renderer for `list` (collapsible cards) and `tabs` (single active). |
| `PanelTreeRenderer` | Recursive renderer for the full `LayoutNode` tree. |
| `EditablePanel` | Mutable variant of `tabs` / `list` — runtime picker, dynamic move tabs, file-open focus. |
| `WidgetPicker` | Add/remove/reorder widgets; toggle mode. |
| `ResizableSplit` | Drag handles + collapse tabs for `split` nodes. |
| `PageStateBus` / `ScopeProvider` | Per-page / per-scope event + key-value bus for widget coordination. |

Both panels honor two display modes in their flat path:

- `list` — vertically stacked `CollapsibleSurfaceItem`s.
- `tabs` — a tab strip with one visible widget at a time.

---

## 2. Widget Registry

Widgets are **explicitly registered**, not auto-discovered. The entry point is
`harness/ui/src/widgets/registry.ts`.

```ts
type WidgetDef = {
  type: string;
  component: ComponentType<WidgetProps<any>>;
  miniComponent?: ComponentType<WidgetProps<any>>;   // compact variant preferred by tree leaves
  zones?: ("dashboard" | "left-panel" | "right-panel")[];
  minHeight?: number;
  maxHeight?: number;
  preferredHeight?: number;
};

type WidgetBase = {
  id?: string;
  type: string;
  title?: string;
  size?: "full" | "half" | "third";
  collapsed?: boolean;
};
```

- `WIDGET_DEFS` — source of truth, metadata + component.
- `WIDGETS` — derived map `type → component`.
- `DEFAULT_DASHBOARD` — the built-in widget list for a fresh `home` view.
- `zones` filters `WidgetPicker` candidates. **Omitted = allowed everywhere**.
- `minHeight` / `maxHeight` / `preferredHeight` apply only in `list` mode (flat
  cards sized by `CollapsibleSurfaceItem`) — panels in `tabs` mode fill their
  container.

To add a widget: create `widgets/my-thing.widget.tsx` exporting a default
component, then import and register it in `registry.ts`. Widget files are
plain components — no self-registration glob.

### `WidgetProps`

```ts
type WidgetProps<C extends WidgetBase = WidgetBase> = {
  config: C;                           // the layout leaf's config object
  widgetId: string;                    // stable id — used for UI state keys
  active?: boolean;                    // true when currently visible (active tab / un-collapsed list item)
  onNavigate: (view: View) => void;    // app-level navigation callback
  onSelectSession: (id: string) => void;
  pageContext?: PageContextHandle;     // only provided inside a page or editable panel
};
```

When a widget runs inside a page, `pageContext` is non-null and the widget
should prefer it (read/write shared state, emit events) over wiring directly to
global stores. When `pageContext` is absent, widgets fall back to the app-level
flow (`onSelectSession`, `useSession`, etc.).

### `WidgetChromeContext`

Allows a widget to append a short suffix to its header when collapsed (e.g. "5
items"). Provided by `BlockShell` (block pages) and `CollapsibleSurfaceItem`
(list-mode panels). Ignored in `tabs` mode.

```tsx
const { setHeaderSuffix } = useWidgetChrome();
useEffect(() => setHeaderSuffix(`${count}`), [count]);
```

### Widget UI state — per-user, per-cwd

`useWidgetUiState({ userProfile, cwd }, widgetId, field, fallback)` wraps
`localStorage` with the key:

```
harness:widget-ui:<userProfile or "anon">:<cwd or "global">:<widgetId>:<field>
```

Used for collapse state, group-mode preferences, etc. Keys survive navigation
and refreshes but are scoped so per-project / per-user state doesn't leak.

---

## 3. `PanelSurface` — the Flat Renderer

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
  onClose?: () => void;      // tab strip close button
  onReload?: () => void;     // tab strip reload button (move widgets)
  render: (active: boolean) => ReactNode;
};
```

Behavior:

- In `tabs` mode the active tab is tracked in local state. When `items` change
  and the current active id is gone, it falls back to `items[0]`. An optional
  `requestActiveId` prop (used by `EditablePanel` and `RightPanel`) forces a
  specific tab active; `onRequestActiveHandled` acknowledges the request.
- In `list` mode each item is wrapped in `CollapsibleSurfaceItem`, which
  persists collapse via `useWidgetUiState` and respects the item's height
  constraints. Tab-mode items render full-bleed with `display: none` on inactive
  siblings so mounted components stay alive.
- Tab strips support horizontal wheel scrolling.
- Widget bodies scroll overflowing content by default in tabs, list cards,
  and standalone layout leaves (including split/grid children and move widgets).
  Widgets can still own an internal scroll area for a fixed toolbar, editor, or
  transcript; those keep the available height. Shared bodies use native wheel
  and touch scrolling, with smooth programmatic scrolling unless system or app
  reduced motion is enabled. Auto-sized layout sections remain content-sized.
- Optional `picker`, `headerClassName`, `bodyClassName`, and `contentClassName`
  props let each caller slot its own CSS class names while reusing the core.

The `processes` widget defaults to **Recently active**, ordered by the latest
event or start time across process kinds. **Newest started** orders by start
time instead. The selection persists per widget, user profile, and project.
This is the current process snapshot, not a history of completed processes.

---

## 4. `LayoutNode` Tree

The same `LayoutNode` tree used by pages (see `pages.md`) drives panel
rendering. Summary:

```ts
type LayoutLeaf = {
  kind: "widget";
  id?: string;
  widget: WidgetBase;
  publish?: Record<string, string>;
  subscribe?: Record<string, string>;
  canNavigate?: boolean;
  showWhen?: Record<string, unknown>;
  hideWhen?: Record<string, unknown>;
};

type LayoutNode =
  | { kind: "grid";  ... }
  | { kind: "split"; axis; sizes?: (number|"auto")[]; collapsible?: boolean[]; children }
  | { kind: "overlay"; children: LayoutNode[] }
  | { kind: "tabs";  editable?; target?; activeTab?; children: LayoutLeaf[] }
  | { kind: "list";  editable?; target?; children: LayoutLeaf[] }
  | { kind: "scope"; context?; bindUrlSession?; children: LayoutNode[] }
  | LayoutLeaf;
```

Aliases `PanelNode` / `PageLayoutNode` / `PanelLeaf` remain as `@deprecated`
re-exports.

### `normalizePanelLayout(mode, widgets)`

Converts a flat `WidgetBase[]` into a root `{ kind: mode, id: "root", children }`
tree with one leaf per widget. Used by `LayoutProvider` when a view has no
persisted `tree` — it synthesizes one from the widget list + mode so
`PanelTreeRenderer` can render uniformly.

### `PanelTreeRenderer`

Dispatches by `node.kind`:

- `widget` — single `LeafWidget` in a shared scroll body, without header chrome.
- `split` — `ResizableSplit` (see §5).
- `overlay` — one isolated CSS grid cell; the first child is the base and later
  recursive children paint above it.
- `grid` — CSS grid; direct children recurse. `tabs`/`list` children honor
  `columnSpan` / `rowSpan`.
- `scope` — wraps children in `ScopeProvider` + `ScopeSessionWatcher` (polls
  `modus.getActiveWidgets(sessionId)` on scope-session change and emits
  `open-move`). Optional `ScopeUrlSessionBinder` bridges URL hash ↔ bus
  `sessionId`.
- `tabs` / `list`:
  - `editable: true` → `EditablePanel` (see §6).
  - Otherwise → flat `PanelSurface` with items mapped by `renderLeaf`.

### Leaf hooks — `LeafWidget`

For every `widget` leaf:

1. `getLeafId(leaf, index)` → `leaf.id` or `leaf.widget.id` or `"<type>-<i+1>"`.
2. `usePageContext(publish, subscribe, canNavigate)` — builds the remapped bus
   handle or returns `undefined` if no bus.
3. `useLeafVisible(showWhen, hideWhen)` — returns `false` to render nothing.
4. If `widget.type` starts with `move:` → renders `MoveWidgetEmbed` (pages-only).
5. Otherwise resolves `WIDGET_DEFS[type].miniComponent ?? .component` and
   renders it with `pageContext`.

`renderLeaf` wraps the leaf into a `PanelSurfaceItem` with icon lookup
(`widgetIcon()` maps a handful of well-known types to compact SVGs) and heights
pulled from `WIDGET_DEFS`. Move widgets fall back to `minHeight: 200,
preferredHeight: 400` when there is no def.

---

## 5. `ResizableSplit`

Drag handles sit between children. Per-child `sizes[i]` is either a number
(flex weight) or `"auto"` (content-sized, `flex: 0 0 auto`). Per-child
`collapsible[i]: true` replaces the resize handle with a `SplitCollapseTab`:

- Click the tab → toggle collapsed.
- Drag the tab past a ~10px threshold → resize the adjacent boundary.
- Collapsed children render `flex: 0 0 0px` and skip their subtree.

Resize is disallowed when either neighbor is `"auto"` or collapsed — the static
handle class is applied so cursors/visuals reflect the non-draggable state.

Minimum flex weight for a resized side is 5% of total — prevents collapsing via
drag.

Mobile default (window width ≤ 640px) starts every collapsible child collapsed,
which gives phones a full-bleed center pane out of the box.

### `expand-target` event

When a new dynamic tab lands in a `target` panel deeper in the tree, the panel
emits `expand-target` on the scope bus. `ResizableSplit` listens and uncollapses
any collapsible child whose subtree `containsTarget()`, so the new tab becomes
visible without the user having to dig.

---

## 6. `EditablePanel`

Applied to any `tabs` or `list` node with `editable: true`.

### Mutable widget list

Seeded from `node.children[].widget`. Persisted per panel in `localStorage` at:

```
harness:editable-panel:<node.id or joined child widget ids>
```

The `WidgetPicker` in the panel header adds/removes/reorders widgets and can
toggle between `tabs` and `list` mode (the toggle does not hit the profile —
it's a per-panel state). Picker candidates are filtered by `WIDGET_DEFS.zones`
(treated as `right-panel` scope for editable page panels).

### Static + dynamic items

The final `items` array is `[...staticItems, ...dynamicItems]`:

- **Static items** come from the persisted widget list, mapped through
  `EditablePanelWidget` which plumbs `publish` / `subscribe` / `canNavigate`
  from the matching `node.children` leaf.
- **Dynamic items** are move widget tabs driven by the scope bus and by direct
  fetches from `modus.getActiveWidgets(scopeSessionId)`.

### `target` panels

A panel with `target: true` subscribes to the scope bus:

| Event | Effect |
|-------|--------|
| `open-move` | if not already present, append a dynamic tab with the move widget; emit `expand-target`; request active. |
| `close-move` | remove the tab; the panel also calls `modus.detachMove(moveName, apiToken)`. |
| `focus-tab` | switch active tab id. |

Also:

- On `scopeSessionId` change, the panel **self-fetches** active widgets. This
  heals the race where a move attaches before the panel mounts (e.g. a panel
  that was collapsed in a split).
- On `scopeSessionId` change it clears all dynamic tabs — dynamic tabs belong
  to the previous session.
- Listens to `useFileViewer().subscribeFileOpens(...)`: if a `code-editor` leaf
  is in this panel, switch to it and emit `expand-target`.

Dynamic tabs expose both `onReload` (evicts the move widget module URL via
`evictWidgetModule` and bumps a reload key) and `onClose` (removes tab + detach
the move).

---

## 7. `LayoutProvider` — App-Level State

`LayoutProvider({ view, children })` owns the state for the app-level side
panels. It observes `view` (via `useHashRouter`) and the active user profile /
session to pick the right defaults and persist changes.

### State

| Field | Meaning |
|-------|---------|
| `leftPanelOpen`, `rightPanelOpen` | Panel open flag. Persists per session in chat view; transient otherwise. |
| `leftPanelWidth`, `rightPanelWidth` | Pixel width. Clamped to 180–600 / 200–800 on drag. |
| `leftPanelMode`, `rightPanelMode` | `"list"` or `"tabs"`. |
| `leftPanelWidgets`, `rightPanelWidgets` | Resolved `WidgetBase[]`. |
| `leftPanelTree`, `rightPanelTree` | Resolved `LayoutNode` tree (persisted or synthesized). |
| `rightPanelBrowserPath` | Shared file-viewer path for code-editor-in-panel. |
| `requestRightPanelView` | External signal requesting a tab — see below. |
| `panelsEnabled` | Whether panels should render for this view at all. |
| `currentView` | Echo of the router's current view. |

### View-specific defaults — `VIEW_PANEL_DEFAULTS`

Hard-coded for `chat` and `home`.
Shape:

```ts
type PanelDefaults = {
  left:  { open; width; mode; widgets: string[] };
  right: { open; width; mode; widgets: string[] };
};
```

Width defaults: 280 (left) / 360 (right). Default modes: left is `list`, right
is `tabs`. Views missing from the map inherit `FALLBACK_DEFAULTS` (`widgets:
[]` on left, `["code-editor"]` on right).

`panelsEnabled = !!VIEW_PANEL_DEFAULTS[view]` — views not in the map have no
app-level panels. Custom `page:<id>` views compose their own panels inside the
page layout unless the page is a non-fullscreen page surrounded by enabled app
panels in a future default.

### Resolution order — widgets

For a given `view`:

1. `activeUP.layouts[view].<side>.widgets` — per-view user layout from the
   profile.
2. `activeUP.leftPanel.widgets` — **chat view only** legacy fallback.
3. `VIEW_PANEL_DEFAULTS[view].<side>.widgets` — built-in.

`normalizePanelWidgets(side, widgets)` upgrades each entry:

- Plain `string` → `{ id: "<side>-<type>-<i>", type }`.
- Object → keep as-is with a synthesized id if missing.

Widgets from the resolved source flow into local state
(`leftPanelWidgets`/`rightPanelWidgets`) so adds/removes feel instant; changes
are then patched back to the profile.

### Resolution order — trees

1. `activeUP.layouts[view].<side>.tree` — persisted tree (from a future
   split-aware editor, or manual JSON).
2. Else `normalizePanelLayout(mode, widgets)` — synthesize a flat tree.

The panel components themselves only use `tree` when it's non-flat
(`LeftPanel`/`RightPanel` still bias to the flat widget+mode path for the
simple cases). A persisted `{ kind: "split", ... }` tree would let a user have
nested panel splits even inside the app-level panel — the provider is ready
for it, but the current side-panel shells route around it.

### Chat-view per-session cache

Chat carries extra per-session UI: scroll position, file viewer tabs, active
file, panel open state, widths, and right-panel browser path. These are:

- Cached in-memory via `uiCache` (a `Map<sessionId, snapshot>`; evicted at 20).
- Debounced (300ms) into `modus.saveSessionUiState(sessionId, snapshot)`.
- Restored on session switch via `modus.getSessionUiState(id)` + an in-memory
  cache lookup. The `applyState` closure also hydrates `useFileViewer` and
  replays `chat-messages` scroll after a `requestAnimationFrame`.

Cache is keyed only by real session ids; pending (`pending-*`) and null ids are
ignored — otherwise transient null states during session creation would reset
the panels.

Non-chat view switches pull defaults + the per-view persisted mode. Panel
open state and width **carry over across view switches**; only mode, widget
list, and browser path reset.

### Persistence callbacks

All exposed via `useLayout()`:

| Callback | Patches |
|----------|---------|
| `onLeftPanelWidgetsChange(widgets)` | `layouts[view].left.widgets` — and, chat-only, `leftPanel.widgets` (type strings) for backward compat. |
| `onRightPanelWidgetsChange(widgets)` | `layouts[view].right.widgets` |
| `onLeftPanelModeChange(mode)` / `onRightPanelModeChange(mode)` | `layouts[view].<side>.mode` |
| `onLeftPanelTreeChange(tree)` / `onRightPanelTreeChange(tree)` | `layouts[view].<side>.tree` |

All call `modus.patchUserProfileUiConfig(activeUserProfile, patch)` then
`refreshUserProfiles()`. Failures are swallowed silently — the optimistic local
state already reflects the intent.

### Resize handlers

`handleLeftResize(delta)` and `handleRightResize(delta)` clamp to the width
ranges above. The `ResizeHandle` component in `App.tsx` drives them.

---

## 8. `LeftPanel` vs. `RightPanel`

### `LeftPanel`

Minimal: filters invalid widget types, maps into `PanelSurfaceItem[]`, renders
`PanelSurface` with the `WidgetPicker`. No browser context, no move widgets.

### `RightPanel`

Everything `LeftPanel` does, plus:

- **`RightPanelContextProvider`** — exposes `browserPath`, `setBrowserPath`,
  `messages`, `sessionId`, `requestOpen` to any child widget via
  `useOptionalRightPanelContext()`. `code-editor` uses it to share the panel's
  active file path across session switches.
- **Move widgets** — `moveWidgets` prop is appended after regular widgets as
  dynamic tabs. Each carries `onReload` (module eviction + reload key) and
  `onClose` (detach). Newly-added moves with `autoOpen !== false` auto-select.
- **Action terminal tabs** — polls `modus.listTerminals({ ownerType: "action" })`
  every 3s, groups by `ownerName`, and surfaces each as a dedicated
  `persistent-terminal`-style tab. New action terminals auto-open the panel.
- **`requestView`** — external signal (e.g. clicking a session-edit marker) that
  maps through `REQUEST_VIEW_TO_WIDGET` (`session-edits`, `activity`, `terminal`)
  to a matching widget type, opens the panel, and selects the tab.
- **Icon-only tabs** — widgets with an `iconFor(type)` mapping render as
  icon-only tabs in the strip. Labels still appear on hover.

### Sharing code-editor with the file viewer

The full chain:

1. User clicks a file path in chat or issues `open-file` via SSE — `FileViewerProvider.openFile(path)` mutates its tab list and notifies `subscribeFileOpens` listeners.
2. `App.tsx` registers a `subscribeFileOpens` listener: if the current view is
   not `chat` and not a custom page, it pops the app-level right panel and,
   if needed, adds a `code-editor` widget to the right panel's widgets.
3. Chat view and pages opt out — they have their own `code-editor` already.
   Pages handle focus inside `EditablePanel`; chat's layout (via the
   `chat-studio` page fork) does the same through its scope.

---

## 9. Persistence Shape (`UserProfileUiConfig`)

From `harness/sdk/types.ts`:

```ts
type UserProfileUiConfig = {
  panelWidgets?: Array<{ id?; type; [k]: unknown }>;
  dashboard?: {
    widgets?: Array<{ type; [k]: unknown }>;
    pages?: Array<{ id; title; blocks?; layout?; nav?; fullscreen? }>;
  };
  leftPanel?: { widgets?: string[] };        // legacy chat-only path
  layouts?: Record<string, {                 // keyed by View name
    left?:  { mode?: "list"|"tabs"; widgets?: (string | { id?; type; ... })[]; tree?: unknown };
    right?: { mode?: "list"|"tabs"; widgets?: (string | { id?; type; ... })[]; tree?: unknown };
  }>;
  computer?: string;
  editor?: string;
  clientExtensions?: { paths?; enabled?; disabled?; settings? };
};
```

Access via SDK:

- `modus.getUserProfileUiConfig(name)` → full config.
- `modus.patchUserProfileUiConfig(name, partial)` → deep-merged.

Widget arrays may contain either plain type strings or full `WidgetBase`-like
objects. `normalizePanelWidgets` upgrades strings into objects with stable
generated ids. When round-tripped the legacy `leftPanel.widgets` is rewritten
as `widget.type` strings (chat view only) for backward compatibility.

---

## 10. Page Panels vs. App Panels — Summary

| Concern | App-level panel | Page panel |
|---------|-----------------|------------|
| State source | `UserProfileUiConfig.layouts[view]` + view defaults | JSON on disk (project / harness / move / action / mission) |
| Persistence | `modus.patchUserProfileUiConfig` | fork to `.modus/pages/<id>.json` |
| Per-session UI cache | yes (chat only — open, widths, file viewer, scroll, browser path) | no (pages stay mounted; scope bus carries state) |
| Event bus | none (widgets talk to global stores) | `PageStateBus` (+ nested scopes) |
| Fullscreen | n/a | can hide the app panels when active |
| Editing | `WidgetPicker` in panel header | JSON edit, or `editable: true` panels (localStorage-only) |
| Move widgets | auto-appended to `RightPanel` for the active session | routed via `open-move` on the scope bus into any `target` panel |
| File open routing | `FileViewerProvider` → `App.tsx` opens right panel and ensures a `code-editor` | `EditablePanel` focuses its own `code-editor` leaf |

When both surfaces render at once (app panels around a page), they are
independent — the page has its own bus and its own editable panels. The app
panels always talk to global stores. The two coordinate only through the
`FileViewerProvider` (shared tab list) and the backend (move widget
registration).
