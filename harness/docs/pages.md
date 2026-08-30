---
title: Pages
lastUpdated: 2026-08-24
covers: harness/pages.ts harness/index.ts harness/ui/src/App.tsx harness/ui/src/conversation-navigation.ts harness/ui/src/components/PageRenderer.tsx harness/ui/src/components/PanelTreeRenderer.tsx harness/ui/src/components/pageScope.tsx harness/ui/src/widgets/types.ts harness/ui/src/widgets/layout.ts harness/ui/src/widgets/registry.ts harness/ui/src/widgets/ui-state.ts harness/ui/src/views.ts harness/sdk/types.ts .modus/pages/*.json harness/pages/*.json
---

# Pages

Pages are project- or harness-scoped dashboards composed from **widgets** arranged by
a **layout tree** (splits, grids, tabs, lists, scopes). They are plain JSON files —
loaded from several sources, rendered by `PageRenderer` / `PanelTreeRenderer`, and
wired together at runtime by a per-page event bus (`PageStateBus`).

This doc is the authoritative reference for the page renderer. See `panels.md` for
how the same primitives render inside the app-level side panels.

Conversation lenses reuse this layout grammar and renderer but have their own
chat-route selection, safety, discovery, and fallback contract. See
`conversation-lenses` before using a page fork as a selectable chat view.

---

## 1. Load Path — Where Pages Come From

| Layer | Source |
|-------|--------|
| Project standalone | `.modus/pages/*.json` under the active `cwd` |
| Plugin standalone | `<plugin>/.modus/pages/*.json`, when listed in `integration.pages` |
| Harness built-ins | `harness/pages/*.json` (ships in-tree, e.g. `chat-studio.json`, `chat-mobile.json`, `pages.json`) |
| Moves | any `.modus/moves/<name>/move.json` or `harness/moves/<name>/move.json` with a `page` field |
| Actions | any `.modus/actions/<name>/action.json` with a `page` field |
| Missions | any `.modus/missions/<name>/mission.json` with a `page` field |
| User-profile pages | `activeUP.dashboard.pages` (legacy, seeded per profile) |
| Backend loader | `harness/pages.ts` → `listConfigPages(cwd)` |
| HTTP route | `GET /api/pages?cwd=...` (and `POST /api/pages/fork`) — `harness/index.ts` |
| Frontend fetch | `App.tsx` on `projectCwd` change |
| Navigation | every visible page becomes a nav entry keyed `page:<id>` via `customPageView(id)` |

### Scan order and origin tagging

`listConfigPages(cwd)` scans in this fixed order and tags each page with an `origin`:

1. `scanStandalonePages(cwd)`       → `origin: "standalone"`
2. `scanPluginStandalonePages()`    → `origin: "plugin"`
3. `scanHarnessPages()`             → `origin: "harness"`
4. `scanMovePages(cwd)`             → `origin: "move"`
5. `scanActionPages(cwd)`           → `origin: "action"`
6. `scanMissionPages(cwd)`          → `origin: "mission"`

Plugin standalone and embedded move/action pages are visible only when their
page id appears in the plugin manifest's `integration.pages` list. Files remain
at the plugin source path; the loader does not seed them into projects.

Disabled primitives (`enabled: false` in the owning `move.json` / `action.json` /
`mission.json`) are skipped. Directory scans fail silently. JSON parse errors log a
warning but do not fail the whole scan.

### Duplicate-id rules — what wins when names collide

The final list **deduplicates by page `id`, first occurrence wins**. Because project
standalone files are scanned first, a project-level `.modus/pages/<id>.json` always
overrides a same-id page from:

- a harness built-in (`harness/pages/<id>.json`)
- a move/action/mission embedded page
- a profile-level `dashboard.pages[]` entry (merged client-side; see `App.tsx` —
  `customPages = [...configPages, ...profilePages.filter(id not in configPages)]`)

This "fork to override" pattern means you can drop a file at
`.modus/pages/chat-studio.json` to fully replace the harness `chat-studio` built-in
without touching the harness tree. Within `scanMovePages` / `scanActionPages`,
projects also win over harness-shipped counterparts (the inner `seen` set blocks
harness duplicates once a project version has been seen).

### Forking a page into your project

`POST /api/pages/fork { cwd, pageId }` resolves `pageId` from
harness/moves/actions/missions (skipping any existing standalone by the same id),
strips `origin` and `source`, and writes
`<cwd>/.modus/pages/<pageId>.json`. Use the `pages-browser` widget or hit the
endpoint directly.

---

## 2. Config Shape

### Single-page file

```json
{
  "id": "page-id",
  "title": "page title",
  "padding": 4,
  "nav": true,
  "fullscreen": false,
  "context": { "sessionId": null },
  "layout": { /* LayoutNode */ },
  "blocks": [ /* DashboardBlock[] — legacy */ ]
}
```

### Multi-page wrapper

```json
{
  "pages": [
    { "id": "one", "title": "one", "layout": { "kind": "widget", "widget": { "type": "stats" } } },
    { "id": "two", "title": "two", "blocks": [ { "kind": "text", "markdown": "# hi" } ] }
  ]
}
```

### Validation

`isConfigPage()` accepts a file only if it has `id: string`, `title: string`, and
**at least one of**: `blocks: unknown[]` or a non-null object `layout`. Everything
else is optional. Files that fail validation are dropped silently.

### `ConfigPage` (backend)

```ts
type ConfigPage = {
  id: string;
  title: string;
  blocks?: PageBlock[];
  layout?: PageLayoutNode;      // preferred — see LayoutNode
  context?: Record<string, unknown>;   // initial page-scope bus state
  padding?: number;              // CSS padding (px) around top-level layout
  source?: string;               // absolute path to the defining JSON
  origin?: "standalone" | "harness" | "move" | "action" | "mission";
  nav?: boolean;                 // default true — show in top nav
  fullscreen?: boolean;          // hide app-level side panels when active
};
```

### Field semantics

| Field | Meaning |
|-------|---------|
| `id` | URL/nav key. Page renders at `page:<id>` (e.g. `#page:ops`). |
| `title` | Nav label and tab title. |
| `padding` | CSS `padding` in px applied once around the root layout. Default 0. |
| `nav` | `false` hides the page from the top-nav bar (still reachable by hash). Pages embedded in moves default to visible unless `nav: false`. |
| `fullscreen` | `true` hides `LeftPanel`, `RightPanel`, and their collapse tabs while the page is active. Used by `chat-studio` — the page carries its own chrome. |
| `context` | Initial key/value seed for the page's `PageStateBus`. Widgets read/write it via `pageContext`. |
| `layout` | Root `LayoutNode`. Preferred format. |
| `blocks` | Legacy dashboard-block list (cards). Only used if `layout` is absent. |

