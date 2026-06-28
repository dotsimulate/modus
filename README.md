<p align="center">
  <img src="assets/mo-logo.png" alt="MO" width="240">
</p>

# Modus

Modus is a modular, project-based environment for building and controlling structured agent systems.

It is self-hosted, multi-provider, and designed to be shaped through built-in agent surfaces. Instead of treating agents as a single chat surface, Modus gives you a live workspace where each project can define how agents behave, what interfaces they use, what workflows they run, and how those workflows persist.

## What It Is

Modus combines a few core ideas:

- **Profiles** define who an agent is and how it behaves
- **Moves** define structured user-invoked interactions, often with widgets or typed protocols
- **Actions** define automated workflows triggered by time, webhooks, or other events
- **Missions** define longer-running multi-step, multi-agent project workflows
- **Pages** define custom dashboards and layouts that appear in the top nav per project

Underneath those primitives is a shared harness for sessions, memory, provider abstraction, persistence, authentication, and a streaming UI.

The goal is not just to "chat with an AI." The goal is to control a system of agents that can be shaped per project and per use case.

## Architecture

A multi-provider agent harness with concurrent sessions, configurable profiles, persistent memory, structured workflows, and a live streaming UI from one `bun run dev`.

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
               │ SessionProvider interface
       ┌───────┼───────┬───────┬───────┐
       ▼       ▼       ▼       ▼       ▼
   Claude   Codex   Gemini  Cursor   PI Agent
    Code     CLI     CLI     CLI    (Anthropic,
    SDK                              OpenAI,
                                     LiteLLM,
               │ MCP (stdio/http)    Ollama,
┌──────────────▼───────────────────┐ OpenRouter)
│   Agent Memory — FastMCP/Python  │
│   query() + save() over markdown │
└──────────────────────────────────┘
```

## Quick Start

### 1. Install

```bash
git clone https://github.com/dotsimulate/modus.git
cd modus
```

**Linux / macOS:**
```bash
./modus.sh setup
```

For a fresh Mac user profile, use the full [macOS setup guide](harness/docs/macos-setup.md). It covers Terminal, Homebrew/GitHub auth, Bun PATH setup, Claude Code, Codex, and common first-run errors.

**Windows (PowerShell):**
```powershell
.\modus.bat setup
```

This installs dependencies, builds the UI, and registers `modus` as a global command.
After setup, `modus` works from any directory.

### 2. Open a project

```bash
cd /path/to/your/project
modus
```

That's it. If the folder isn't a Modus project yet, it scaffolds `.modus/`, starts the server, and opens your browser to the new project setup screen. The project path and name are pre-filled — just hit create.

If the server is already running, `modus` opens the browser pointed at that folder.

### 3. Other commands

```bash
modus start          # start the server (foreground, ctrl+c to stop)
modus start -d       # start as background daemon
modus stop           # stop a running daemon
modus status         # show server status, uptime, active sessions
modus init [path]    # scaffold .modus/ without starting the server
modus setup          # re-run dependency install + UI build
modus logs [-f]      # show server logs (-f to follow)
modus update         # git pull + setup + restart
modus dev            # dev mode (harness + vite + file watchers)
modus --version      # print version
```

On first run, Modus asks for your name. Browser PIN lock is optional and can be enabled later in settings.

## Providers

Each provider is an execution backend that implements the `SessionProvider` interface. Modus is intentionally cross-provider: use whichever backends you have access to, mix local and hosted models, and keep the surrounding environment and workflow model consistent.

| Provider | Backend | What you need |
|----------|---------|---------------|
| `claude-code` | Claude Agent SDK | [Claude Code](https://claude.com/claude-code) CLI installed |
| `codex` | OpenAI Codex SDK | `CODEX_API_KEY` or `OPENAI_API_KEY` env var |
| `gemini-cli` | Google Gemini CLI | [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed |
| `cursor` | Cursor Agent CLI | `cursor-agent login` (Cursor subscription) |
| `litellm` | LiteLLM proxy | LiteLLM running locally |
| `ollama` | Ollama API | Ollama running locally |
| `openrouter` | OpenRouter API | `OPENROUTER_API_KEY` env var |

The last three (`litellm`, `ollama`, `openrouter`) are PI agent variants — a lightweight agent loop for local models and routing services.

See [harness/docs/providers.md](harness/docs/providers.md) for the full provider system documentation.

## Profiles

**Agent profiles** define how an agent behaves: model, tools, system prompt, permissions, and MCP servers. Stored in `harness/profiles/agents/` as JSON.

**User profiles** define who is using the system: project scope, visible agents, memory isolation, and UI state. Stored in `harness/profiles/users/`.

Profiles compose through a cascade: session override > agent profile > user profile > default. MCP servers merge additively across all layers.

See [harness/docs/profile-system.md](harness/docs/profile-system.md) and [harness/profiles/README.md](harness/profiles/README.md).

## Moves

Moves are structured, user-invoked interactions. They are how Modus turns agent behavior into explicit interfaces instead of relying only on open-ended chat. A move can combine prompt gathering, token-gated submission, widgets, persistence, and typed operations. Examples: handoffs, interactive tools, games, and other domain-specific workflows.

Each move is a directory in `.modus/moves/<name>/` with a `move.json` config and `context.ts` module.

See [harness/docs/moves.md](harness/docs/moves.md).

## Actions

Actions are automated agent workflows: scheduled, webhook-triggered, or chained from other actions. Each one gathers context dynamically, runs an agent session, and can execute side effects based on the response.

Each action is a directory in `.modus/actions/<name>/` with an `action.json` config and `context.ts` module.

See [harness/docs/actions.md](harness/docs/actions.md).

## Pages

Pages are project-scoped dashboards that appear as entries in the top nav. Each page is a JSON file defining a layout tree of widgets — session views, terminals, file browsers, composers, and any other registered widget. Pages augment the built-in views (sessions, profiles, actions, git, web, trace) with project-specific workspaces.

Each page lives in `.modus/pages/<name>.json` and is discovered automatically per `cwd`.

See [harness/docs/pages.md](harness/docs/pages.md).

## Missions

Missions are longer-running, multi-step, multi-agent project workflows. They coordinate roles, handoffs, and gates over time when a task is larger than one move or one action.

See [harness/docs/missions.md](harness/docs/missions.md).

## Dev Mode

For developing the harness itself (not for end users):

```bash
modus dev              # harness + vite dev server + file watchers
modus dev --watch      # watchdog with auto-reload on .ts changes
```

Optional crash notifications via [ntfy.sh](https://ntfy.sh):
```bash
MODUS_NOTIFY_TOPIC=your-topic modus dev
```

## Prerequisites

- [Bun](https://bun.sh) — runtime and package manager
- At least one provider backend (see [Providers](#providers) above)

On macOS, see [harness/docs/macos-setup.md](harness/docs/macos-setup.md) for the complete first-run setup.

## License

Private — not yet licensed for distribution.
