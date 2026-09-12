# Codex Provider Reference

Provider name: `"codex"`

Uses the local `codex` CLI through Modus's event-stream wrapper. Read this before writing
a Codex profile — the permission model is fundamentally different from claude-code.

## Authentication

Two options:

1. **API key** — set `CODEX_API_KEY` or `OPENAI_API_KEY` in secrets or environment.
2. **OAuth** — run `codex login` once; credentials stored at `~/.codex/auth.json`.

## Models

Models are discovered from the installed Codex environment and cached by Modus. Omit
`model` to use the current Modus fallback, or select a model returned by the running CLI.
Do not hard-code an example model merely because it appeared in an older document.

## Permission Model — Critical Difference

**Modus does not surface Codex interactive approvals.** Its app-server transport
declines approval requests while preserving the existing permission mapping:

- `permissionPolicy: "bypass"` → `sandboxMode: "danger-full-access"` (full access)
- `permissionPolicy: "ask"` → **falls back to `workspace-write`** with a warning logged.
  The user never sees an approval prompt. Use `codexRules` instead.
- `permissionPolicy: { requireApproval: [...] }` → the `requireApproval` list is ignored
  with a warning. Use `codexRules` for command-level restrictions.

## Sandbox Modes

The `codexSandboxMode` profile field sets the physical execution sandbox:

| Mode | Behavior |
|------|----------|
| `"danger-full-access"` | Full shell and filesystem (default for `permissionPolicy: "bypass"`) |
| `"workspace-write"` | Filesystem writes allowed; arbitrary shell restricted |
| `"read-only"` | No writes, no exec |

`codexSandboxMode` overrides whatever mode is derived from `permissionPolicy`.
Use it to explicitly set the sandbox regardless of permission policy.

The tool toggles (`Bash`, `Edit` on/off) also influence sandbox mode when
`codexSandboxMode` is not set:
- Both off → `"read-only"`
- One off → `"workspace-write"`

## codexRules — Command-Level Restrictions

Use `codexRules` (instead of `permissionPolicy: "ask"`) to restrict specific commands.
Written to `~/.codex/rules/harness-<sessionId>.rules` at session start, cleaned up on end.

Syntax: Starlark `prefix_rule()` calls, one per string in the array.

```json
"codexRules": [
  "prefix_rule(pattern=[\"rm\", \"-rf\"], decision=\"forbidden\")",
  "prefix_rule(pattern=[\"git\", \"push\"], decision=\"ask\")",
  "prefix_rule(pattern=[\"curl\"], decision=\"ask\")"
]
```

Decisions: `"allowed"`, `"ask"`, `"forbidden"`.

Note: `decision="ask"` in rules requires interactive approval, which this harness
path declines. Use `"forbidden"` to
block commands outright.

## Web Search

Control via the session-level `providerControls` (not the profile JSON directly):

```json
"providerControls": {
  "codex": {
    "webSearchMode": "live"
  }
}
```

Valid values: `"live"`, `"cached"`, `"disabled"`.

If not set, the harness derives it from the `WebSearch` tool state:
- `WebSearch` on → `"live"`
- `WebSearch` off → `"disabled"`

## Effort

Maps to Codex `ModelReasoningEffort`:
- `"low"` / `"medium"` / `"high"` → passed through
- `"off"` → no reasoning effort set
- `"max"` → `"xhigh"`

## MCP Servers

Codex MCP uses HTTP transport via a config object. Stdio servers are supported;
SSE servers are **not** (Codex expects streamable HTTP, not SSE — will warn and skip).

Define `mcpServers` in the profile the same way as claude-code. HTTP/stdio servers work.

## Relevant Profile Fields

| Field | Notes |
|-------|-------|
| `model` | OpenAI model ID |
| `prompt` | Delivered separately from the user message through Codex config |
| `promptMode` | `"append"` uses `developer_instructions`; `"custom"` uses replacement `instructions` |
| `codexSandboxMode` | Explicit sandbox override; see table above |
| `codexRules` | Starlark command rules written at session start |
| `permissionPolicy` | Drives sandbox derivation; `"ask"` falls back to `workspace-write` |
| `effort` | `"low"/"medium"/"high"` only; `"off"/"max"` = no-op |
| `mcpServers` | stdio + HTTP supported; SSE skipped |
| `loadProjectSettings` | Controls `AGENTS.md` discovery; `false` sets `project_doc_max_bytes` to `0` |

## Example Profile

```json
{
  "description": "Codex coding agent — full access with command guards",
  "prompt": "You are a coding agent. Prefer small, targeted edits. Explain before executing destructive commands.",
  "promptMode": "append",
  "provider": "codex",
  "effort": "medium",
  "codexSandboxMode": "danger-full-access",
  "codexRules": [
    "prefix_rule(pattern=[\"rm\", \"-rf\"], decision=\"forbidden\")",
    "prefix_rule(pattern=[\"git\", \"push\"], decision=\"forbidden\")"
  ],
  "ui": {
    "label": "codex",
    "emptyTitle": "codex-agent",
    "emptySubtitle": "codex / full-access"
  }
}
```

### Read-only research variant

```json
{
  "description": "Codex read-only research agent",
  "prompt": "Search, read, and analyze. Do not modify files.",
  "provider": "codex",
  "effort": "high",
  "codexSandboxMode": "read-only",
  "ui": {
    "label": "codex-ro",
    "emptySubtitle": "codex / read-only"
  }
}
```
