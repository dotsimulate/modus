# Agent Dev Zone

A self-learning agent workspace built on Claude Code. Persistent memory, configurable profiles, session management, and a live chat UI — all running locally.

## What This Is

A lightweight harness that wraps the [Claude Agent SDK](https://github.com/anthropics/claude-code) with:

- **Session management** — multiple concurrent agent sessions with SQLite persistence
- **Live streaming UI** — React frontend with real-time thinking, tool calls, and chat
- **Agent profiles** — preconfigured personas (dev, research, test) with enforced tool access
- **Persistent memory** — MCP server that gives agents recall across sessions via markdown files
- **Learnable skills** — reusable workflow patterns agents can invoke automatically

## Architecture

```
┌──────────────────────────────────┐
│   Frontend — React 19 + Vite     │  :5180
│   Chat, sessions, tool config    │
└──────────────┬───────────────────┘
               │ REST + SSE
┌──────────────▼───────────────────┐
│   Harness — Hono + Bun           │  :3777
│   Session CRUD, event streaming  │
│   SQLite persistence, profiles   │
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

## Directory Structure

```
.
├── CLAUDE.md              # Agent behavior rules (the constitution)
├── .mcp.json.example      # MCP config template (copy to .mcp.json)
├── harness/
│   ├── index.ts           # Hono API server
│   ├── session-manager.ts # Agent lifecycle + event streaming
│   ├── profiles.ts        # Agent profile definitions
│   ├── db.ts              # SQLite schema + queries
│   ├── dev.ts             # Cross-platform dev launcher
│   └── ui/                # React frontend (Vite)
├── agent_memory/
│   ├── server.py          # FastMCP memory server
│   └── memory/            # Stored memories (gitignored)
├── .claude/
│   └── skills/            # Reusable agent skills
└── research_output/       # Architecture research docs
```

## Prerequisites

- [Bun](https://bun.sh) — runtime and package manager
- [uv](https://docs.astral.sh/uv/) — Python package manager (for the memory server)
- [Claude Code](https://claude.com/claude-code) — provides the Agent SDK and CLI

All three run natively on Linux, macOS, and Windows.

## Quick Start

```bash
git clone <repo-url>
cd agent_dev_zone

# Install deps
cd harness && bun install && cd ui && bun install && cd ../..

# Configure MCP (agent memory server)
cp .mcp.json.example .mcp.json
# Edit .mcp.json — set the absolute path to agent_memory/ on your machine

# Launch
cd harness
bun run dev
```

That's it. One command starts both the harness API (`:3777`) and the frontend (`:5180`), auto-generates a bearer token, and prints LAN URLs. Works on Linux, macOS, and Windows — no bash required.

The memory server starts automatically via `.mcp.json` when an agent session spawns.

## Profiles

| Profile | Model | Max Turns | Tools | Use Case |
|---------|-------|-----------|-------|----------|
| `test-harness` | Haiku 4.5 | 3 | Read-only | Quick testing |
| `dev-agent` | Opus 4.6 | 25 | All | Full development |
| `research` | Sonnet 4.6 | 15 | Read + web | Research, no file modification |

Profiles are defined in `harness/profiles.ts` and enforced server-side.

## Agent Memory

The memory system is an MCP server that agents access via two tools:

- **`query("search terms")`** — keyword search across all memories and skills
- **`query("memory-id")`** — recall a specific memory by ID
- **`query("*")`** — list everything stored
- **`save(id, content, ...)`** — persist a new memory as a markdown file

Memories live in `agent_memory/memory/` as markdown with YAML frontmatter. They're personal to each user and gitignored.

## Skills

Skills are reusable agent workflows stored in `.claude/skills/`. Each skill is a directory with a `SKILL.md` file. Agents discover skills automatically through the memory server.

Built-in skills:
- **session-reflect** — end-of-session learning consolidation
- **skill-creator** — guided skill authoring
- **debug-skills** — memory/skill system diagnostics

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HARNESS_PORT` | `3777` | Harness API port |
| `HARNESS_TOKEN` | auto-generated | Bearer token for auth (set to `""` to disable) |

## Cross-Platform

The entire stack runs natively on Linux, macOS, and Windows — no WSL or bash required. The dev launcher (`dev.ts`) uses `Bun.spawn()` and Node APIs (`os.networkInterfaces`, `crypto.randomBytes`) instead of shell commands.

## License

Private — not yet licensed for distribution.
