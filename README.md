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

# Install deps
cd harness && bun install && cd ui && bun install && cd ../..

# Configure MCP — edit the absolute path in _global.json to match your machine
# harness/profiles/_global.json

# Launch
cd harness
bun run dev
```

One command starts the API server (`:3777`) and frontend (`:5180`). First run prompts for a PIN. Works on Linux, macOS, and Windows.

## Prerequisites

- [Bun](https://bun.sh) — runtime and package manager
- [uv](https://docs.astral.sh/uv/) — Python package manager (for the memory server)
- [Claude Code](https://claude.com/claude-code) — provides the Agent SDK and CLI

## Profiles

Agent profiles are JSON files in `harness/profiles/`. Each defines model, tools, prompt, permissions, and MCP servers. See `harness/profiles/README.md` for the full schema.

User profiles (`_user_*.json`) scope the UI to a person — project paths, agent profile selection, memory scoping, and persisted UI state.

## License

Private — not yet licensed for distribution.
