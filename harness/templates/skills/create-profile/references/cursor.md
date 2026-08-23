# Cursor Provider Reference

Provider name: `"cursor"`

Cursor runs the `cursor-agent` CLI as a subprocess per turn, resuming via `--resume`
for multi-turn. Read this before writing a cursor profile — several standard profile
fields behave differently or have no effect.

## Authentication & Binary

- **Binary**: `cursor-agent` must be in PATH, or set `CURSOR_AGENT_BIN` env var to the full path.
- **API key**: Set `CURSOR_API_KEY` in your secrets file or environment. If unset, Cursor
  falls back to any existing Cursor IDE authentication.

## Models

Default: `"composer-2-fast"` (if `model` is omitted from the profile).

Cursor-native composer models are the primary use case:
- `"composer-2-fast"` — fast, default
- `"composer-2"` — standard
- `"composer-claude-4-5"`, `"composer-gpt-4o"`, etc. — Cursor model multiplexer names

Any model string is passed through to `--model`; use whatever `cursor-agent --list-models` shows.

## Permission Model

Cursor always runs with `--force` (auto-approve). There is **no per-tool approval** —
the harness cannot intercept Cursor's tool calls to ask the user.

- `permissionPolicy` in the profile has **no effect**.
- For read-only behavior, Cursor supports `--mode plan` (read-only) via the UI's
  `providerControls.cursor.mode` setting, not via the profile JSON.

## Built-in Tools

Cursor's built-in tools (derived from its event stream):
`Read`, `Edit`, `Bash`, `Grep`, `Glob`, `WebSearch`

The `tools` and `disallowedTools` profile fields are **not enforced** — Cursor decides
which tools to use based on its own reasoning.

## MCP Servers

Cursor reads MCP config from `.cursor/mcp.json` in the workspace directory. The harness
writes this file at session start (merging global + profile MCP servers) and **restores
the original file** when the session ends. If no MCP servers are configured, nothing is written.

`mcpServers` in the profile works normally — define them the same way as claude-code.

## Project Settings (`loadProjectSettings`)

Cursor always reads its own project rules. Its headless CLI has no switch that
disables them, so the profile editor shows project instructions as always on.

## Relevant Profile Fields

Fields that actually work with cursor:

| Field | Notes |
|-------|-------|
| `model` | Cursor model name; default `"composer-2-fast"` |
| `prompt` | Loaded as a private, always-applied Cursor plugin rule; never added to the user message |
| `promptMode` | `"append"` only; `"custom"` is disabled and rejected because Cursor cannot replace its built-in system prompt |
| `mcpServers` | Written to `.cursor/mcp.json`; merged with global |
| `effort` | Passed through; cursor may or may not use it |
| `maxTurns` | Not enforced by Cursor; omit |
| `permissionPolicy` | No effect — Cursor is always auto-approve |
| `loadProjectSettings` | Unavailable; Cursor project rules are always on |

## Example Profile

```json
{
  "description": "Cursor coding agent — composer model",
  "prompt": "You are a coding agent. Work incrementally. Explain changes before making them.",
  "promptMode": "append",
  "provider": "cursor",
  "model": "composer-2-fast",
  "mcpServers": {
    "tavily": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "tavily-mcp"],
      "env": { "TAVILY_API_KEY": "$TAVILY_API_KEY" }
    }
  },
  "ui": {
    "label": "cursor",
    "emptyTitle": "cursor-agent",
    "emptySubtitle": "composer-2-fast / auto-approve"
  }
}
```