---

## 3. Embedded Page Declaration (moves/actions/missions)

Move/action/mission configs can embed a page declaration that becomes a
first-class nav entry through the unified page discovery path.

```ts
type EmbeddedPageDecl = {
  id: string;
  title: string;
  icon?: string;          // not currently surfaced by nav
  nav?: boolean;
  layout?: unknown;       // required — page must have a layout
  context?: Record<string, unknown>;
  padding?: number;
};
```

Rules:
- The primitive's `enabled: false` hides its page.
- Missing `layout` means the declaration is ignored for page discovery.
- Move pages **without** `layout` still ride the `move-page:<moveName>` nav path
  via `MovePageView` (this is a separate legacy surface — `App.tsx` filters
  them into `bareMovePagesNav`).

---

## 4. Layout Tree — `LayoutNode`

The page `layout` field is a recursive tree. All non-leaf nodes can contain other
nodes; only `widget` leaves are terminal.

```ts
type LayoutLeaf = {
  kind: "widget";
  id?: string;
  widget: WidgetBase;
  publish?: Record<string, string>;     // widget-key → pageContext-key (writes)
  subscribe?: Record<string, string>;   // widget-key ← pageContext-key (reads)
  canNavigate?: boolean;                // enables pageContext.navigate/selectSession
  showWhen?: Record<string, unknown>;   // AND of page-context equalities; null matches null/undef
  hideWhen?: Record<string, unknown>;   // OR of equalities hiding the leaf
};

type LayoutNode =
  | { kind: "grid";  columns; gap?; templateColumns?; templateRows?; children; showWhen?; hideWhen? }
  | { kind: "split"; axis: "horizontal"|"vertical"; sizes?: (number|"auto")[]; collapsible?: boolean[]; children; showWhen?; hideWhen? }
  | { kind: "overlay"; children: LayoutNode[]; showWhen?; hideWhen? }
  | { kind: "tabs";  activeTab?; columnSpan?; rowSpan?; editable?; target?; children: LayoutLeaf[]; title?; showWhen?; hideWhen? }
  | { kind: "list";  columnSpan?; rowSpan?; editable?; target?; children: LayoutLeaf[]; title?; showWhen?; hideWhen? }
  | { kind: "scope"; context?; bindUrlSession?; children: LayoutNode[]; showWhen?; hideWhen? }
  | LayoutLeaf;
```

