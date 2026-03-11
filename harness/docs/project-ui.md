---
title: Project UI (Themes & Fonts)
audience: agents
lastUpdated: 2026-03-11
lastCommit: cf9d454
---

# Project UI — Themes & Fonts

Per-project visual customization via CSS variable overrides. Themes and fonts
are CSS files registered in `.modus/ui/` and served to the frontend via API.

## Directory Structure

```
.modus/ui/
  theme-registry.json     — registered themes with active selection
  font-registry.json      — registered fonts with active selection
  themes/                 — theme CSS files (one per theme)
    ember-terminal.css
    nocturne-core.css
  fonts/                  — font CSS files (one per font config)
    plex-mono.css
    reading-serif.css
  active/                 — currently active CSS (copies of selected theme/font)
    theme.css
    font.css
```

## How It Works

Themes are CSS files that define `:root` variables. Registration validates
that required variables exist:
- Themes require: `--bg`, `--text`, `--accent`, `--border`
- Fonts require: `--font-sans`, `--font-mono`

Activation copies the selected CSS file to `active/theme.css` or `active/font.css`.
The frontend fetches active CSS from the API and applies variables to `document.documentElement`.

## Registry Format

Each registry (`theme-registry.json`, `font-registry.json`) tracks:
- `version` — schema version
- `activeThemeId` / `activeFontId` — currently active asset
- `themes[]` / `fonts[]` — array of registered assets with id, label, file path, metadata

## API Routes

- `GET /api/ui/state` — full UI state (themes + fonts + active selections)
- `GET /api/ui/themes` — list registered themes
- `GET /api/ui/themes/:id` — single theme details
- `GET /api/ui/theme/active` — active theme CSS + parsed variables
- `POST /api/ui/themes/register` — register a new theme CSS file
- `POST /api/ui/themes/activate` — activate a registered theme
- `PATCH /api/ui/themes/:id` — update label/notes/archived
- Same pattern for `/api/ui/fonts/*`

## Base Styling

The harness ships with default styles in `harness/ui/src/styles/`:
- `colors.css` — ~50 CSS custom properties (the base palette)
- `theme.css` — font families, scale, spacing
- `layout.css` — app structure
- `mobile.css` — responsive overrides
- `components/` — per-component styles
- `views/` — per-view styles

Project themes override these base variables at runtime. The base CSS provides
defaults; active theme CSS provides overrides applied after load.

**Source**: `project-ui.ts`, `harness/ui/src/styles/`.
