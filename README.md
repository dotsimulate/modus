<p align="center">
  <img src="assets/mo-logo.png" alt="MO" width="240">
</p>

# Modus

Your MO for working with AI agents. Personal infrastructure designed to be forked and customized.

## Architecture

A locally configured agent wrangler designed for you to hone your agents. Built on the Claude Agent SDK — concurrent sessions, configurable profiles, persistent memory, live streaming UI, and scheduled automation from one `bun run dev`.

```
┌──────────────────────────────────┐
│   Frontend — React 19 + Vite     │  :5180
│   Chat, sessions, memory, git    │
└──────────────┬───────────────────┘
               │ REST + SSE
┌──────────────▼───────────────────┐
│   Harness — Hono + Bun           │  :3777
│   Sessions, profiles, scheduler  │
│   SQLite, auth, git integration  │
└──────────────┬───────────────────┘
               │ Agent SDK subprocess
┌──────────────▼───────────────────┐
│   Claude Agent SDK               │
│   Tool execution, MCP, streaming │
└──────────────┬───────────────────┘
               │ MCP (stdio)
┌──────────────▼───────────────────┐
│   Agent Memory — FastMCP/Python  │
│   query() + save() over markdown │
└──────────────────────────────────┘
```

## Quick Start

```bash
git clone https://github.com/dotsimulate/modus.git
cd modus

# Install all deps (harness, UI, agent memory)
./modus.sh setup      # Linux / macOS
.\modus.bat setup     # Windows

# Launch (with watchdog — recommended)
./modus.sh            # Linux / macOS
.\modus.bat           # Windows
```

One command starts the API server (`:3777`) and frontend (`:5180`). First run prompts for a PIN.

**To add modus to an existing project:**

```bash
cd /your/project
modus init            # scaffolds .modus/ with memory MCP and starter profile
```

## Watchdog

`modus.sh` / `modus.bat` wrap the harness in a watchdog that keeps it running unattended.

| Feature | Detail |
|---|---|
| Auto-restart | Restarts on crash, skips clean exits and Ctrl+C |
| Health polling | `GET /health` every 30s — catches hangs, not just crashes |
| Exponential backoff | Quick crashes (< 30s uptime) double the restart delay (3s → 6s → ... → 60s) |
| Git rollback | `MODUS_GIT_ROLLBACK=1` — quick crash + dirty tree → `git stash` and retry |
| Crash log | Appends to `harness/watchdog.log` |
| Push notifications | Optional — via [ntfy.sh](https://ntfy.sh), no account needed |

```bash
# Linux / macOS
./modus.sh              # watchdog only (production)
./modus.sh watch:dev    # watchdog + auto-reload on .ts file changes (development)

# Windows
modus.bat               # watchdog only
modus.bat watch:dev     # watchdog + file watcher
```

**Crash notifications** — subscribe to a free ntfy.sh topic on your phone, then:

```bash
MODUS_NOTIFY_TOPIC=your-topic ./modus.sh
```

You'll get a push with exit code, uptime, and the last 50 lines of stderr when Modus goes down.

## Prerequisites

- [Bun](https://bun.sh) — runtime and package manager
- [uv](https://docs.astral.sh/uv/) — Python package manager (for the memory server)
- [Claude Code](https://claude.com/claude-code) — provides the Agent SDK and CLI

## Profiles

Agent profiles are JSON files in `harness/profiles/`. Each defines model, tools, prompt, permissions, and MCP servers. See `harness/profiles/README.md` for the full schema.

User profiles (`_user_*.json`) scope the UI to a person — project paths, agent profile selection, memory scoping, and persisted UI state.

## License

Private — not yet licensed for distribution.