The aliases `PanelNode`, `PageLayoutNode`, and `PanelLeaf` are kept as `@deprecated`
exports that resolve to `LayoutNode` / `LayoutLeaf`.

### Node kinds

| Kind | Renders as | Notes |
|------|------------|-------|
| `grid` | CSS grid (`templateColumns` or `repeat(columns, minmax(0, 1fr))`; `templateRows` optional). | Children recurse; direct child `tabs` / `list` honor `columnSpan` / `rowSpan`. |
| `split` | Flex container with draggable `panel-split-handle` between children. | `sizes[i]` is flex weight (number) or `"auto"` (content-sized, `flex: 0 0 auto`). `collapsible[i]: true` replaces the resize handle with a `SplitCollapseTab` on the inner edge (chevron toggles, drag resizes the neighbor). Auto/collapsed neighbors skip resize. Mobile default (≤640px) starts collapsible children collapsed. |
| `overlay` | CSS grid with every child in the same cell. | First child is the base; later children paint above it. Upper children own transparency and pointer-event behavior. |
| `tabs` | `PanelSurface` in tab mode. | Single active tab; horizontal wheel scrolling on the tab strip. |
| `list` | `PanelSurface` in list mode. | Each child is a collapsible card (`CollapsibleSurfaceItem`). |
| `scope` | Invisible wrapper that creates a nested `PageStateBus` for its subtree. | See §5.  |
| `widget` | Single leaf widget, no chrome. | Bypasses `PanelSurface`. |

### `editable` panels

A `tabs` or `list` node with `editable: true` renders through `EditablePanel`
instead of the static path. That adds:

- `WidgetPicker` UI to add/remove/reorder widgets at runtime.
- A mode toggle (`tabs` ↔ `list`) independent of the config.
- `localStorage` persistence of the widget list under key
  `harness:editable-panel:<node.id or joined widget ids>`.
- Dynamic handling of move widgets and file-open events (see §5.4).

### `target` panels

A `tabs`/`list` node with `target: true` (usually combined with `editable: true`)
listens on the scope bus for:

- `open-move` — a move widget attached to the scope's session → new dynamic tab.
- `close-move` — remove the tab and detach the move via `modus.detachMove`.
- `focus-tab` — switch active tab by id.

Dynamic tabs carry a `MoveWidget` component mounted with its module URL and API
token. `EditablePanel` also self-fetches `modus.getActiveWidgets(sessionId)` on
mount and on `modus:widgets-changed` so it heals if events fired before mount.

When a new dynamic tab appears, the panel also emits `expand-target` on the bus so
any ancestor `split` with a collapsible branch containing this target unfolds
(`containsTarget()` in `PanelTreeRenderer`).

### File-open → code-editor focus

