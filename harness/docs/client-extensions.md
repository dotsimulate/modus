---
title: Client Extensions
lastUpdated: 2026-07-25
lastCommit: bae0487
covers: harness/client-extensions.ts harness/index.ts harness/profiles.ts harness/profile-schemas.ts harness/whisper-credential.ts harness/ui/src/client-extensions.ts harness/ui/src/components/ClientExtensionsBoot.tsx harness/ui/src/components/ChatInput.tsx harness/ui/src/widgets/extensions.widget.tsx .modus/ui/extensions/
---

# Client Extensions

Client extensions are trusted browser-side modules loaded from disk at runtime.
They let the harness, a registered Modus plugin, a configured extension root,
or a project add keyboard shortcuts, composer controls, and authenticated
UI-side behavior without modifying the core frontend bundle.

The current system is intentionally small:
- discovery and serving are handled by the harness backend
- loading and lifecycle are handled by the frontend runtime
- extensions run in the browser as plain JS modules

## Remote backend limitation

This document describes operator-authored or explicitly operator-installed local
extensions. They are trusted local code. It does **not** make a saved remote backend
trusted to supply executable client modules to the privileged desktop renderer.
The native desktop client fails closed here: when connected in remote-backend mode it
does not request or execute backend-supplied client extension modules. Ordinary browser
clients still follow the trusted-backend code model, and managed/external-local desktop
backends may load the operator's local extensions.

## Directory Structure

