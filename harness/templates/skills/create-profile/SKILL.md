---
name: create-profile
description: >
  Create and configure Modus profiles for AI agents and users.
  Use when someone wants to: (1) create a new agent profile (model, tools, prompt,
  permissions, MCP servers), (2) set up a user profile (project scope, visible agents,
  memory isolation), (3) configure global defaults or provider tuning, (4) build a
  complete agent stack (user profile + agent profile + global config together), or
  (5) add a specialized agent to an existing Modus installation. Covers all profile types
  in the Modus local-first agent harness. TRIGGER on: "create a profile", "new agent",
  "set up an agent", "add a profile", "configure agent", "user profile", "new user".
---

# Create Profile

Modus profiles are JSON files that configure AI agent behavior across three layers:

- **Agent profiles** — what the agent does
- **User profiles** — who uses the system
- **Global config** — shared defaults for all sessions

## Path Resolution — CRITICAL

- Vault-global agent profiles: `<current-home>/profiles/agents/<name>.json`
- Project-local agent profiles: `<project>/.modus/profiles/agents/<name>.json`
- User profiles: `<current-home>/profiles/users/<name>.json`
- Vault-global config: `<current-home>/profiles/_global.json`
- Project-local config: `<project>/.modus/_global.json`

`<current-home>` is the active Vault's home: Main's Modus home or a named
Vault's registered folder. Choose Vault-global scope for configuration shared
across that Vault's projects. Choose project-local scope for configuration
owned by one project. Never write a person's profile or configuration into the
Modus source checkout, Main from a named Vault, or templates.

## Workflow

1. Determine what the user needs (see decision tree)
2. Decide whether the requested agent/config is Vault-global or project-local
3. Gather requirements through focused questions
4. Read the relevant reference file for schema details
5. Generate valid JSON
6. Output the file path and content

## Decision Tree

**"I want a new agent / assistant / bot"**
  Read [references/agent-profile-schema.md](references/agent-profile-schema.md).
  Create `<current-home>/profiles/agents/<name>.json` for a reusable Vault-global agent,
  or `<project>/.modus/profiles/agents/<name>.json` for a project override.

**"I want to organize my projects / set up my account"**
  Read [references/user-profile-schema.md](references/user-profile-schema.md).
  Create `<current-home>/profiles/users/<name>.json`.

**"I want to set defaults for all agents" / "configure my local LLM"**
  Read [references/global-config.md](references/global-config.md).
  Update `<current-home>/profiles/_global.json` for Vault-global defaults or
  `<project>/.modus/_global.json` for project-local overrides.

**"Set up everything for a new use case"** (full stack)
  Create the user profile and reusable agent profile under `<current-home>/profiles/`,
  plus Vault-global or project-local config if needed.
  Create the agent profile first (it defines the behavior), then the user profile
  (which references the agent profile by name).

## Gathering Requirements

### For agent profiles, ask:

1. **What should it do?** (coding, research, creative, ops, monitoring, etc.)
2. **What provider/model?** Default is `claude-code` with the current Modus default model.
   Omit `model` when the provider default is acceptable. For Cursor or Codex, read the
   matching reference before writing JSON. Do not offer hidden legacy providers by default.
3. **What tools should it have?** Full access, read-only, or specific allowlist?
4. **Should it load project settings?** (CLAUDE.md from the working directory)
5. **Any MCP servers?** (web search, memory, databases, custom tools)

### For user profiles, ask:

1. **What projects will this cover?** (absolute paths to project roots)
2. **Which agent profiles should be visible?** (list of agent profile names)
3. **Should memories be isolated?** (per-profile vs shared global store)

## Key Rules

- Agent profiles define behavior. User profiles define scope. Never mix them.
- `prompt` supports `{{key}}` template vars resolved from user's `templateVars`
  or from `_users.json` shared defaults
- Provider cascade (first non-undefined wins):
  session override > agent profile > user profile > `"claude-code"` default
