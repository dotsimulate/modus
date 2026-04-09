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

One command starts the API server (`:3777`) and frontend (`:5180`). On first run, Modus prompts for a PIN.

**To add Modus to an existing project:**

```bash
cd /your/project
modus init            # scaffolds .modus/ with memory MCP and starter profile
```

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

## Missions

Missions are longer-running, multi-step, multi-agent project workflows. They coordinate roles, handoffs, and gates over time when a task is larger than one move or one action.

See [harness/docs/missions.md](harness/docs/missions.md).

## Watchdog

```bash
./modus.sh              # auto-restart, health polling, crash log
./modus.sh watch:dev    # + auto-reload on .ts changes (development)

# Optional crash notifications via ntfy.sh
MODUS_NOTIFY_TOPIC=your-topic ./modus.sh
```

## Prerequisites

- [Bun](https://bun.sh) — runtime and package manager
- [uv](https://docs.astral.sh/uv/) — Python package manager (for the memory server)
- At least one provider backend (see [Providers](#providers) above)

## License

Private — not yet licensed for distribution.
