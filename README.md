<p align="center">
  <img src="assets/mo-logo.png" alt="MO" width="240">
</p>

# Modus

> **Early source preview.** Modus is used by a small tester group, but its
> interfaces and security boundaries are still evolving. The old unsigned
> Windows `v0.1.0` tester asset was withdrawn; the prerelease page/tag remains
> for history but has no downloadable installer. Packaged macOS and Linux
> applications have not been released. See [support scope](SUPPORT.md) and the
> [release policy](RELEASES.md).

Modus is a self-hosted workspace for building systems of agents. Each project defines its own agents, interfaces, workflows, and automation, running locally against whichever provider backends you already use.

Coding agents like Claude Code and Codex are execution engines. Chat apps give you one assistant in one window. Modus is the layer above both: it runs those agents as interchangeable backends and wraps them in durable, per-project structure. The goal is not just to chat with an AI. The goal is to control a system of agents shaped per project and per use case.

## Primitives

Five primitives, composed per project:

- **Profiles** define who an agent is and how it behaves: model, tools, prompt, permissions
- **Moves** define structured user-invoked interactions, often with widgets or typed protocols
- **Actions** define automated workflows triggered by time, webhooks, or other events
- **Missions** define longer-running multi-step, multi-agent project workflows
- **Pages** define custom dashboards and layouts that appear in the top nav per project

Underneath those primitives is a shared harness for sessions, memory, provider abstraction, persistence, authentication, and a streaming UI.

## Architecture

A multi-provider agent harness with concurrent sessions, configurable profiles, persistent memory, structured workflows, and a live streaming UI, all from one `modus start`.

