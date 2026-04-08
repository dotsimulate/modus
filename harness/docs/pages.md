---
title: Pages
audience: agents
lastUpdated: 2026-04-08
covers: harness/pages.ts harness/index.ts harness/ui/src/App.tsx harness/ui/src/components/PageRenderer.tsx harness/ui/src/widgets/index.ts .modus/pages/cockpit.json .modus/pages/terminals-2x2.json
---

# Pages

Custom pages are project-scoped dashboard definitions loaded from `.modus/pages/*.json`
under the active `cwd`. They augment the built-in view registry with page entries that
render either legacy block stacks or the current layout tree format.

## Load Path

| Layer | Source |
|-------|--------|
| Project files | `.modus/pages/*.json` |
| Backend loader | `harness/pages.ts` via `listConfigPages(cwd)` |
| HTTP route | `GET /api/pages?cwd=...` in `harness/index.ts` |
| Frontend fetch | `harness/ui/src/App.tsx` on `projectCwd` change |
| Navigation | `customPageView(page.id)` entries appended to `navViews` |

`listConfigPages(cwd)` scans `.json` files only, parses each file, normalizes both
single-page and multi-page wrappers, adds a `source` path, and drops duplicate page ids
after the first occurrence.

## Config Shape

Single page:

```json
{
  "id": "page-id",
  "title": "page title",
  "blocks": [],
  "layout": {},
  "padding": 0
}
```

Multi-page wrapper:

```json
{
  "pages": [
    { "id": "one", "title": "one", "layout": {} },
    { "id": "two", "title": "two", "blocks": [] }
  ]
}
```

Backend type shape from `harness/pages.ts`:

```ts
export type ConfigPage = {
  id: string;
  title: string;
  blocks?: PageBlock[];
  layout?: PageLayoutNode;
  padding?: number;
  source?: string;
};
```

`blocks` or `layout` is required for a page to be treated as valid by `isConfigPage()`.

## Block Pages

Legacy/simple pages use `blocks: DashboardBlock[]` and render through `PageRenderer`
as the same collapsible card shells used by the dashboard.

Supported block kinds:

```ts
type DashboardBlock =
  | { kind: "widget"; widget: WidgetBase }
  | {
      kind: "module";
      id?: string;
      title?: string;
      size?: WidgetSize;
      module: "actions" | "git";
      collapsed?: boolean;
    }
  | {
      kind: "text";
      id?: string;
      title?: string;
      size?: WidgetSize;
      markdown: string;
      collapsed?: boolean;
    };
```

Behavior:
- `widget` blocks resolve `widget.type` through `WIDGETS`.
- `module` blocks render built-in `Actions` or `GitPanel`.
- `text` blocks render markdown through `Markdown`.
- Each block gets persisted collapse state via `useWidgetUiState`.

If a page contains exactly one `module` block, `PageView` bypasses the card shell and
renders the module directly.

## Layout Pages

Current pages use `layout: PageLayoutNode`, rendered by `LayoutNodeView` and
`PagePanelNode` in `harness/ui/src/components/PageRenderer.tsx`.

```ts
export type PageLayoutNode =
  | {
      kind: "grid";
      id?: string;
      columns: number;
      gap?: number;
      templateColumns?: string[];
      templateRows?: string[];
      children: PageLayoutNode[];
    }
  | {
      kind: "panel";
      id?: string;
      title?: string;
      mode?: "list" | "tabs";
      columnSpan?: number;
      rowSpan?: number;
      items: PagePanelItem[];
    };

export type PagePanelItem =
  | { kind: "widget"; widget: WidgetBase };
```

Grid nodes:
- Render as CSS grid containers.
- Use `templateColumns` or fall back to `repeat(columns, minmax(0, 1fr))`.
- Use `templateRows` when provided; otherwise rows auto-fill with `minmax(0, 1fr)`.
- Recurse into `children`.

Panel nodes:
- Render through shared `PanelSurface`.
- Support `mode: "list" | "tabs"`; default is `"tabs"`.
- Respect `columnSpan` and `rowSpan` when nested under a grid.
- Convert `items` into `PanelSurfaceItem[]` with widget height hints from `WIDGET_DEFS`.

`padding` is applied by `PageView` around the top-level layout container.

## Widget References

Pages do not inline widget components directly. They reference widget configs by type:

```ts
type WidgetBase = {
  id?: string;
  type: string;
  title?: string;
  size?: "full" | "half" | "third";
  collapsed?: boolean;
};
```

Rules:
- `type` must match a registered widget in `harness/ui/src/widgets/*.widget.tsx`.
- `id` should be unique per widget instance. The renderer synthesizes a fallback id, but
  explicit ids are safer because collapse state and other per-instance UI state key off id.
- Unknown widget types render an `unknown widget: <type>` placeholder.

For page-scoped persistent terminals, use:

```json
{
  "type": "persistent-terminal",
  "ownerType": "page",
  "ownerName": "pageid:label"
}
```

`ownerName` is the identity boundary. Distinct values create distinct persistent terminals
even when the widget type is the same.

## Lifecycle

`harness/ui/src/App.tsx` drives page lifecycle:

- On app mount and whenever `projectCwd` changes, the client fetches `GET /api/pages?cwd=...`.
- Pages from `.modus/pages` are merged ahead of `activeUP.dashboard.pages`; matching ids in
  config files override profile-defined pages.
- Each page becomes a nav entry using `view: "page:<id>"`.
- When a custom page is first visited, its id is added to `mountedCustomPageIds`.
- Mounted pages stay in the React tree and are hidden with `display: "contents"`/`"none"`
  switching, so navigating away does not rebuild them.
- If the current `page:<id>` no longer exists after reload, the app redirects to `home`.

## Working Examples

`.modus/pages/cockpit.json`:
- Six-column grid with explicit `templateColumns` and `templateRows`.
- Mixes list and tab panels.
- Uses page-owned persistent terminals (`cockpit:term-a` through `cockpit:term-d`).
- Includes non-terminal widgets such as `session-list`, `code-editor`, `terminals`, and `processes`.

`.modus/pages/terminals-2x2.json`:
- Minimal 2x2 grid.
- Four tab panels, each containing one `persistent-terminal`.
- Good reference for the smallest useful layout-page config.
