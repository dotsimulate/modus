---
title: Conversation Lenses
lastUpdated: 2026-08-24
covers: harness/conversation-lenses.ts harness/index.ts harness/lenses/ harness/modus-plugins.ts harness/profiles.ts harness/profile-schemas.ts harness/sdk/types.ts harness/ui/src/widgets/session-chat.widget.tsx harness/ui/src/widgets/conversation-projection.widget.tsx harness/ui/src/components/authored-component-loader.ts harness/ui/src/conversation-lens-resolution.ts harness/ui/src/page-lint.ts harness/scripts/lint-pages.ts .modus/lenses/ .modus/projections/
---

# Conversation Lenses

A conversation lens is a discovered, versioned recipe for arranging the active
session. It reuses the page `LayoutNode` grammar, page state, scopes, widgets,
mobile layouts, and linter, but has conversation-specific selection, source
precedence, capability enforcement, and recovery behavior.

The chat route mounts one core Conversation Host. The host keeps the selected
session, permission requests, queued-send state, and load/error status outside
authored layout control. If a lens is degraded or an authored projection fails,
the host exposes **Open Transcript** in its diagnostic line. A broken or missing
lens therefore cannot strand the conversation.

The built-ins are:

- `core:transcript` — the canonical continuous transcript;
- `core:focus` — a turn index beside one focused turn.

The Chat Display **View** selector shows their labels as **Transcript** and
**Focus**, plus valid discovered authored lenses. It is the only view selector
and persists through the existing device default or project override. Source
and fallback reason appear in the host diagnostic only when something is wrong.

## Locations and precedence

Lens JSON files:

| Source | Path |
|---|---|
| Project | `<cwd>/.modus/lenses/*.json` |
| Current Vault | `<current-home>/lenses/*.json` |
| Plugin | `<plugin>/.modus/lenses/*.json` |
| Harness | `<resources>/lenses/*.json` |

Authored projection modules:

| Source | Path |
|---|---|
| Project | `<cwd>/.modus/projections/<id>/projection.json` plus its component |
| Current Vault | `<current-home>/projections/<id>/projection.json` plus its component |
| Plugin | `<plugin>/.modus/projections/<id>/projection.json` plus its component |
| Harness | `<resources>/projections/<id>/projection.json` plus its component |

Same-id collisions are deterministic: **project → Vault → enabled exposed
plugin → harness**. The registry retains the winning source, and the host shows
it beside a degradation or fallback reason. Shadowed, disabled, invalid, and
incompatible entries remain in registry diagnostics. Paths are not sent to the
browser; the registry uses an opaque source key when requesting a compiled
component.

Plugin files are invisible unless their ids are listed in
`integration.lenses` or `integration.projections`. The plugin must also be
enabled and allowed by the current Vault policy. Policy and source identity are
checked again when a component module is requested.

The `core:` namespace is reserved for harness resources.

## Lens contract

Every file is one `conversation-lens@1` object:

```json
{
  "contract": "conversation-lens@1",
  "id": "project:reader",
  "label": "Reader",
  "description": "A turn rail beside the focused turn.",
  "fallback": "core:transcript",
  "capabilities": {
    "required": [
      "conversation.permissions",
      "conversation.turn-content",
      "conversation.turn-index"
    ],
    "optional": [
      "conversation.history",
      "conversation.compose",
      "conversation.artifacts"
    ]
  },
  "layout": {
    "kind": "split",
    "axis": "horizontal",
    "sizes": [1, 4],
    "children": [
      {
        "kind": "widget",
        "widget": {
          "type": "session-turns",
          "id": "reader-index",
          "labels": false,
          "header": false
        },
        "publish": { "turnNumber": "turnNumber", "turnSeq": "turnSeq" }
      },
      {
        "kind": "widget",
        "widget": {
          "type": "session-turn",
          "id": "reader-turn",
          "blocks": ["prompt", "thinking", "text", "meta"]
        }
      }
    ]
  },
  "layouts": {
    "mobile": {
      "kind": "widget",
      "widget": {
        "type": "session-turn",
        "id": "reader-turn-mobile",
        "blocks": ["prompt", "thinking", "text", "meta"]
      }
    }
  },
  "context": {
    "turnNumber": null,
    "turnSeq": null,
    "turnSessionId": null
  }
}
```

