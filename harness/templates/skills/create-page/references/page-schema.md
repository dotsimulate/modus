# Page Schema Reference

Use this reference when creating or editing MO harness pages.

## Load Order

Pages are discovered from these sources, with first matching `id` winning:

1. Project standalone: `.modus/pages/*.json`
2. Harness built-ins: `harness/pages/*.json`
3. Move embedded pages: `.modus/moves/*/move.json` and `harness/moves/*/move.json`
4. Action embedded pages: `.modus/actions/*/action.json`
5. Mission embedded pages: `.modus/missions/*/mission.json`
6. User profile pages are merged client-side after config pages

Project standalone pages override all same-id harness pages and embedded pages.

## Page Object

```ts
type ConfigPage = {
  id: string;
  title: string;
  layout?: LayoutNode;
  blocks?: DashboardBlock[];
  layouts?: { mobile?: LayoutNode };
  context?: Record<string, unknown>;
  padding?: number;
  nav?: boolean;
  fullscreen?: boolean;
};
```

Required: `id`, `title`, and one of `layout` or `blocks`.

Field notes:

| Field | Meaning |
|-------|---------|
| `id` | URL/nav key rendered as `page:<id>` |
| `title` | Nav label and page title |
| `layout` | Preferred recursive layout tree |
| `blocks` | Legacy dashboard-card list |
| `layouts.mobile` | Optional mobile-specific layout |
| `context` | Initial page bus state |
| `padding` | Outer padding in pixels |
| `nav` | `false` hides the nav entry |
| `fullscreen` | `true` hides app-level side panels |

## Layout Nodes

### Widget Leaf

```json
{
  "kind": "widget",
  "id": "optional-stable-leaf-id",
  "widget": { "type": "stats", "id": "stats-main" },
  "publish": { "selectedSession": "sessionId" },
  "subscribe": { "sessionId": "activeSessionId" },
  "canNavigate": false,
  "showWhen": { "sessionId": null },
  "hideWhen": { "busy": true }
}
```

The widget `type` must be registered, except `move:<name>` embeds a move widget.
Set stable widget ids for persisted UI state.

### Grid

```json
{
  "kind": "grid",
  "id": "dashboard-grid",
  "columns": 3,
  "gap": 8,
  "templateColumns": ["1fr", "2fr", "1fr"],
  "templateRows": ["auto", "1fr"],
  "children": []
}
```

Use for fixed dashboards. Direct child `tabs` and `list` nodes can use
`columnSpan` and `rowSpan`.

### Split

```json
{
  "kind": "split",
  "id": "workspace-split",
  "axis": "horizontal",
  "sizes": [1, 3, 1],
  "collapsible": [true, false, true],
  "children": []
}
```

Use for resizable workspaces. `axis` is `horizontal` or `vertical`. `sizes` entries
are flex weights or `"auto"`.

### Tabs

```json
{
  "kind": "tabs",
  "id": "right-target",
  "title": "work",
  "activeTab": "editor",
  "columnSpan": 1,
  "rowSpan": 1,
  "editable": true,
  "target": true,
  "children": [
    { "kind": "widget", "widget": { "type": "code-editor", "id": "editor" } }
  ]
}
```

Use `editable: true` when the user can add, remove, or reorder widgets. Use
`target: true` when the panel should receive dynamic move widgets, terminal opens,
file opens, and focus events.

### List

```json
{
  "kind": "list",
  "id": "left-tools",
  "title": "tools",
  "editable": true,
  "children": [
    { "kind": "widget", "widget": { "type": "moves", "id": "moves" } },
    { "kind": "widget", "widget": { "type": "actions-manager", "id": "actions" } }
  ]
}
```

Use for vertical stacks of collapsible widget surfaces.

### Scope

```json
{
  "kind": "scope",
  "id": "chat-scope",
  "context": { "sessionId": null },
  "bindUrlSession": true,
  "children": []
}
```

Scope creates an isolated page state bus for its subtree. Use it for session pages,
multi-session pages, and pages where widgets coordinate through shared state. Only
one scope per page should use `bindUrlSession: true`.

Scope bindings export state between parent and child scopes:

```json
{
  "bindings": [
    { "local": "sessionId", "parent": "leftSessionId", "direction": "twoWay" }
  ]
}
```

`direction` is `up`, `down`, or `twoWay`.

## Page State Bus

Widgets inside a layout receive `pageContext` with:

```ts
{
  get(key): unknown;
  set(key, value): void;
  emit(event): void;
  on(type, handler): unsubscribe;
  observeIntents(handler): unsubscribe;
  navigate?: (view: string) => void;
  selectSession?: (id: string) => void;
  activateSession?: (id: string) => void;
}
```

Use `publish` and `subscribe` on leaves to remap widget keys to page keys. Example:

```json
{
  "kind": "widget",
  "widget": { "type": "session-list", "id": "session-list" },
  "publish": { "selectedSession": "activeSessionId" }
}
```

Then consumers can read:

```json
{
  "kind": "widget",
  "widget": { "type": "session-chat", "id": "chat" },
  "subscribe": { "sessionId": "activeSessionId" }
}
```

## Built-In Widget Types

Current built-ins include:

`account`, `action-card`, `actions-manager`, `agent-activity`, `claude-pricing`,
`code-editor`, `composer`, `config-bar`, `config-inspector`, `deep-analytics`,
`default-agent`, `extensions`, `hints-launcher`, `inbox`, `mission-graph`,
`missions`, `moves`, `new-session`, `notes`, `pages-browser`,
`persistent-terminal`, `processes`, `profile-card`, `profiles-manager`,
`project-theme`, `provider-status`, `provider-usage`, `session-chat`,
`session-control`, `session-edits`, `session-history`, `session-info`,
`session-list`, `session-sidebar`, `session-terminal`, `session-web`, `sessions`,
`stats`, `terminals`, `trace-viewer`.

For the authoritative list, inspect `harness/ui/src/widgets/registry.ts`.

## Special Widget Config

### Move Widget

```json
{ "kind": "widget", "widget": { "type": "move:chess", "id": "chess" } }
```

Embeds a move widget directly by move name.

### Persistent Terminal

```json
{
  "kind": "widget",
  "widget": {
    "type": "persistent-terminal",
    "id": "shell-a",
    "ownerType": "page",
    "ownerName": "ops:shell-a"
  }
}
```

Different `ownerName` values create distinct terminals. Reusing an `ownerName`
intentionally shares the same pty.

## Legacy Blocks

Only use `blocks` when maintaining an existing block page.

```ts
type DashboardBlock =
  | { kind: "widget"; widget: WidgetBase }
  | { kind: "module"; id?: string; title?: string; module: "actions" | "git" }
  | { kind: "text"; id?: string; title?: string; markdown: string };
```

Block pages do not get a page state bus. New pages should use `layout`.

## Validation Checklist

- JSON parses.
- `id` is stable, lowercase, and file-friendly.
- `title` is short enough for nav.
- New pages use `layout`.
- Widget types exist in the registry or use `move:<name>`.
- Editable/target panels have stable ids.
- Persistent terminals have unique `ownerName` values.
- Session pages use `scope`; URL-bound pages have one `bindUrlSession`.
- Project overrides go in `.modus/pages`, not harness built-ins.