```text
Frontend: React 19 + Vite (:5180)
  chat, pages, panels, sessions, files, git, actions
        |
        | REST + SSE
        v
Harness: Hono + Bun (:3777)
  sessions, profiles, pages, moves, actions, scheduler, SQLite, auth
        |
        | SessionProvider interface
        v
Providers:
  claude-code, claude-code-pty, codex, cursor, grok-build, opencode,
  litellm, ollama, openrouter

Shared extension surfaces:
  MCP servers, moves, actions, pages, client extensions, plugins
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

These commands describe a source-checkout installation. A locally built or future
qualified Windows NSIS package installs both Modus Desktop and its own `modus`
console command; that command runs the same CLI and backend from packaged files,
without a checkout or globally installed Bun. Repository maintenance commands
(`setup`, `dev`, and `update`) remain source-checkout-only.

### 2. Open a project

```bash
cd /path/to/your/project
modus
```

That's it. If the folder isn't a Modus project yet, it scaffolds `.modus/`, starts the server, and opens your browser to the new project setup screen. The project path and name are pre-filled, so just hit create.

If the server is already running, `modus` opens the browser pointed at that folder.

### 3. Other commands

```bash
modus start          # start the server (foreground, ctrl+c to stop)
modus start -d       # start as background daemon
modus start --show-token  # print the harness token (masked in the banner by default)
modus stop           # stop a running daemon
modus status         # show server status, uptime, active sessions
modus init [path]    # scaffold .modus/ without starting the server
modus setup          # re-run dependency install + UI build
modus logs [-f]      # show server logs (-f to follow)
modus remote on|off  # expose modus on your Tailscale tailnet (off by default)
modus update         # git pull + setup + restart
modus dev            # dev mode (harness + vite + file watchers)
modus --version      # print version
```

On first run, Modus asks for your name. Browser PIN lock is optional and can be enabled later in settings. The PIN gates browser sessions; it does not lock Windows, macOS, Linux, or the native desktop window. PIN setup, reset, and removal are local-machine operations. Changing or resetting it revokes existing browser sessions and live streams. A PIN-authenticated browser is an operator-level, full-machine principal: it can use the same broad filesystem and agent authority as the local Modus application. It is not a project-root sandbox.

### 4. Remote access (optional)

The server binds to `127.0.0.1` — local only. To use Modus from other devices (a phone especially), the recommended path is [Tailscale](https://tailscale.com): install it on both machines, then run:

```bash
modus remote on      # every start now serves https://<machine>.<tailnet>.ts.net
modus start --remote # or: expose for a single run
```

This uses `tailscale serve`, so traffic stays inside your private tailnet — nothing is exposed to the public internet. Modus only manages its own serve rule: if another service on the machine is already using `tailscale serve`, Modus leaves that config untouched and tells you. `modus remote off` removes the rule and the setting.

Without a browser PIN, anyone on your tailnet can open the UI. The desktop requires an extra confirmation before enabling an unpinned Tailnet route; set a PIN first if you share your tailnet. Only an authenticated browser can remotely lock browser access, and that lock revokes all browser sessions rather than locking the host operating system.

Treat a PIN as protection for operator-level access, not as a narrower project permission: an authenticated browser can act with the same broad local authority as the installed application. Only connect a remote backend that you trust with that backend's full-machine authority. The native desktop client does not load executable client extensions supplied by a remote backend; local/operator-installed extensions and ordinary browser clients retain the documented trusted-code model.

On Windows, the managed desktop application uses the same persisted remote
setting. After Tailnet access is enabled once, launching Modus Desktop starts
its packaged backend and automatically rebinds the Modus-owned Serve rule to
that backend's dynamic port. Closing to the tray keeps phone/browser access
online; **Quit Modus** removes the route and stops the owned backend. No CLI
daemon or second start command is required for this desktop mode.

Desktop update checks are opt-in. A configured release build may check a signed
HTTPS update channel and show normal, recommended, or critical urgency, but it
never downloads or installs an update without confirmation. Ordinary source and
tester builds have no update endpoint or public key configured. The withdrawn
`v0.1.0` build cannot update itself; a future signed bridge release must first be
installed manually after installer and data-preservation qualification.

### Existing source-checkout users moving to desktop

Current development mode and the managed desktop backend share user-owned data
under `~/.modus/` (`%USERPROFILE%\.modus` on Windows). The desktop intentionally
does not scan arbitrary Git checkouts for old database or profile files.

If this machine ran Modus before data moved out of `harness/`, update the
checkout and start the updated CLI once before installing the desktop build:

```powershell
git pull
.\modus.bat setup
modus stop
modus start -d
modus status
modus stop
```

That first updated `modus start` safely copies `harness.db`, `activity.db`, and
`terminal.db` into `%USERPROFILE%\.modus\data`, verifies SQLite integrity, keeps
the repo copies as backups, records migration provenance, and copies missing
legacy profiles into `%USERPROFILE%\.modus\profiles`. It refuses to merge an
unverified legacy database with an independently existing destination.

To inspect or apply the database step explicitly instead:

```powershell
modus maintenance storage --dry-run
modus maintenance storage --apply --plan-id <planId-from-dry-run>
```

After this one-time bridge, repo development and the desktop use the same user
database and profiles. Do not delete the retained repo databases until the
desktop has been launched and historical sessions have been verified.

## Providers

Each provider is an execution backend that implements the `SessionProvider` interface. Modus is intentionally cross-provider: use whichever backends you have access to, mix local and hosted models, and keep the surrounding environment and workflow model consistent.

| Provider | Backend | What you need |
|----------|---------|---------------|
| `claude-code` | Claude Agent SDK | [Claude Code](https://claude.com/claude-code) CLI installed |
| `claude-code-pty` | Claude Code CLI PTY | [Claude Code](https://claude.com/claude-code) CLI installed |
| `codex` | OpenAI Codex CLI | `codex` CLI plus `CODEX_API_KEY`, `OPENAI_API_KEY`, or Codex OAuth |
| `cursor` | Cursor Agent CLI | `cursor-agent login` (Cursor subscription) |
| `grok-build` | xAI Grok Build CLI | [`grok`](https://docs.x.ai/build/overview) installed; SuperGrok or X Premium+ login, or `XAI_API_KEY` |
| `opencode` | opencode CLI | [opencode](https://opencode.ai) installed |
| `litellm` | LiteLLM proxy | LiteLLM running locally |
| `ollama` | Ollama API | Ollama running locally |
| `openrouter` | OpenRouter API | `OPENROUTER_API_KEY` env var |

The last three (`litellm`, `ollama`, `openrouter`) are PI agent variants, a lightweight agent loop for local models and routing services.

For Grok Build, install the official CLI (`irm https://x.ai/cli/install.ps1 | iex` on Windows, or `curl -fsSL https://x.ai/cli/install.sh | bash` on macOS/Linux/WSL), then run `grok login`. Grok Build access comes with a SuperGrok or X Premium+ subscription rather than a free tier; limits and eligibility are controlled by xAI and may change. Modus also supports `XAI_API_KEY` for API-backed use, which needs no subscription.

