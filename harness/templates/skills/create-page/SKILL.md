---
name: create-page
description: >
  Create MO harness pages and custom dashboard layouts. Use when someone wants
  to add, edit, fork, or design a full app page, dashboard, cockpit, workspace,
  page nav entry, multi-pane layout, terminal page, chat/workbench surface, or
  widget-composed screen in `.modus/pages/*.json`, `harness/pages/*.json`, or an
  embedded `page` declaration on a move/action/mission. Trigger on: "create a
  page", "new page", "dashboard", "workspace page", "custom nav", "page layout",
  "split view", "multi-session page", "terminal dashboard", "widget page",
  "fork page", "edit page", "pages browser".
---

# Create Page

Pages are MO's full-screen layout primitive. They compose registered widgets into
navigation surfaces using JSON layout trees. Prefer pages when the user wants a
place in the app, not only a one-shot move or side-panel widget.

Project pages live at:

```
.modus/pages/<page-id>.json
```

Harness built-ins live at `harness/pages/*.json`. Project pages override harness
pages by `id`, so fork or add a project-local page instead of editing harness
built-ins unless the request is explicitly harness-level.

## Workflow

1. Identify the page scope: project standalone page, harness built-in page, or an
   embedded `page` field on a move/action/mission.
2. Inspect existing pages and widgets before writing:
   - `.modus/pages/*.json`
   - `harness/pages/*.json`
   - `harness/ui/src/widgets/registry.ts`
   - `harness/docs/pages.md` if available
3. Choose `layout` unless maintaining old `blocks` pages. The current renderer is
   layout-first.
4. Pick the smallest useful layout tree:
   - single widget for focused pages
   - `tabs` or `list` for a panel of widgets
   - `split` for resizable workspaces
   - `grid` for fixed dashboards
   - `scope` when widgets need shared state or independent session buses
5. Give every persistent or user-customizable surface stable ids.
6. Write valid JSON. Include `id`, `title`, and either `layout` or `blocks`.
7. Verify with JSON parsing and the project build.

Read [references/page-schema.md](references/page-schema.md) for the compact schema,
node reference, widget list, and examples.

## Placement

Use `.modus/pages/<id>.json` for project pages. This is the default because it
survives harness updates and overrides same-id built-ins.

Use `harness/pages/<id>.json` only when shipping a built-in page with the harness
template itself.

Use an embedded `page` field when a page belongs to a primitive:

```json
{
  "name": "my-move",
  "label": "My Move",
  "page": {
    "id": "my-move",
    "title": "My Move",
    "layout": {
      "kind": "widget",
      "widget": { "type": "move:my-move" }
    }
  }
}
```

## Layout Guidance

Use root `layout`, not legacy `blocks`, for new work. `blocks` does not provide a
page state bus, publish/subscribe mappings, scopes, target panels, split resizing,
or dynamic move/file tabs.

For chat or session pages, wrap the subtree in a `scope` with
`context: { "sessionId": null }`. Set `bindUrlSession: true` on exactly one scope
when the page should mirror the URL's active session.

For pages that should receive dynamic move widgets or opened files, create an
editable target panel:

```json
{
  "kind": "tabs",
  "id": "work-target",
  "title": "work",
  "editable": true,
  "target": true,
  "children": [
    { "kind": "widget", "widget": { "type": "code-editor", "id": "editor" } },
    { "kind": "widget", "widget": { "type": "session-terminal", "id": "terminal" } }
  ]
}
```

For persistent terminals on pages, set a stable owner:

```json
{
  "kind": "widget",
  "widget": {
    "type": "persistent-terminal",
    "id": "main-shell",
    "ownerType": "page",
    "ownerName": "my-page:main"
  }
}
```

## Common Patterns

Single-widget page:

```json
{
  "id": "pages",
  "title": "pages",
  "padding": 12,
  "layout": {
    "kind": "widget",
    "widget": { "type": "pages-browser", "id": "pages-browser-main" }
  }
}
```

Session workspace:

```json
{
  "id": "workspace",
  "title": "workspace",
  "fullscreen": true,
  "padding": 0,
  "layout": {
    "kind": "scope",
    "context": { "sessionId": null },
    "bindUrlSession": true,
    "children": [
      {
        "kind": "split",
        "axis": "horizontal",
        "sizes": [1, 3, 1],
        "collapsible": [true, false, true],
        "children": [
          {
            "kind": "list",
            "id": "left",
            "children": [
              { "kind": "widget", "widget": { "type": "session-list", "id": "sessions" } },
              { "kind": "widget", "widget": { "type": "moves", "id": "moves" } }
            ]
          },
          {
            "kind": "split",
            "axis": "vertical",
            "sizes": [1, "auto"],
            "children": [
              { "kind": "widget", "widget": { "type": "session-chat", "id": "chat" } },
              { "kind": "widget", "widget": { "type": "composer", "id": "composer" } }
            ]
          },
          {
            "kind": "tabs",
            "id": "target",
            "editable": true,
            "target": true,
            "children": [
              { "kind": "widget", "widget": { "type": "code-editor", "id": "editor" } },
              { "kind": "widget", "widget": { "type": "session-terminal", "id": "terminal" } }
            ]
          }
        ]
      }
    ]
  }
}
```

## Quality Bar

Pages should load without console errors, keep layout stable across desktop and
mobile widths, avoid unknown widget types, and use project-local overrides unless
the user explicitly asks to change harness defaults. Run the repo build before
finishing.
