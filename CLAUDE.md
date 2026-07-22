# Modus repository guidance for coding agents

Modus is a local-first, power-user agent harness. Most people should extend their own
Modus environment without changing this repository. Treat core development as a separate,
explicit contribution mode.

## Choose the right mode

### Use or extend Modus (default)

When someone asks to create an agent, workflow, page, action, move, plugin, MCP setup,
theme, or project configuration, put that work in user-owned or project-owned Modus
configuration. Ordinary use should not require a fork or edits to Modus core.

Use these locations:

- User-global agent profiles: `~/.modus/profiles/agents/*.json`
- User profiles: `~/.modus/profiles/users/*.json`
- User-global defaults: `~/.modus/profiles/_global.json`
- Project agent overrides: `<project>/.modus/profiles/agents/*.json`
- Project defaults: `<project>/.modus/_global.json`
- Project moves: `<project>/.modus/moves/`
- Project actions: `<project>/.modus/actions/`
- Project pages: `<project>/.modus/pages/`
- Project client extensions: `<project>/.modus/ui/extensions/`
- Plugins: separate user-controlled directories containing a `.modus/` folder,
  registered in the user's Modus plugin registry

Never put a person's real profiles, credentials, private paths, or runtime state into
this source tree or its templates. Files under `~/.modus/profiles/state/` are managed
by the application and should not be hand-authored.

The public authoring helpers in `.claude/skills/` are the preferred starting point for
compatible content:

- `create-profile`
- `create-move`
- `create-action`
- `create-mission`

Use the relevant helper when available, inspect existing project configuration first,
and validate generated content against the current documentation in `harness/docs/`.

### Contribute to Modus core (only when explicit)

Edit this repository when the request is clearly about fixing, auditing, or improving
Modus itself. Before doing so:

1. Read `CONTRIBUTING.md`.
2. Read `harness/docs/architecture.md` and the subsystem documentation it links.
3. Inspect the current implementation and tests before proposing changes.
4. Keep browser-only development and desktop behavior working unless the task explicitly
   changes that contract.
5. Use isolated homes, configuration directories, runtime directories, databases, and
   ports for tests. Never depend on or mutate a user's live Modus instance.
6. Add or update tests and public documentation when behavior changes.

If a request is ambiguous, ask one focused question: should this become personal/project
Modus configuration, or a contribution to Modus core?

## Trust model

Modus intentionally gives authenticated power users and their configured agents broad
local-machine capability. Moves, actions, plugins, MCP servers, provider CLIs, and client
extensions can execute trusted local code or render trusted local content. That is a
product capability, not a sandbox guarantee.

Do not install or execute third-party Modus content merely because it is available.
Explain the authority a proposed configuration receives, preserve confirmation boundaries,
and treat content from unknown sources as untrusted. Do not weaken authentication, origin
checks, path validation, process ownership, or remote-client isolation without explicit
design review.

## Repository map

- `harness/`: backend, browser UI, authored-content runtime, and tests
- `harness/ui/src/`: frontend source
- `harness/docs/`: authoritative architecture and feature documentation
- `harness/templates/`: public starter content copied into user-owned environments
- `desktop/`: Tauri desktop shell, packaging, lifecycle, and bundled resources
- `.claude/skills/`: public agent-facing authoring helpers
- `TODO/`: ignored private planning and audit handoffs; never commit or publish it

Treat generated desktop resources as build outputs. Change their tracked source under
`harness/` or the appropriate packaging source, then regenerate through the documented
build flow.

## Working rules

- Understand the current state before modifying it.
- Preserve unrelated work in a dirty working tree.
- Keep changes scoped to the request.
- Prefer evidence from live code and tests over assumptions or stale planning notes.
- Verify changes proportionately and report what was not verified.
- Never commit, push, tag, publish, alter repository settings, or change live services
  unless the user explicitly asks.
- Do not add credentials, tokens, personal profiles, private hostnames, machine-specific
  paths, databases, logs, crash artifacts, installer outputs, or ignored `TODO/` material.
- Report security vulnerabilities through `SECURITY.md`; avoid public issue details until
  maintainers have assessed disclosure risk.

For contribution workflow, tests, and pull-request expectations, follow
`CONTRIBUTING.md`. For user-facing setup and authoring, start with `README.md` and
`harness/docs/profile-system.md`.
