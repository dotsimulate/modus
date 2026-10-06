# Modus Desktop

> **MANAGED-LOCAL + TAILNET TESTER MILESTONE**
>
> A normal local desktop launch now starts the packaged Bun backend, waits for
> its structured readiness record, verifies its private credential, and binds
> the bundled UI to that exact backend. No manually started CLI daemon is
> required for local desktop use.
> The NSIS package still installs the public `modus` console command for
> headless operation, project initialization, maintenance, and named Vaults.
> Desktop and CLI launch the same packaged backend; they own separate process
> lifecycles rather than separate products.
> When Tailnet access is enabled, the same launch also publishes that exact
> managed backend at the machine's stable Tailscale HTTPS URL.

This is not yet a claim that every desktop release criterion is complete. The
old unsigned `v0.1.0` tester asset was withdrawn, and no broadly qualified
Windows installer is currently available. Provider-by-provider authorability, signing,
upgrades, cross-platform packages, and the full lifecycle stress matrix still
require release qualification.

## Existing checkout data

The packaged backend reads the same user-owned paths as current source mode:
`%USERPROFILE%\.modus\data` for SQLite databases and
`%USERPROFILE%\.modus\profiles` for user profiles. Reinstalling or upgrading the
desktop does not replace those paths.

Repo-era developers must run the updated source CLI once before their first
desktop install so legacy `harness\*.db` and `harness\profiles` data can be
copied and verified while the checkout is still available. See **Existing
source-checkout users moving to desktop** in the root README. The desktop does
not guess where an arbitrary old checkout lives, and the installer never
packages the build machine's legacy profile state/history.

## Backend modes

- **Local Modus** is the default. Rust starts the packaged Bun runtime on an
  OS-assigned loopback port and owns its full Windows process tree in a Job
  Object. Persisted Tailnet opt-in is reconciled to that exact dynamic port.
- **Development daemon** connects to an existing local CLI daemon across ports
  3777–3781. The desktop does not own or stop it.
- **Remote backend** connects to a saved Tailscale Serve HTTPS origin. Selecting
  remote mode stops any desktop-owned local backend and does not start another.
  The privileged desktop renderer refuses executable client extensions supplied
  by a remote backend; the backend itself still has its documented machine authority.

The bundled UI receives the managed token over Tauri IPC. The token is not put
in the launch URL or ordinary backend logs. HTTP, SSE, terminal WebSocket,
widget, file, media, and preview traffic continue to share one immutable runtime
target per page load.

## Window and process lifetime

- Closing the main window hides Modus to the system tray. The managed backend
  and its desktop-owned Tailscale route remain available to browsers and
  phones.
- **Show Modus** in the tray restores the existing window.
- **Open Mini Viewer** in the tray, or the mini-viewer button in the chat
  header, opens one compact second window onto a session: tabs over the
  conversation with the composer underneath. It bootstraps like the main
  window, so for a managed backend it attaches to the instance already running.
  **Keep Mini Viewer on Top** (also the pin in the mini viewer's bar, on by
  default) keeps it above other apps while they have focus; an app in exclusive
  fullscreen can still cover it. Closing the mini viewer closes it rather than
  hiding it to the tray, and opening it again for another session re-points the
  existing window.
- **Quit Modus** in the tray or backend-target panel gracefully stops the
  desktop-owned Tailscale route, gracefully stops the backend, waits a bounded
  interval, terminates any remaining Job Object descendants, verifies the
  dynamic port is reusable, and then exits.
- Force-terminating the desktop closes the kill-on-close Job Object, which
  terminates the owned backend/provider process tree.
- A second desktop launch focuses the existing instance and cannot create a
  second managed backend.

## Opening Markdown and text files

The installed desktop offers **Open with Modus** for `.md`, `.markdown`, and
`.txt`. Markdown opens in rendered preview, with the existing Edit and Save
controls available. Files outside registered projects also open. The header
shows the full path and the deepest matching registered project, or **External
file** when no project contains it. Opening a file keeps the selected project
and conversation; it does not send content to an agent or register a new project.

The main window receives file arguments both at startup and from subsequent
launches. Multiple files become tabs in the shared editor. A fullscreen or
custom page without an editor gets a floating file viewer. Relative Markdown
links and images resolve beside the document. Session tab restoration finishes
before queued OS opens are applied, so startup hydration cannot erase the file.

When connected to a remote backend, a notice asks the user to switch to Local
Modus. The desktop keeps the pending paths until a local target claims them;
it never sends client filesystem paths to the remote backend. The mini viewer
does not claim OS file opens. Missing files, directories, and unsupported types
are ignored by the OS handoff rather than executed or read as text.

Windows registration is additive: `file-associations.nsh` registers application
and ProgID entries for **Open with** without changing extension defaults or
`UserChoice`. Uninstall removes only entries whose open command still belongs
to that installation. The Windows bundle override disables Tauri's generated
associations, which would otherwise write extension defaults. macOS uses the
bundle's alternate handler declarations. Registration is an installer/package
operation; editing the checkout does not register file types in the OS.

