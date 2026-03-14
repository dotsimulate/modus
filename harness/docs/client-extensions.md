---
title: Client Extensions
audience: agents
lastUpdated: 2026-03-13
lastCommit: bae0487
covers: harness/client-extensions.ts harness/index.ts harness/profiles.ts harness/profile-schemas.ts harness/ui/src/client-extensions.ts harness/ui/src/components/ClientExtensionsBoot.tsx harness/ui/src/components/ChatInput.tsx .modus/ui/extensions/
---

# Client Extensions

Client extensions are trusted browser-side modules loaded from disk at runtime.
They let a project or a configured extension root add keyboard shortcuts,
composer actions, and authenticated UI-side behavior without modifying the core
frontend bundle.

The current system is intentionally small:
- discovery and serving are handled by the harness backend
- loading and lifecycle are handled by the frontend runtime
- extensions run in the browser as plain JS modules

## Directory Structure

```
.modus/
  _global.json                 Project-local config (may set clientExtensions)
  ui/
    extensions/                Project-local client extensions
      whisper-transcribe.js

harness/
  client-extensions.ts         Server-side discovery + precedence
  ui/src/client-extensions.ts  Frontend runtime + composer bridge
  ui/src/components/ClientExtensionsBoot.tsx
```

## Resolution and Precedence

Extension roots come from three layers:

1. `harness/profiles/_global.json`
2. `<cwd>/.modus/_global.json`
3. `profiles/users/<name>.json`

The config shape is:

```json
{
  "clientExtensions": {
    "paths": ["~/my-extensions"],
    "enabled": ["some-extension"],
    "disabled": ["other-extension"]
  }
}
```

Rules:
- `paths` adds trusted global extension roots on disk
- `enabled` turns on discovered global extensions by normalized ID
- `disabled` explicitly turns an extension off
- project-local `.modus/ui/extensions/` modules are auto-discovered when `cwd` is active
- project-local extensions default to enabled
- project-local extensions override global ones with the same normalized ID

Path resolution:
- absolute paths stay absolute
- `~/...` expands to the user home directory
- relative paths in `harness/profiles/_global.json` resolve from `harness/profiles/`
- relative paths in `.modus/_global.json` resolve from `.modus/`

Normalized IDs come from the filename stem:
- lowercase
- non-alphanumeric runs become `-`
- surrounding dashes are trimmed

Example: `Whisper Transcribe.js` becomes `whisper-transcribe`.

## Server API

Routes live in `harness/index.ts`.

- `GET /api/client-extensions` returns the manifest for the current `cwd` and `userProfile`
- `GET /api/client-extensions/:id/module` serves the JS module source

Manifest items include:
- `id`
- `fileName`
- `source` (`"project"` or `"global"`)
- `enabled`
- `moduleUrl`

Only `.js` and `.mjs` files are served. The harness does not transpile TS/TSX
extension files.

## Frontend Lifecycle

`ClientExtensionsBoot` runs once per active `cwd` / user-profile pair:

1. fetch manifest from `/api/client-extensions`
2. unload any currently loaded extensions
3. `import()` each enabled module
4. call its load hook

Supported module shapes:
- `export default function (api) { ... }`
- `export default { onLoad(api) { ... } }`
- `export const extension = ...` with the same shapes

If the load hook returns a function, that function is used as cleanup during
unload or profile/project switches.

## Runtime API

The frontend runtime exposes a narrow API to extensions:

- `registerShortcut(binding, handler)`
- `registerComposerAction(config)`
- `getComposer()`
- `setDraft(text)`
- `insertText(text)`
- `focusComposer()`
- `submitComposer(text?)`
- `request(path, init)`

`request()` automatically applies harness auth headers and handles `FormData`
uploads without forcing `Content-Type: application/json`.

### Composer Target

Shortcut handlers and composer actions receive a composer target when one is
available. That target exposes:

- `getSnapshot()`
- `focus()`
- `setDraft(text)`
- `insertText(text)`
- `submit(text?)`

The active composer is whichever `ChatInput` was focused most recently. This
lets extensions target both the main chat composer and floating session windows
without DOM queries.

## Composer Actions

Extensions can register right-side composer controls rendered by `ChatInput`.

Current action fields:
- `id?`
- `order?`
- `label?`
- `title?`
- `icon?` (currently only `"mic"`)
- `disabled?`
- `status?: { label, tone? }`
- `onClick({ composer })`

The returned action handle supports:
- `update(partialState)`
- `unregister()`

Composer actions are rendered near the send/stop controls. Status is shown as a
small chip above the action row.

## Trusted Code Model

Client extensions are trusted local code. They run in the browser with the same
session auth context as the frontend.

That means an extension can:
- call authenticated harness routes via `request()`
- read and modify the active composer draft
- submit messages via `submitComposer()` / `composer.submit()`
- register global browser shortcuts

There is currently:
- no per-extension permission prompt
- no sandbox for extension modules
- no dedicated UI listing loaded extensions

Trust comes from where the extension is loaded from and which IDs are enabled.

## Current Example

`.modus/ui/extensions/whisper-transcribe.js` is the reference extension today.
It demonstrates:

- browser audio capture
- WAV encoding in the browser
- authenticated upload to `/api/whisper/transcribe`
- composer-side mic button via `registerComposerAction()`
- streaming chunk append to the draft
- voice-triggered submit through `composer.submit(text)`

## Recommended Pattern

Use the runtime seam, not DOM coupling.

Good:
- `composer.setDraft(...)`
- `composer.submit(...)`
- `registerComposerAction(...)`

Bad:
- querying the send button in the DOM
- mutating React internals
- assuming only one composer exists