`EditablePanel` subscribes to `useFileViewer().subscribeFileOpens`. When a file is
opened anywhere and this panel contains a `code-editor` widget, the panel
switches to the editor tab and emits `expand-target`. This is the
page-level equivalent of how the app-level `RightPanel` auto-opens on file clicks
(see `App.tsx` panel file-route effect).

### Visibility — `showWhen` / `hideWhen`

Every node kind (grid, split, overlay, tabs, list, scope, widget) supports both fields.
Implemented by `useLeafVisible()`:

- `showWhen` is an **AND** of equalities. A node shows only when every listed
  pagecontext key matches the expected value. `null` matches null/undefined.
- `hideWhen` is an **OR**: any single match hides the node.
- For leaves the node is removed; for split children, the wrapper collapses to
  `flex: 0 0 0px` so the layout reclaims the space (`SplitChild`).

Example — chat-studio's center area:

```json
{ "kind": "tabs", "showWhen": { "sessionId": null }, "children": [ /* new-session, inbox */ ] }
{ "kind": "widget", "widget": { "type": "session-chat" }, "hideWhen": { "sessionId": null } }
{ "kind": "widget", "widget": { "type": "composer" },     "hideWhen": { "sessionId": null } }
```

---

## 5. Page-Scope Event Bus — `PageStateBus`

Every page mounts a single `PageStateBus` via `createPageStateBus(initial)` in
`PageView`. The bus carries:

1. **Shared state** — a flat key/value map, seeded by the page's `context` field.
2. **Events** — typed, type-keyed pub/sub (`ScopeEvent { type: string; ... }`).
3. **Navigation hooks** — `onNavigate`/`onSelectSession` injected from the app.

Widgets receive a `pageContext: PageContextHandle` prop when rendered inside a
page (or an `editable` panel). The handle is the **only** surface the widget uses
to talk to the bus:

```ts
type PageContextHandle = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  emit: (event: ScopeEvent) => void;
  on: (type: string, handler: (event: ScopeEvent) => void) => () => void;
  navigate?: (view: string) => void;        // only if leaf has canNavigate: true
  selectSession?: (id: string) => void;      // only if leaf has canNavigate: true
};
```

### Key remapping — `publish` / `subscribe`

The layout leaf rewrites the widget's view of bus keys:

- `publish: { selectedSession: "sessionId" }` — when the widget calls
  `pageContext.set("selectedSession", v)`, the bus key written is `sessionId`.
- `subscribe: { sessionId: "activeSessionId" }` — when the widget calls
  `pageContext.get("sessionId")`, it reads `activeSessionId` from the bus.

This lets the same widget participate in different pages with different key
conventions without editing the widget. Typical convention: `sessionId` for the
chat pipeline (session-list/session-chat/composer); `activeSessionId` or
`selectedSession` when two or more distinct "sessions" exist per page.

### Navigation escape hatch — `canNavigate`

`navigate` and `selectSession` are `undefined` on the handle unless the leaf sets
`canNavigate: true`. This makes it explicit when a widget is allowed to leave the
page. `session-list`, for instance, publishes `selectedSession` into the bus by
default (stay-on-page) and only navigates when the leaf opts in.

### Scopes — nested buses

A `{ kind: "scope", context, bindUrlSession, children }` node wraps its subtree in
its own `PageStateBus` via `ScopeProvider`. Widgets inside see only the nearest
bus (`useContext(PageStateBusContext)`). Uses:

- **Dual-session pages** (`.modus/pages/dual-session.json`) — two scopes, each
  with its own `sessionId` key, side-by-side.
- **Fullscreen chat** (`harness/pages/chat-studio.json`) — a single top-level
  scope with `bindUrlSession: true` so the URL session (`#...`) flows into and out
  of the bus.

`bindUrlSession` (one per page max) wires URL hash ↔ bus `sessionId`:

- Inbound: `PageUrlProvider` drops the URL session into the bus on mount and on
  `hashchange`.
- Outbound: bus `sessionId` changes call `bus.onSelectSession(sid)` which routes
  through the app router and updates the URL.