Two Google adapters exist and neither is offered in the provider picker. `antigravity` drives the [`agy`](https://antigravity.google/docs/cli-install) CLI through its documented print mode, conversation UUID resume, JSON Hooks, plugins, and MCP interfaces, and works if you name it explicitly in a profile. It is not offered by default because Google's [Antigravity terms](https://antigravity.google/terms) prohibit "using third party software, tools, or services to access the Service", and enforcement has suspended paid accounts across Antigravity, Gemini CLI, and Code Assist together — a risk that lands on your Google account, not on Modus. The older `gemini-cli` adapter is likewise reachable only when a paid API, Vertex AI, or compute-ADC deployment is configured explicitly. Modus never reads, stores, or forwards either CLI's OAuth credentials.

See [harness/docs/providers.md](harness/docs/providers.md) for the full provider system documentation.

## Profiles

**Agent profiles** define how an agent behaves: model, tools, system prompt, permissions, and MCP servers. User-owned profiles live in `~/.modus/profiles/agents/`, and project-local overrides live in `<project>/.modus/profiles/agents/`.

**User profiles** define who is using the system: project scope, visible agents, memory isolation, and UI state. They live in `~/.modus/profiles/users/`.

Profiles compose through a cascade: session override > agent profile > user profile > default. MCP servers merge additively across all layers.

See [harness/docs/profile-system.md](harness/docs/profile-system.md).

## Moves

Moves are structured, user-invoked interactions. They are how Modus turns agent behavior into explicit interfaces instead of relying only on open-ended chat. A move can combine prompt gathering, token-gated submission, widgets, persistence, and typed operations. Examples: handoffs, interactive tools, games, and other domain-specific workflows.

Each move is a directory in `.modus/moves/<name>/` with a `move.json` config and `context.ts` module. Moves are self-contained: a move can ship its own `package.json`, and its dependencies install automatically on first activation, scoped to the move directory rather than the host project. This makes moves portable: copy a move directory into any project's `.modus/moves/` and it works.

This repo's own `.modus/` contains four example moves as reference implementations. Wordle shows the core loop (typed ops, persisted state, hidden state the agent can't see, a widget). Chess adds the widget-first flow, a setup op, agent-vs-user turn-taking, and per-move dependencies. To try one in your project, copy its directory into your project's `.modus/moves/`.

See [harness/docs/moves.md](harness/docs/moves.md).

## Actions

Actions are automated agent workflows: scheduled, webhook-triggered, or chained from other actions. Each one gathers context dynamically, runs an agent session, and can execute side effects based on the response.

Each action is a directory in `.modus/actions/<name>/` with an `action.json` config and `context.ts` module.

See [harness/docs/actions.md](harness/docs/actions.md).

## Pages

Pages are project- or harness-scoped dashboards that appear as entries in the top nav. Each page is a JSON file defining a layout tree of widgets: session views, terminals, file browsers, composers, and any other registered widget. Pages augment the built-in `home` and `chat` views with project-specific workspaces.

Each page lives in `.modus/pages/<name>.json` and is discovered automatically per `cwd`.

See [harness/docs/pages.md](harness/docs/pages.md).

## Missions

Missions are longer-running, multi-step, multi-agent project workflows. They coordinate roles, handoffs, and gates over time when a task is larger than one move or one action.

See [harness/docs/missions.md](harness/docs/missions.md).

## Documentation

Full architecture and subsystem reference lives in [harness/docs/](harness/docs/). Start with [architecture.md](harness/docs/architecture.md), which maps the repo and links out to detailed docs for each subsystem: primitives, profiles, config resolution, providers, actions, moves, pages, panels, harness context, notifications, client extensions, and the PI agent.

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

- [Bun](https://bun.sh), the runtime and package manager
- At least one provider backend (see [Providers](#providers) above)

On macOS, see [harness/docs/macos-setup.md](harness/docs/macos-setup.md) for the complete first-run setup.

## Status

Early and moving fast. Modus runs daily for a small group of testers, but the primitives are still evolving and there are sharp edges. Here be dragons. Issues and feedback are welcome.

## License

[Apache 2.0](LICENSE)