`layout`, `layouts.mobile`, and `context` are page-native. All normal layout
nodes, widget `publish`/`subscribe`, `showWhen`/`hideWhen`, targets, and nested
scopes remain available. See `pages` for that grammar.

An `overlay` node paints every child into the same bounds. The first child is
the base; later children paint above it in source order. The renderer makes
upper layer wrappers pass pointer input through by default, so transparent
pixels do not block the conversation underneath. Interactive descendants in an
upper widget must explicitly set `pointer-events: auto`; a fully interactive
upper widget can set that on its root. This supports heads-up controls and
visual annotation without giving authored projection code the canonical turn
body.

When an overlaid index owns turn selection, set `navigation: false` on the
underlying `session-turn` widget to suppress its compact previous/next control.
The default remains `true`.

For a bare navigation rail, set both `labels: false` and `header: false` on
`session-turns`. That combination removes the turn total and index-status row
and uses compact mark padding so the numbers fit a narrow split. Larger indexes
retain the header and list padding by default.

`id` must match `/^[a-z0-9][a-z0-9._:-]*$/`. `label` and `layout` are required.
Unknown contract versions are incompatible, not silently interpreted.

### Capabilities

Version 1 recognizes exactly six capability ids:

| Capability | Meaning in v1 |
|---|---|
| `conversation.permissions` | Host-owned permission surface; authors cannot remove it |
| `conversation.turn-content` | Canonical loaded turn content |
| `conversation.turn-index` | Whole-session bodiless turn index plus loaded live turns |
| `conversation.compose` | A send-capable conversation composition is available |
| `conversation.history` | Older-history and deferred-detail actions are available |
| `conversation.artifacts` | Canonical Transcript can expose attached artifacts |

Runtime status is `available`, `unavailable`, `degraded`, or `disabled`, with a
reason and contract version. A required unavailable/disabled capability rejects
the lens. A degraded capability may run with its reason visible. Optional
capabilities may be absent because lossless behavior means **reachable through
Transcript**, not drawn by every lens. The client initially holds only a page of
history and may defer heavy detail, so no overview should claim full in-place
session parity.

The fallback chain is requested id → that lens's declared fallback → configured
default → `core:transcript`. The requested id and first failure reason are kept
for the UI. Project changes wait for discovery for the destination cwd; they do
not reuse the outgoing project's registry for one render and do not route a
selected session to the dashboard.

## Adding a JSON lens to a project

1. Create `<project>/.modus/lenses/<name>.json` with the contract above.
2. Give every widget a stable `id`. Seed shared keys in `context` and use
   `publish`/`subscribe` when widgets coordinate.
3. Add a deliberate `layouts.mobile`; desktop fallback is not considered a
   first-class phone design.
4. For overview or read-only layouts, set `fallback: "core:transcript"`.
5. From `harness/`, run:

   ```text
   bun run scripts/lint-pages.ts ../.modus/lenses/<name>.json
   ```

6. Reload the client, open Chat Settings, and choose the lens under **View**.

JSON lens edits require no core rebuild. The registry is fetched per project.
The persisted default is the open-world `interface.chat.lensId`; legacy
`presentation: "conversation" | "turns"` remains read-only migration input and
maps to Transcript or Focus.

## Authored projections

A projection is trusted local React composed through the registered
`conversation-projection` widget. It is not a move: it has no move token,
instance, attachment, API ops, or empty-session page-embed lifecycle.

`projection.json`:

```json
{
  "contract": "conversation-projection@1",
  "id": "contact-sheet",
  "label": "Conversation Contact Sheet",
  "description": "A compact real-data turn overview.",
  "component": "component.tsx",
  "cache": "none",
  "capabilities": {
    "consumes": ["conversation.turn-index", "conversation.history"],
    "provides": ["conversation.turn-index"]
  },
  "modes": ["overview", "live", "read-only"]
}
```

`component` must be a relative path that stays inside the projection directory
and must exist. `cache` is `module` (reuse the imported module) or `none`
(evict on unmount; useful while authoring). Modes are `lossless`, `overview`,
`live`, and `read-only`.

Use it in a lens:

```json
{
  "kind": "widget",
  "widget": {
    "type": "conversation-projection",
    "id": "reader-contact-sheet",
    "projectionId": "contact-sheet"
  },
  "publish": {
    "turnNumber": "turnNumber",
    "turnSeq": "turnSeq"
  }
}
```

The project Contact Sheet proof is intentionally installed only as a projection
under `.modus/projections/contact-sheet/`. It has no matching top-level lens and
does not appear in Chat Display's View picker; authors opt into it by composing
the widget above inside a lens recipe.

The component default export receives `ConversationProjectionPropsV1`:

```ts
type ConversationProjectionPropsV1 = {
  contract: "conversation-projection@1";
  projection: { id: string; label: string; source: ConversationResourceSource };
  session: { id: string; cwd?: string; status?: string };
  turns: Array<SessionTurnIndexEntry & {
    loaded: boolean;
    deferred: boolean;
    promptPreview?: string;
  }>;
  turnIndexSource: "messages" | "events" | "loaded";
  partial: boolean;
  selectedTurnNumber: number | null;
  history: {
    hasMore: boolean;
    loadingOlder: boolean;
    olderTurnCount: number;
    error?: string;
  };
  selectTurn(number: number, seq: number): void;
  loadOlder(): Promise<void>;
  loadDetails(seq: number): Promise<void>;
};
```

Indexed-but-unloaded turns intentionally have no fabricated preview. `partial`
and `history.olderTurnCount` tell the component that the client window is not
the whole session; `deferred` tells it loaded content still contains a heavy
detail marker. Live loaded turns may extend a stale server index immediately.

The server compiles the component on request with React/JSX runtimes supplied
by the host. Build failures and runtime exceptions are visible in the host and
force the safe Transcript fallback. Component loads are aborted and blob URLs
are revoked on lens, project, profile, or session changes.

### Trust boundary

Project, Vault, and enabled plugin projection code is **trusted local code**. It
runs in the client, not in an iframe sandbox. Review it with the same care as a
client extension or move widget. Modus does not load authored projection code
when `BACKEND_TARGET.mode` is `remote`; remote execution fails closed. There is
no Vault/plugin lens-management screen in v1.

## Plugin exposure

Add both the public integration ids and content declarations:

```json
{
  "integration": {
    "lenses": ["plugin:ledger"],
    "projections": ["outcome-ledger"]
  },
  "contents": {
    "lenses": { "mode": "merge" },
    "projections": { "mode": "merge" }
  }
}
```

An unlisted file is not discoverable. A disabled or Vault-disallowed plugin is
reported as disabled and its module route will not serve code.

## APIs and diagnostics

- `GET /api/conversation-lenses?cwd=<cwd>` returns
  `conversation-resources@1`: winners, projections, source identity, and
  diagnostics.
- `GET /api/conversation-projections/<id>/module?cwd=<cwd>&source=<opaque-key>`
  serves the compiled local module after re-resolution.
- `ModusClient.listConversationResources(cwd, signal?)` is the typed SDK call.
- `bun run scripts/lint-pages.ts` lints pages and lenses. It checks the normal
  page geometry plus required/optional capability coverage, projection
  availability, mobile intent, and Transcript recovery.

The host shows concise source and fallback/build/runtime reasons because a
packaged desktop has no devtools. Invalid content never silently replaces the
canonical Transcript.