`ScopeSessionWatcher` (mounted under every scope) polls
`modus.getActiveWidgets(sessionId)` on session change and on
`modus:widgets-changed`, and emits `open-move` on the scope bus for each new
move widget. This is how an agent that activates a move ("chess", etc.) causes a
widget tab to appear on the page automatically.

### Built-in events

| Event | Emitter | Listener |
|-------|---------|----------|
| `open-move` | `ScopeSessionWatcher`, `EditablePanel` self-fetch | `EditablePanel` with `target: true` → adds dynamic tab |
| `close-move` | `EditablePanel` close button | removes tab, calls `modus.detachMove` |
| `focus-tab` | anyone | `EditablePanel` sets active tab id |
| `expand-target` | new move tab, file-open → editor | `ResizableSplit` uncollapses collapsible branches that `containsTarget()` |

Widgets are free to define their own event types for cross-widget coordination —
the bus forwards any `{ type, ... }` payload.

---

## 6. Block-Based Pages (Legacy)

When a page uses `blocks` instead of `layout`, `PageRenderer` renders each block
as a collapsible `BlockShell` card. Supported blocks:

```ts
type DashboardBlock =
  | { kind: "widget"; widget: WidgetBase }
  | { kind: "module"; id?; title?; size?; module: "actions" | "git"; collapsed? }
  | { kind: "text";   id?; title?; size?; markdown: string; collapsed? };
```

- `widget` blocks resolve `widget.type` through `WIDGETS`.
- `module: "actions"` renders the full `<Actions>` panel. `module: "git"` renders
  `<GitPanel>`.
- `text` blocks render markdown.
- Every block gets per-user collapse state keyed by id via `useWidgetUiState`.

Special case: a page with exactly one `module` block and no others renders that
module directly (no card shell). Used to fold `git` into the `PageView`
infrastructure.

Block-based pages do **not** get a `PageStateBus`. No `pageContext` is provided to
their widgets. New pages should prefer `layout`.

---

## 7. Widget References

Pages never import widget components directly — they reference types through the
registry.

### `WidgetBase`

```ts
type WidgetBase = {
  id?: string;       // stable instance id; used for UI state key-in
  type: string;      // must match a registered WidgetDef
  title?: string;
  size?: "full" | "half" | "third";   // dashboard-only
  collapsed?: boolean;
  // any widget-specific config fields live here too
};
```

### Registry (`harness/ui/src/widgets/registry.ts`)

`WIDGET_DEFS` is a flat object keyed by widget type. Each entry has:

```ts
type WidgetDef = {
  type: string;
  component: ComponentType<WidgetProps<any>>;
  miniComponent?: ComponentType<WidgetProps<any>>;   // compact variant used by PanelTreeRenderer leaves
  zones?: ("dashboard" | "left-panel" | "right-panel")[];
  minHeight?: number;
  maxHeight?: number;
  preferredHeight?: number;
};
```

`WIDGETS` is the same data flattened to `type → component`, used by `PageRenderer`
(block path), `LeftPanel`, `RightPanel`, `WidgetPicker`, and `EditablePanel`.

### Unknown widget types

`PanelTreeRenderer` renders `unknown widget: <type>` for unregistered types.
`LeftPanel` / `RightPanel` filter them out of `WIDGETS` silently. `WidgetPicker`
only lists registered types.

### Move widgets — `"move:<name>"`

A leaf widget with `type: "move:chess"` is not a registered widget. Instead,
`PanelTreeRenderer.LeafWidget` detects the `move:` prefix and renders
`MoveWidgetEmbed` with the move name. `MoveWidgetEmbed` pulls the move's widget
info via SDK and mounts the remote module. This lets pages embed move widgets
directly without running the move session — useful for ambient UIs.

#### Embed lifecycle — where the embed gets its `apiToken`

The embed is **not** a dead render. `MoveWidgetEmbed` calls
`POST /api/moves/:name/attach` itself (with `inputs: {}` and the active `cwd`),
and passes the `apiToken` and `instanceId` from that attach result straight into
`MoveWidget`. So `callOp` works on a page embed exactly as it does in a panel tab.