- `permissionPolicy: "bypass"` skips all tool approval. Use for trusted agents.
  Use the object form for granular control.
- `promptMode: "append"` adds your prompt after the default system prompt.
  `promptMode: "custom"` replaces the system prompt entirely.
- MCP servers from `_global.json` are merged into every session. Agent profile
  MCP servers override global ones by key name.
- Omitting optional fields means the system default applies — don't pad with nulls.

## Quick Examples

### Minimal agent — coding assistant

```json
{
  "description": "General coding assistant",
  "prompt": "You are a helpful coding assistant working with {{name}}.",
  "model": "claude-opus-4-8[1m]",
  "effort": "high",
  "permissionPolicy": "bypass"
}
```

### Restricted agent — read-only researcher

```json
{
  "description": "Read-only research agent",
  "prompt": "Search, read, and analyze. Never modify files. Cite sources.",
  "promptMode": "append",
  "model": "claude-opus-4-8",
  "tools": ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Agent"],
  "disallowedTools": ["Bash", "Write", "Edit"],
  "permissionPolicy": { "default": "approve" }
}
```

### Local model agent — creative writing

```json
{
  "description": "Creative writing with local model",
  "prompt": "You are a creative writer. Focus on voice, rhythm, and surprise.",
  "promptMode": "custom",
  "provider": "openai-compat",
  "model": "deepseek-r1-qwen3-8b",
  "loadProjectSettings": false,
  "tools": ["Read", "Grep", "Glob", "WebSearch", "WebFetch"]
}
```

### Minimal user profile

```json
{
  "displayName": "Alex",
  "projects": ["/home/alex/projects/webapp"],
  "agentProfiles": ["dev-agent", "research"]
}
```

## Available Tools (for allowlists)

Standard: `Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `Grep`, `Glob`,
`WebSearch`, `WebFetch`, `Agent`, `AskUserQuestion`, `NotebookEdit`

MCP tools use the pattern: `mcp__<server-name>__<tool-name>`

## Available Providers

| Provider | Models | Use case | Reference |
|----------|--------|----------|-----------|
| `claude-code` | Current Claude models | Full agent features, sub-agents, permissions | (default, no ref needed) |
| `claude-code-pty` | Current Claude CLI models | Persistent Claude CLI process | (no ref needed) |
| `cursor` | composer-2-fast (default), others | Cursor Agent CLI; auto-approve, no per-tool approval | [references/cursor.md](references/cursor.md) |
| `codex` | Runtime-discovered Codex models | OpenAI Codex CLI; sandbox modes and Starlark rules | [references/codex.md](references/codex.md) |
| `opencode` | Runtime-discovered OpenCode models | OpenCode CLI or `bunx` fallback | See `harness/docs/providers.md` |
| `grok-build` | Runtime-discovered Grok Build models | `grok` CLI; browser login or `XAI_API_KEY` | See `harness/docs/providers.md` |
| `openai-compat` | Any OpenAI-compatible endpoint | Local models, LiteLLM, vLLM, llama.cpp | See `harness/docs/providers.md` |
| `ollama` | Ollama models | Local Ollama server | — |
| `openrouter` | 300+ models (Claude, GPT, Gemini, etc.) | Unified API for multiple providers | — |
| User/plugin definition | Any supported PI API | Additional gateways and endpoints discovered at runtime | See `harness/docs/providers.md` |

The standalone `gemini-cli` and `antigravity` adapters are unavailable in the
distributed app. Migrate old profiles to a listed provider. `litellm` remains
an accepted alias of `openai-compat`; author new profiles with the canonical
name. For `cursor` and `codex`, read the linked reference before writing profile
JSON; their permissions, tools, and MCP behavior differ materially.

## Output Format

Always output:
1. The file path where the JSON should be saved
2. The complete JSON content
3. Any follow-up steps (e.g., "add this agent name to your user profile's agentProfiles list")

If the user is creating a full stack, output each file separately with clear labels.