### Isolated Windows verification

`desktop/tests/file-associations-smoke.ps1` compiles the registration macros into
a small NSIS harness and exercises install, reinstall, and uninstall inside a
unique test registry namespace. It preserves seeded default/UserChoice values
and an entry owned by another installation. It does not alter real associations.
Pass `-MakeNsis` if the compiler is outside Tauri's usual tools cache.

`desktop/tests/file-open-e2e.mjs` drives the real Tauri WebView2 window through
Playwright CDP. It creates isolated homes, credentials, browser data, files,
and an OS-assigned debugging port; Tailnet access stays disabled and uses a
fake CLI. A second desktop process exercises actual single-instance forwarding.
No provider is started. Remote-target notification without queue claiming is
covered separately by `harness/tests/ui/desktopFileOpen.test.ts`.

Run it from a scratch checkout, after frozen dependency installs and the
publication-boundary check. Build the UI, then build a dedicated binary with a
unique identifier and no protocol registration. The driver rejects a normal
desktop binary:

```powershell
bun run --cwd harness/ui build
$env:TAURI_CONFIG = '{"identifier":"com.modus.file-open-smoke","build":{"devUrl":null},"plugins":{"deep-link":{"desktop":{"schemes":[]}}}}'
cargo build --manifest-path desktop/src-tauri/Cargo.toml --locked --features tauri/custom-protocol
Remove-Item Env:TAURI_CONFIG
Copy-Item desktop/src-tauri/target/debug/modus-desktop.exe desktop/src-tauri/target/debug/modus-file-open-smoke.exe
```

The build needs the usual non-packaging sidecar/resource fixtures described
in CI, or staged resources. Install Playwright in a separate temporary tools
directory and pass its `index.mjs` path with `--playwright`. Run:

```powershell
node desktop/tests/file-open-e2e.mjs --exe desktop/src-tauri/target/debug/modus-file-open-smoke.exe --repo . --bun (Get-Command bun).Source --playwright <temporary-tools>/node_modules/playwright/index.mjs
```

The driver checks rendered Markdown, project recognition, external files,
relative links/images, sanitization, multiple and repeated opens, unsupported
files, editing/saving, selected-session preservation, delayed tab hydration,
fullscreen fallback, relative launch arguments, and
no replay after reload. It quits only its own desktop instance and reports
where it saved logs and screenshots. This does not qualify a signed installer
or macOS/Linux behavior.

## Deep links

The desktop registers the `modus://` URL scheme and understands two forms:

```
modus://session/<sessionId>
modus://page/<project>/<pageId>
```

A session link focuses the window and selects that session, switching to the
project that owns it exactly as clicking the session in the sidebar would. If
Modus is not running, the OS starts it and the link is applied once the session
index has loaded, which is what makes that project lookup possible.

A page link switches to the named project and opens the page there, resolved
against the same discovered pages the sidebar nav lists — so pages a project
authored in `.modus/pages/` are addressable without the link layer knowing they
exist. Two registries back the one link kind: pages that declare a layout come
from `GET /api/pages` (harness, project, and move-owned alike), while a move
whose page is a bare widget is reachable under the same
`modus://page/<project>/<moveName>` form. A project or page id that matches
nothing is ignored rather than navigated to.

**Why one form names a project and the other does not.** A session id is
globally unique, so its owning project is *derivable* — encoding one would be
redundant and could contradict the id. A page id is unique only *within* a
project: the same id names different pages in different projects, and even a
built-in page like `git` renders a different project's content, under that
project's theme (`ProfileProvider` applies project UI state from the project
root) and its `interface` config. There the project is not decoration, it is the
missing half of the address. A link kind should carry exactly what cannot be
derived from the rest of it, and no more.

Because project names and page ids are free-form strings in JSON, the link
grammar accepts a conservative subset of them — alphanumeric lead, then
alphanumerics, `.`, `_`, `-`, up to 64 characters per segment. A page whose id
falls outside that is simply not linkable; that is preferred over letting a
segment carry a separator into the frontend's `page:<id>` route string.

**There is deliberately no `modus://move/...`.** Opening a surface is inert;
invoking a move is not, and anything on the machine can hand Modus a URL. A
move is reachable through its page, where the user acts, or not at all.

Neither form carries a **user profile** in the routing sense: the profile
segment of the frontend hash route is a local view preference that the router
seeds from storage when a route omits it, and encoding it would make the same
link resolve differently for different people.

The scheme is registered machine-wide, so any local application — including a
web page the user clicks a link on — can hand Modus a URL. Links are treated as
untrusted input accordingly: `src-tauri/src/deep_link.rs` validates the scheme,
the link kind, and the shape of the id before anything reaches the frontend,
which re-checks it. A link cannot carry a credential, cannot grant authority, is
never evaluated as code, and can only name something that already exists. An
unrecognized link never navigates. It also never raises the window on macOS; on
Windows and Linux a link to an already-running Modus is delivered as a second
process, so the single-instance handler surfaces the window before the link is
inspected.

