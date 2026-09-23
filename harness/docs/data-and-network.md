# Data, network access, and removal

Modus keeps its own sessions, profiles, and settings on your machine. It has no hosted Modus collection service. Features you choose can contact other services; decide which providers, MCP servers, integrations, and remote-access routes to enable before using them with sensitive projects.

## When Modus connects out

| Feature | What can leave the machine | When |
|---|---|---|
| Hosted AI provider or remote model endpoint | The prompt and context sent to that provider, plus tool results sent in later turns | When you run an agent configured to use it |
| MCP server or plugin | Data and arguments sent through the tools you enable | When a session invokes those tools |
| Provider Status widget | A readiness request to each configured provider endpoint; a provider definition may include its named API key or configured headers | While the widget is open; it refreshes periodically |
| Webhook notification | The notification payload to the URL you configured | When its action fires |
| Hosted speech provider, such as ElevenLabs | Text submitted for speech and the provider credential | When speech generation is enabled and requested |
| Tailscale Serve | Browser traffic over your private tailnet to this machine | Only after you enable remote access; other tailnet members can reach an unpinned browser UI |
| Desktop update check | A request to the configured release endpoint | Only in a build with updates configured and checks enabled; ordinary source and tester builds have no update endpoint |

Provider behavior and destinations depend on your configuration. A local model endpoint avoids sending model prompts to a hosted model, but tools and integrations attached to that session can still make network requests. A browser authenticated to Modus has broad machine authority; read [capability surface](capability-surface.md) before granting access to someone else. See [providers](providers.md) for credential and health-check details and [text to speech](text-to-speech.md) for speech setup.

## Where data lives

| Location | Contents |
|---|---|
| Main `~/.modus/` (`%USERPROFILE%\.modus\` on Windows) | User-owned databases, profiles, logs, cache, and runtime files |
| Main `~/.config/agent-dev-zone/secrets.env` | Default secrets file, separate from Main's data home |
| A named Vault's chosen root | Its own data, profiles, and `secrets.env`; it may be outside Main's home |
| Each project's `.modus/` | Project-local profiles, missions, moves, pages, and other authored content |
| A source checkout, if migrated from an older version | Retained legacy databases and profiles may remain as backups until you inspect them |

`HARNESS_SECRETS_FILE` can override the secrets path. Back up the relevant data and secrets **after stopping Modus** so SQLite files and their journals are captured together. Keep backups private. Normal app removal is intended to preserve user data; it is not a data-erasure action.

## Stop, uninstall, or delete deliberately

1. In Desktop, use **Quit Modus** from the tray. For a source daemon, run `modus stop`. Confirm no Modus process is still using the data you intend to copy or remove.
2. Back up and inspect Main, each named Vault you created, and any project `.modus/` directory you care about. Record custom secrets paths and retained legacy checkout data.
3. Use the operating system's normal uninstall flow for a packaged app, or remove the source checkout and its global command if you installed from source. Normal uninstall preserves user-owned data.
4. Only if you want permanent data removal, delete the specific Main home, named Vault roots, project `.modus/` directories, secrets files, and backups **that you have identified as yours**. These locations are independent; deleting the application or Main does not remove all of them. Do not delete a shared parent directory or another project's data.

Installer-specific preservation and removal behavior must be checked against the exact package you install. This page describes the intended current layout and deliberate removal steps, not a claim that an unqualified installer has passed those checks.
