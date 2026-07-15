# Modus Desktop

This directory contains the Tauri v2 desktop shell. The first milestone is an
external-backend client: start Modus normally on `127.0.0.1:3777`, then run the
desktop shell. Closing this shell does not stop that backend.

```powershell
cd desktop
npm install
npm run dev
```

Build the Windows executable without creating an installer:

```powershell
npm run build
```

Managed backend startup, tray lifetime, Job Object supervision, sidecar
packaging, and the installer are intentionally later desktop phases.