Four consequences worth knowing before you build a page around one:

- **`widget.mountOnAttach: true` and an `api` declaration are both required.**
  `attachMove` rejects the request outright otherwise — `"Move does not support
  mountOnAttach"` or `"mountOnAttach requires an api declaration"` — and the embed
  renders that string in place of the widget.
- **There is no session.** The embed mounts with `sessionId=""`, so handler powers
  that need one have nothing to target: `ctx.notify()` has no session to inject
  into, and `ctx.sessionId` is empty. Design page-embedded ops around `ctx.state`
  and explicit `sendMessage(sessionId, …)` to a session you looked up yourself.
- **Attachment is cached at module scope** by `(moveName, cwd, widgetId)`, so it
  survives React unmount/remount. Navigating away and back does not re-attach,
  and therefore does not re-import `context.ts` — see
  [Moves § Reload Semantics](./moves.md).
- **Two embeds of the same move on the same page share one registration** if they
  share a `widgetId`; give them distinct ids to get distinct instances.

### Persistent terminals

The `persistent-terminal` widget is identity-bound, not instance-bound. Its owner
keys are:

```json
{
  "type": "persistent-terminal",
  "ownerType": "page",          // default
  "ownerName": "cockpit:term-a" // distinct value per shell
}
```

`ownerName` is the identity boundary. Two persistent-terminal widgets with the
same `ownerName` share the same pty; different `ownerName`s get distinct
terminals. Harness also issues `ownerType: "action"` terminals, which the
`RightPanel` auto-polls and exposes as tabs (see `RightPanel.tsx`).

### Code editor widget & file viewer linking

`code-editor` (`code-editor.widget.tsx`) calls `useOptionalRightPanelContext()`.
When the editor is inside the app-level `RightPanel`, it uses the shared panel
browser path (synced per session and persisted via `saveSessionUiState`). When
rendered on a page layout, it falls back to local state.

File commands have both pointer/keyboard and touch paths. Desktop clients keep
right-click menus and `Ctrl/Cmd+S`; touch clients get an explicit Save button,
New file/folder and per-item action triggers, with the same commands presented
as a bottom sheet. Core file operations must not depend on hover or a context-menu
gesture alone.

File-open events are routed by three layers:

1. `FileViewerProvider.openFile(path)` — authoritative state (tabs, active path,
   dirty tracking, save). Backend `open-file` UI events are piped here by
   `onUiEvent("open-file", ...)`.
2. App-level hook in `App.tsx`: if the current view is not chat or a custom page,
   opens the app-level right panel to a `code-editor` widget (adding one if
   needed).
3. Page-level hook in `EditablePanel`: switches to the editor tab within the
   page and emits `expand-target` so ancestor splits unfold.

Pages that declare their own `code-editor` widget (like `chat-studio`, `workspace`)
handle file-open internally and the app-level router explicitly skips them
(`if (currentView === "chat" || getCustomPageId(currentView)) return;`).

### Links in rendered messages

A link in an assistant message is classified by `classifyLinkTarget`
(`ui/src/markdown-links.ts`) from the **authored** `href` attribute, never from
`HTMLAnchorElement.href`. The resolved form is relative to the document, and the
desktop webview's document is served from `tauri.localhost`, so an authored
`/C:/build/app.exe` resolves to `http://tauri.localhost/C:/build/app.exe` — not a
path, and not a shareable URL.

Three outcomes:

- **Local paths** (drive-letter, UNC, POSIX absolute, or relative) open through
  `openFile()`, so they land in the same file viewer as every other file route
  above. Both `path#L12[-L18]` and `path:12` are read as line references.
- **Web targets** (`http`/`https`, plus bare `www.`, `localhost`, and IP forms)
  open outside the app: the system browser in the desktop shell, a new tab in a
  browser. The desktop shell must not navigate itself to a link — nothing in the
  window offers a way back.
- **Everything else** — `mailto:`, `tel:`, `file:`, `javascript:`, custom schemes
  — is unclaimed. Modus adds no menu and does not intercept the click.