Note that URL parsing removes dot segments before validation, so a link has more
than one spelling — `modus://page/modus/git/../chat` opens `chat`. What survives
is always the normalized segments.

The browser equivalent needs no scheme — it is an ordinary URL fragment, and
the same routes work there:

```
http://localhost:3777/#<sessionId>
http://localhost:3777/#<project>/page:<pageId>
```

Note that under the desktop shell the managed backend binds an OS-assigned
port, so there is no stable `http://` URL for it; `modus://` exists precisely
because the port moves. To add another link kind, add a host beside `session`
and `page` in `deep_link.rs` rather than making the grammar free-form.

**Scheme registration differs by build.** The NSIS installer registers
`modus://` for installed Windows releases, and Linux and development builds
claim it at runtime during setup. A Windows release built with
`tauri build --no-bundle` is neither, so deep links do not resolve there — test
them from a development build or an installed package.

## Tailnet browser access

Open the desktop backend-target panel and enable **Tailscale Serve** once. The
setting is shared with the existing `modus remote on` preference, so an already
enabled machine needs no extra command: launch Modus Desktop and Rust rebinds
the exact Modus-owned HTTPS `:443` root route after the managed backend is
ready. The stable URL is shown in the panel.

Modus never runs `tailscale serve reset`. It leaves foreign paths, Funnel,
raw-TCP services, other ports, and the existing `:8443` service untouched. A
foreign `:443` rule blocks activation and is reported in the panel. Enabling
Serve without a browser PIN requires a second explicit confirmation; set a PIN
first before exposing Modus to a shared tailnet.

An authenticated browser is an operator-level, full-machine principal with the
same broad local authority as the installed application; it is not restricted
to one project. The PIN protects browser sessions, not the host OS or native
desktop window. Setup, forgotten-PIN reset, and PIN removal are local-machine
operations. PIN changes and authenticated remote lock revoke all browser
sessions and live streams.

The backend continues serving the browser UI, so an iPhone or browser-only
laptop on the same tailnet uses the stable HTTPS URL without installing Modus.
The first browser request after moving the URL from a CLI daemon to the desktop
backend may require signing in with the browser PIN again. Remote-client mode
consumes a saved Tailscale URL and never edits local Serve rules.

## Desktop updates

Update checks are opt-in and at most daily unless the user selects **Check
now**. A configured release build checks a signed HTTPS channel and can label a
release normal, recommended, or critical. Urgency changes presentation only:
download and installation always require user confirmation. The endpoint and
signature public key are compile-time release inputs and are absent from
ordinary builds. The withdrawn unsigned `v0.1.0` build has no updater, so a
future signed bridge release must be installed manually after qualification.

## Development

Run the complete native development stack with one command:

```powershell
modus dev
```

This requires Bun plus the Rust/Cargo toolchain. `modus setup` installs the
root, harness, UI, and desktop JavaScript dependencies from a source checkout.
`bun run dev` from the repository root is the checkout-bound fallback.

Tauri's `beforeDevCommand` runs `stage-managed-backend.ts --dev`. That stages
the managed backend and CLI, starts Vite on the configured development URL, and
then opens the standalone application. React and CSS changes hot-reload in the
window. Restart the command after backend source changes so the managed bundle
is staged again. No separately started browser harness and no installer are
part of this loop.

## Build

The staging command production-builds the UI, bundles the Bun server and CLI,
builds the native console launcher, copies the authored resources, and places
target-triple-named Bun and `modus` sidecars where Tauri expects them:

```powershell
cd desktop
bun install --frozen-lockfile
bun run stage:backend
```

Build the release executable plus its adjacent sidecar/resources:

```powershell
bun run build
```

Build the actual per-user NSIS package:

```powershell
bun run build:bundle
```

Run isolated lifecycle smokes against the release/package layout. These use a
temporary `MODUS_HOME`, never port 3778, and leave any existing daemon alone:

```powershell
.\tests\packaged-lifecycle-smoke.ps1 -Scenario managed
.\tests\packaged-lifecycle-smoke.ps1 -Scenario remote
.\tests\packaged-lifecycle-smoke.ps1 -Scenario close-hide
.\tests\packaged-lifecycle-smoke.ps1 -Scenario job-close
.\tests\packaged-lifecycle-smoke.ps1 -Scenario tailscale
```

The packaged CLI smoke does not start a backend or bind a port. It verifies the
native launcher, bundled CLI, version/help surface, installed/source command
boundary, project initialization, and named-Vault status under an isolated
home:

```powershell
.\tests\packaged-cli-smoke.ps1
```

Installer qualification must additionally start a fresh shell with no
source-checkout Bun link ahead of Modus, verify that `Get-Command modus`
resolves to the NSIS install directory, and verify that uninstall removes only
that exact user-PATH entry.

A macOS or Linux package must be built and process-group-tested on that
platform; the Windows Job Object implementation is intentionally
platform-specific.
