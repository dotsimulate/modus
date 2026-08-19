---
title: Client Extensions
lastUpdated: 2026-08-19
lastCommit: a1e724a
covers: harness/settings-schema.ts harness/client-extensions.ts harness/index.ts harness/profiles.ts harness/profile-schemas.ts harness/whisper-credential.ts harness/whisper-endpoint.ts harness/ui/src/client-extensions.ts harness/ui/src/components/ClientExtensionsBoot.tsx harness/ui/src/components/ChatInput.tsx harness/ui/src/widgets/extensions.widget.tsx .modus/ui/extensions/
---

# Client Extensions

Client extensions are trusted browser-side modules loaded from disk at runtime.
They let the harness, a registered Modus plugin, a configured extension root,
or a project add keyboard shortcuts, composer controls, and authenticated
UI-side behavior without modifying the core frontend bundle.

`<current-home>` below means Main's Modus home for Main or the registered folder
root for a named Vault. Extension settings and plugin registrations are Vault-local.

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
<current-home>/
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
2. configured Vault extension roots from `<current-home>/profiles/_global.json`, `<cwd>/.modus/_global.json`, and user profile UI config
3. enabled plugins from `<current-home>/plugins.json`, mounted from `<plugin>/.modus/ui/extensions`
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
- relative paths in `<current-home>/profiles/_global.json` resolve from `<current-home>/profiles/`
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
- `getSettings()`

`request()` automatically applies harness auth headers and handles `FormData`
uploads without forcing `Content-Type: application/json`. `getSettings()` returns
this extension's current settings values from the user profile UI config.

### Capability Ceiling

That list is the entire runtime surface. Two limits follow from it, and neither
produces an error when you hit it, so they are worth stating outright:

- **Extensions cannot render their own UI.** There is no mount point — no way to
  register a component, panel, page, or overlay. The only extension-owned pixels
  are composer actions and toggles, and `ChatInput` owns how those are rendered.
  Anything that needs a surface of its own is a widget or a page, not an extension.
- **Extensions cannot subscribe to session activity.** Nothing in the API delivers
  assistant messages, turn boundaries, or session lifecycle events. An extension
  acts when the user triggers it: a shortcut, a composer action, a toggle.

These are limits of the runtime API, not a sandbox. Extensions are plain browser
modules, so they can reach any Web API directly and can poll authenticated harness
routes through `request()`. Both are unsupported seams rather than walls: they sit
outside the runtime's lifecycle, so anything built that way must tear itself down
in the cleanup function returned from the load hook, and it will not follow
project or profile switches the way registered controls do.

`whisper-transcribe` fits inside this ceiling because dictation only ever writes
into a draft. That is not evidence that voice features in general fit — a feature
that must display something, or react to what the agent said, does not.

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

### Declared Setting Types

`.extension.json` settings declare a `type` (`ExtensionSettingSchema` in
`harness/settings-schema.ts`, re-exported by `sdk/types.ts` and by
`harness/client-extensions.ts` — one declaration, three places to import it
from):

| `type` | Rendered as | Notes |
|---|---|---|
| `string` | single-line text | also the fallback for an unknown type |
| `textarea` | multi-line text, `rows` (default 4) | for one-value-per-line lists; does not soft-wrap, so a long line reads as one entry |
| `number` | number input, honoring `min`/`max`/`step` | empty clears to `null` |
| `boolean` | checkbox | |
| `select` | dropdown from `options[]` | static only; see Live Setting Options above |
| `secret-name` | single-line text | names a Modus secret; see below |

`min` and `max` are inclusive and are enforced on the write path as well as in
the form: the input attributes only constrain the rendered control, and any
client can `PATCH` whatever it likes, so `PATCH /api/client-extensions/:id`
rejects an out-of-range number with a 400. `step` is advisory — it sets the
stepper's granularity and is never used to reject a value the user typed
deliberately.

`secret-name` is not a password field, on purpose. The value is the *name* of a
secret, not the secret — extension settings are stored in the user profile UI
config and returned verbatim by `GET /api/client-extensions`, so a literal key
placed in a setting would be served to every client that can list extensions.
The harness resolves the named secret server-side and the key never reaches the
browser, which also means masking the field would hide the one thing the user
needs to read back to check they typed it correctly.

Each setting also renders its `description` beneath the control, so that string
is the place to explain a field rather than a comment in the manifest.

### Setting Scope

A setting declares where its value lives, with the same vocabulary plugin
settings use:

| `scope` | Stored in | Use for |
|---|---|---|
| `user` (default) | the caller's user profile UI config | values that describe the client doing the talking |
| `global` | `<current-home>/profiles/_global.json` under `clientExtensions.settings` | values the current Vault consumes |

This distinction is load-bearing, not cosmetic. Client-extension settings
resolve per user profile, and a phone seeds its own profile from `localStorage`,
so a `user`-scoped value set on the desktop simply does not exist on any other
client. That is correct for something like `micDevice`, which names local
hardware and *should* differ per device. It is wrong for anything the backend
acts on.

`whisperUrl` is the worked example. The harness performs the transcription
fetch, so the endpoint is its configuration — but it was stored per profile and
sent up from the browser, so a phone whose profile had never been configured
sent nothing, the route fell back to its loopback default, the backend dialled
itself, and the user saw an unexplained `502`. It is `scope: "global"` now, and
the route resolves it server-side rather than trusting the request.

Rule of thumb: if the *backend* reads the value, it is `global`. If the
*browser* reads it, or it names something local to one device, it is `user`.

Global-scoped values are resolved without the user-profile layer so every client
agrees on them, falling back to a per-profile value for installs configured
before the setting declared a scope. The extensions widget labels them `shared by
every client`, because changing one from the desktop changes it everywhere.

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