Right-clicking a claimed link opens a target-specific menu that takes precedence
over the message's selection menu. Copy actions copy the authored path or the
normalized URL. The OS actions (reveal, open with default app) are shown only
when the client is a desktop window driving a **local** backend
(`nativePickerApplies`) and the path is absolute — otherwise the path names a
file on the harness host, or resolves against the desktop process's own
directory. `desktop/src-tauri/src/opener.rs` re-enforces both rules and refuses
any URL scheme outside `http`/`https`, so the boundary does not depend on the
frontend classifying correctly.

### UI state persistence

Widget UI state (collapse, group-mode, etc.) is persisted to `localStorage` via
`useWidgetUiState(scope, widgetId, field, fallback)`:

```
harness:widget-ui:<userProfile or "anon">:<cwd or "global">:<widgetId>:<field>
```

Keys are cwd- and user-scoped, so per-project / per-user UI state is isolated.

---

## 8. Rendering Pipeline

### Entry — `PageView`

`PageView({ blocks, layout, context, padding, onNavigate, onSelectSession, hashSessionId })`:

1. Normalizes the layout via `normalizePageLayoutNode`. This migrates a legacy
   `{ kind: "panel", mode, items }` shape into a current `{ kind: "tabs" | "list",
   children: LayoutLeaf[] }` node.
2. Creates a single `PageStateBus` (stable across re-renders), attaches
   `onNavigate` and `onSelectSession` as bus callbacks.
3. Wraps the tree in `<PageStateBusContext.Provider>` and `<PageUrlProvider
   hashSessionId={...}>`.
4. Applies `padding` once around the root.
5. Delegates rendering to `<PanelTreeRenderer node={normalizedLayout} />`.

If there is no layout, falls back to `<PageRenderer blocks={...} />` (legacy block
path), or — as a special case — renders a single `module` block directly.

### Recursion — `PanelTreeRenderer`

Dispatch by `node.kind`:

- `widget` → `renderLeaf` → `LeafWidget` (widget component or `MoveWidgetEmbed`,
  with `pageContext` + `canNavigate` gating).
- `split` → `ResizableSplit` (drag handles, collapse tabs, `expand-target`
  listener, `containsTarget` probe).
- `overlay` → one isolated CSS grid cell; children recurse in source paint
  order and retain independent visibility conditions.
- `grid` → CSS grid container; children recurse; `columnSpan` / `rowSpan` on
  direct tabs/list children.
- `scope` → `<ScopeProvider>` + `ScopeSessionWatcher` + optional
  `ScopeUrlSessionBinder`. Single child renders as-is; multiple children stack in
  a flex column.
- `tabs` / `list`:
  - `editable: true` → `EditablePanel` (mutable widget list, dynamic tabs).
  - `editable: false|undefined` → static `PanelSurface` with items mapped via
    `renderLeaf`.

### Leaf render — `LeafWidget`

1. Resolves `widgetId` via `getLeafId(leaf, index)` — `leaf.id` → `widget.id` →
   `"<type>-<index+1>"`.
2. Calls `usePageContext(publish, subscribe, canNavigate)` to build the scoped
   handle.
3. Calls `useLeafVisible(showWhen, hideWhen)` — returns `null` if hidden.
4. If `widget.type` starts with `move:` → `MoveWidgetEmbed`.
5. Else looks up `WIDGET_DEFS[type]`; prefers `miniComponent` over `component`.
6. Renders `<Comp config={widget} widgetId active onNavigate onSelectSession
   pageContext />`.

---

## 9. Lifecycle & Navigation

In `App.tsx`:

- On mount and whenever `projectCwd` changes, the client fetches
  `GET /api/pages?cwd=...` into `configPages`.
- `customPages = [...configPages, ...profilePages.filter(id not in configPages)]`.
  Profile-defined pages are merged after config pages with the same dedupe rule.
- Every `page.nav !== false` page becomes a nav entry:
  `{ view: customPageView(page.id), label: page.title }`.
