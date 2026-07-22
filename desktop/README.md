# Modus Desktop

> **MANAGED-LOCAL + TAILNET TESTER MILESTONE**
>
> A normal local desktop launch now starts the packaged Bun backend, waits for
> its structured readiness record, verifies its private credential, and binds
> the bundled UI to that exact backend. No manually started CLI daemon is
> required for local desktop use.
> When Tailnet access is enabled, the same launch also publishes that exact
> managed backend at the machine's stable Tailscale HTTPS URL.

This is not yet a claim that every desktop release criterion is complete. The
current Windows build is an unsigned tester prerelease, not a broadly qualified
public installer. Provider-by-provider installed-app authorability, signing,
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
  Treat a remote backend as trusted for now: remote-backend-supplied executable
  client extensions are not yet isolated from the privileged renderer.

The bundled UI receives the managed token over Tauri IPC. The token is not put
in the launch URL or ordinary backend logs. HTTP, SSE, terminal WebSocket,
widget, file, media, and preview traffic continue to share one immutable runtime
target per page load.

## Window and process lifetime

- Closing the main window hides Modus to the system tray. The managed backend
  and its desktop-owned Tailscale route remain available to browsers and
  phones.
- **Show Modus** in the tray restores the existing window.
- **Quit Modus** in the tray or backend-target panel gracefully stops the
  desktop-owned Tailscale route, gracefully stops the backend, waits a bounded
  interval, terminates any remaining Job Object descendants, verifies the
  dynamic port is reusable, and then exits.
- Force-terminating the desktop closes the kill-on-close Job Object, which
  terminates the owned backend/provider process tree.
- A second desktop launch focuses the existing instance and cannot create a
  second managed backend.

## Tailnet browser access

Open the desktop backend-target panel and enable **Tailscale Serve** once. The
setting is shared with the existing `modus remote on` preference, so an already
enabled machine needs no extra command: launch Modus Desktop and Rust rebinds
the exact Modus-owned HTTPS `:443` root route after the managed backend is
ready. The stable URL is shown in the panel.

Modus never runs `tailscale serve reset`. It leaves foreign paths, Funnel,
raw-TCP services, other ports, and the existing `:8443` service untouched. A
foreign `:443` rule blocks activation and is reported in the panel. Set a
browser PIN before exposing Modus to a shared tailnet.

An authenticated browser is an operator-level, full-machine principal with the
same broad local authority as the installed application; it is not restricted
to one project.

The backend continues serving the browser UI, so an iPhone or browser-only
laptop on the same tailnet uses the stable HTTPS URL without installing Modus.
The first browser request after moving the URL from a CLI daemon to the desktop
backend may require signing in with the browser PIN again. Remote-client mode
consumes a saved Tailscale URL and never edits local Serve rules.

## Build

The staging command production-builds the UI, bundles the Bun server, copies
the authored resources, and places a target-triple-named Bun sidecar where
Tauri expects it:

```powershell
cd desktop
npm ci
npm run stage:backend
```

Build the release executable plus its adjacent sidecar/resources:

```powershell
npm run build
```

Build the actual per-user NSIS package:

```powershell
npm run build:bundle
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

A macOS or Linux package must be built and process-group-tested on that
platform; the Windows Job Object implementation is intentionally
platform-specific.
