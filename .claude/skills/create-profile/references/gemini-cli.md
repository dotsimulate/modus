# Gemini CLI Provider Reference

Provider name: `"gemini-cli"`

This is hidden legacy migration code backed by `@google/gemini-cli-core`. Do not offer
it as a normal new-profile provider. `antigravity` is hidden too, on Google's
third-party-access terms — do not steer anyone to either one by default. Both work when
a profile names them deliberately; see `harness/docs/providers.md` § Hidden providers.

## Authentication

The adapter is accepted only when the operator explicitly configures a paid Gemini API
key, Vertex AI, Cloud Shell, or compute ADC deployment. It intentionally does not consume
Gemini CLI OAuth credentials from `~/.gemini/oauth_creds.json`.

## Models

Omit `model` to use Modus's current legacy-adapter fallback, or use a model supported by
the explicitly configured paid/Vertex deployment.

## Built-in Tools

Gemini's built-in tool names differ from Claude's. The harness exposes these groups:

| Group | Tools |
|-------|-------|
| `files` | `list_directory`, `write_file` |
| `search` | `grep_search` |
| `web` | `google_web_search` |

When using `tools` / `disallowedTools` in the profile, use these Gemini-native names,
not Claude tool names like `Read` or `Bash`.

## Permission Model

`permissionPolicy` maps to Gemini's `ApprovalMode`:

| permissionPolicy | Gemini ApprovalMode | Behavior |
|-----------------|---------------------|----------|
| `"bypass"` (default) | `YOLO` | All tools auto-approved |
| `"ask"` | `DEFAULT` | Gemini decides what to approve |
| `{ default: "approve" }` | `AUTO_EDIT` | Auto-approve edits, ask for shell |

The harness cannot intercept Gemini's per-tool approval requests — approval decisions
are made by the Gemini runtime, not surfaced to the UI.

## MCP Servers

Gemini writes MCP config to its settings.json. MCP is fully supported:
stdio, SSE, and HTTP transports all work. Define `mcpServers` in the profile
exactly as you would for claude-code.

## `tools` / `disallowedTools`

These map to Gemini's `allowedTools` / `excludeTools` lists. Use Gemini tool names.
The `toolStates` session override also works (using Gemini tool names).

## `loadProjectSettings`

Has no effect — Gemini does not read CLAUDE.md. Omit it.

## Effort

Maps through to the Gemini SDK call. Gemini's thinking budget is controlled separately
from Claude's extended thinking. `"high"` and `"max"` enable extended thinking where
supported; `"low"` disables it.

## Relevant Profile Fields

| Field | Notes |
|-------|-------|
| `model` | Gemini model ID; default `"gemini-2.5-pro"` |
| `prompt` | Injected into the user message (custom or append mode) |
| `promptMode` | Works; `"custom"` wraps in `<SYSTEM_INSTRUCTIONS>` tags |
| `tools` | Gemini tool names (`list_directory`, `grep_search`, etc.) |
| `disallowedTools` | Gemini tool names to exclude |
| `permissionPolicy` | Maps to Gemini ApprovalMode (see table above) |
| `mcpServers` | Full MCP support via Gemini settings.json |
| `effort` | Controls Gemini thinking budget |
| `loadProjectSettings` | No effect — omit |

## Example Profile

```json
{
  "description": "Gemini research agent with web search",
  "prompt": "You are a research assistant. Cite sources. Prefer google_web_search for current info.",
  "promptMode": "append",
  "provider": "gemini-cli",
  "effort": "high",
  "permissionPolicy": "bypass",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
      "env": {}
    }
  },
  "ui": {
    "label": "gemini",
    "emptyTitle": "gemini-agent",
    "emptySubtitle": "legacy Gemini / research"
  }
}
```