```
~/.modus/
  plugins.json                 User registry of trusted Modus plugin roots

some-plugin/
  .modus/
    plugin.json                Optional plugin metadata
    ui/
      extensions/              Plugin-mounted client extensions
        modus-autocomplete.js

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

Extension roots come from four layers:

1. built-in harness extensions from `harness/ui/extensions`
2. configured global extension roots from `~/.modus/profiles/_global.json`, `<cwd>/.modus/_global.json`, and user profile UI config
3. enabled plugins from `~/.modus/plugins.json`, mounted from `<plugin>/.modus/ui/extensions`
4. project-local extensions from `<cwd>/.modus/ui/extensions`

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
- built-in extensions default to enabled
- plugin extensions default to enabled when their plugin is enabled
- project-local `.modus/ui/extensions/` modules are auto-discovered when `cwd` is active
- project-local extensions default to enabled
- later layers override earlier layers with the same normalized ID

Path resolution:
- absolute paths stay absolute
- `~/...` expands to the user home directory
- relative paths in `~/.modus/profiles/_global.json` resolve from `~/.modus/profiles/`
- relative paths in `.modus/_global.json` resolve from `.modus/`

Normalized IDs come from the filename stem:
- lowercase
- non-alphanumeric runs become `-`
- surrounding dashes are trimmed

Example: `Whisper Transcribe.js` becomes `whisper-transcribe`.

## Server API

Routes live in `harness/index.ts`.

- `GET /api/plugins` returns registered plugin roots
- `POST /api/plugins` registers a plugin path
- `PATCH /api/plugins/:id` enables/disables or updates a plugin registration
- `DELETE /api/plugins/:id` unregisters a plugin path without deleting files
- `GET /api/client-extensions` returns the manifest for the current `cwd` and `userProfile`
- `GET /api/client-extensions/:id/module` serves the JS module source
- `PATCH /api/client-extensions/:id?userProfile=...` updates per-user enable/disable state and settings

Manifest items include:
- `id`
- `fileName`
- `source` (`"builtin"`, `"plugin"`, `"global"`, or `"project"`)
- `pluginId` / `pluginPath` for plugin-mounted extensions
- `enabled`
- `moduleUrl`
- `meta`
- `settingsValues`

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
- `registerComposerToggle(config)`
- `registerSetting(name, config)`
- `getComposer()`
- `setDraft(text)`
- `insertText(text)`
- `setGhostText(text | null)`
- `focusComposer()`
- `submitComposer(text?)`
- `request(path, init)`

`request()` automatically applies harness auth headers and handles `FormData`
uploads without forcing `Content-Type: application/json`.

### Live Setting Options

`.extension.json` can only declare `select` options statically. Some choices
only exist in the browser — audio input devices being the motivating case — so a
loaded extension can publish them at runtime:

```js
const setting = api.registerSetting("micDevice", {
  options: [{ value: "a1b2c3", label: "Shure MV7" }],
  emptyLabel: "system default",
});
setting.update({ options: nextOptions });
setting.unregister();
```

The extensions widget renders the live list as a dropdown for that setting,
overriding the declared field type. A saved value that is no longer in the list
stays selectable and marked unavailable, so unplugging a device does not
silently rewrite the setting. Options only exist while the extension is loaded;
when it is disabled the manifest-declared field is rendered instead.

### Composer Target

Shortcut handlers and composer actions receive a composer target when one is
available. That target exposes:

- `getSnapshot()`
- `focus()`
- `setDraft(text)`
- `insertText(text)`
- `setGhostText(text | null)`
- `submit(text?)`

The active composer is whichever `ChatInput` was focused most recently. This
lets extensions target both the main chat composer and floating session windows
without DOM queries.

**Hold the handle for deferred work.** The top-level `api.setDraft` / `insertText`
/ `submitComposer` helpers resolve through the *active* composer, and when
nothing has been focused they fall back to whichever composer registered last.
Clicking a composer action focuses the button, not the textarea, so the active
composer may be a different session entirely. An extension that produces output
later — on a timer, or after a network round trip — must keep the composer
target it was handed and call that, or the result lands in an unrelated
composer with no error. The target is a live proxy that re-resolves on every
call, so retaining it across remounts is safe.

## Composer Actions

Extensions can register right-side composer controls rendered by `ChatInput`.

Current action fields:
- `id?`
- `order?`
- `label?`
- `title?`
- `icon?` (currently `"mic"` or `"mic-handsfree"`)
- `disabled?`
- `status?: { label, tone? }`
- `onClick({ composer })`

The returned action handle supports:
- `update(partialState)`
- `unregister()`

Composer actions are rendered near the send/stop controls. Status is shown as a
small chip above the action row.

## Composer Toggles

Extensions can register compact left-side composer toggles for persistent local
features such as autocomplete.

Current toggle fields:
- `id?`
- `order?`
- `label`
- `title?`
- `enabled?`
- `busy?`
- `disabled?`
- `tone?` (`"default"`, `"active"`, `"busy"`, or `"error"`)
- `onToggle({ composer, enabled })`

The returned toggle handle supports:
- `update(partialState)`
- `unregister()`

Toggles are rendered inside the composer, near the top-left edge. `busy: true`
adds a small edge pulse around the toggle; extensions should use that for
short-lived waiting states instead of adding status text.

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

Trust comes from where the extension is loaded from and which IDs are enabled.

The `extensions` widget lists discovered extensions, toggles per-user
enablement, edits extension settings declared by sidecar metadata, and manages
registered plugins.

## Current Example

`harness/ui/extensions/whisper-transcribe.js` is the reference built-in
extension today.
It demonstrates:

- browser audio capture
- WAV encoding in the browser
- authenticated upload to `/api/whisper/transcribe`
- composer-side mic button via `registerComposerAction()`
- a live device dropdown via `registerSetting("micDevice", …)`
- streaming chunk append to the draft
- voice-triggered submit through `composer.submit(text)`

Its `micDevice` setting accepts a device id or any part of a device name; when
nothing matches, capture falls back to the system default and the status chip's
tooltip says so. If the device produces no signal at all for a few seconds the
chip switches to `no input`, which distinguishes a dead or wrong input from a
user who simply is not speaking.

Its `whisperSecretName` setting names a Modus secret rather than holding a key.
Extension settings are stored in the user profile UI config and returned by
`GET /api/client-extensions`, so a literal key would be served to any client
that can list extensions. The harness resolves the named secret and attaches it
as a bearer token — and only to an `https` or loopback endpoint, since the
target URL is itself user-supplied (`harness/whisper-credential.ts`).

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
