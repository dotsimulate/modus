# Modus Desktop

> **INCOMPLETE CLIENT SHELL — NOT A STANDALONE APPLICATION**
>
> The current executable does not contain or start the Modus daemon. A daemon
> must be started manually on the local or remote host before this executable
> can connect. It does not supervise or stop that daemon. Managed backend
> startup, process ownership, tray lifetime, sidecar packaging, and installers
> are not implemented yet.

This directory contains the Tauri v2 desktop shell. It is an external-backend
client: start Modus normally on this computer or another computer in the same
tailnet, then run the desktop shell. Closing this shell does not stop the
backend.

On first launch the app discovers a local daemon across ports 3777–3781. Use the
backend badge in the top status bar or login screen to add a remote target such
as `https://modus-host.<tailnet>.ts.net`. Remote targets must use Tailscale
Serve HTTPS. The selected target, its installation identity, and its login token
are persisted independently from every other backend.

Switching targets reloads the bundled UI atomically so HTTP, SSE, terminal
WebSocket, widget, and media traffic cannot remain split across two daemons. If
the chosen daemon is offline, startup opens the backend chooser instead of a
blank application.

```powershell
cd desktop
npm install
npm run dev
```

Build the Windows client-shell test executable without creating an installer:

```powershell
npm run build
```

Managed backend startup, tray lifetime, Job Object supervision, sidecar
packaging, platform installers, and automatic Tailscale Serve ownership are
later desktop phases. A macOS or Linux client must be built on that platform;
the Windows executable is not cross-platform.