- Visiting a custom page adds its id to `mountedCustomPageIds`. Mounted pages
  stay in the React tree and are hidden via
  `style={{ display: isActive ? "contents" : "none" }}`, so navigating away does
  not rebuild them (keeps session subscriptions, terminal pty handles, and page
  bus state alive).
- The `hashSessionId` is forwarded to the **active** page only — inactive mounted
  pages get `null` so they don't fight over the URL.
- If the current `page:<id>` disappears, the app first waits until page
  discovery is confirmed for the current cwd. With a selected session it
  returns to that session's `chat` route; without a selected session it returns
  to `home`. It never treats the outgoing project's still-loaded page list as
  proof that a destination-project page is absent.

### `fullscreen` pages

When the active page's `fullscreen` is `true`:

- `shouldShowAppPanels = panelsEnabled && !isFullscreenPage` evaluates to `false`.
- `LeftPanel`, `RightPanel`, and their collapse tabs are omitted.

`chat` view special-case: if a project fork of `chat-studio` exists, it replaces
the built-in `ChatView` — the `chat` slot renders `<PageView>` with the fork's
layout. Its `fullscreen` flag controls whether the app-level panels show.

---

## 10. Examples

### `harness/pages/chat-studio.json`

Default chat surface when no project fork exists.

- Single top-level `scope` with `bindUrlSession: true`, `context: { sessionId: null }`.
- 3-column split (1, 3, 1), outer columns collapsible.
- Left: editable tabs (session-list, profiles-manager, moves, actions-manager).
- Center: vertical split with auto-sized top tabs (shown only when no session —
  `showWhen: { sessionId: null }`), main session-chat (`hideWhen: { sessionId:
  null }`), and composer at bottom.
- Right: editable target tabs — sidebar, activity, edits, editor, terminal,
  profile-card. `target: true` means move widgets attach here automatically.

### `harness/pages/chat-mobile.json`

Same scope/context, single editable tabs panel. No split. Widgets toggled via
`showWhen` / `hideWhen`. Good reference for compact layouts.

### `.modus/pages/dual-session.json`

Two side-by-side `scope` subtrees — two independent sessions on one page.
Neither scope binds the URL; session selection is local to each scope.

### `.modus/pages/home.json`

Non-chat dashboard. 3-column collapsible split; center is a vertical split of two
tab panels; outer columns are lists. No scope/context — page has no shared state.

### `.modus/pages/workspace.json`

Shared-state example: page-level `context: { activeSessionId: null }`. The left
session-list publishes selection through `publish: { selectedSession:
"activeSessionId" }`; the center session-chat and right session-sidebar read it
through `subscribe: { sessionId: "activeSessionId" }`. One persistent terminal
tied to the page via `ownerName: "workspace:main"`.

### `.modus/pages/ops.json`

Four `persistent-terminal` widgets in a 2×2 arrangement, plus a right-side list
of process/provider/activity widgets. Demonstrates multi-terminal layout with
distinct `ownerName` values.

### `.modus/pages/notes.json` / `harness/pages/pages.json`

Minimal single-widget pages — root layout is `{ kind: "widget", widget: { ... } }`,
no surrounding chrome.

---

## 11. Relationship to App-Level Panels

The same `LayoutNode` / widget primitives also back the **app-level side panels**
(left and right) via `LayoutProvider` and `PanelTreeRenderer`. Pages use them to
compose a whole screen; panels use them to compose a sidebar. See `panels.md` for
details on side-panel persistence (`UserProfileUiConfig.layouts[view]`) and
per-session state caching in chat view.

Key differences:

| Concern | Pages | App-level panels |
|---------|-------|------------------|
| Source | project/harness JSON, moves/actions/missions, profile | `UserProfileUiConfig.layouts[view]` + defaults |
| Persistence | JSON on disk (fork model) | profile patch via `modus.patchUserProfileUiConfig` |
| Page bus | yes, per page | no (widgets rely on global stores directly) |
| Fullscreen | can disable app panels | always present |
| URL binding | via `scope.bindUrlSession` | chat view reads the URL session directly |
