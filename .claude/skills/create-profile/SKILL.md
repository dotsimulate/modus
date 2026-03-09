---
name: create-profile
description: >
  Create and configure MO (modus operandi) profiles for AI agents and users.
  Use when someone wants to: (1) create a new agent profile (model, tools, prompt,
  permissions, MCP servers), (2) set up a user profile (project scope, visible agents,
  memory isolation), (3) configure global defaults or provider tuning, (4) build a
  complete agent stack (user profile + agent profile + global config together), or
  (5) add a specialized agent to an existing MO installation. Covers all profile types
  in the MO personal AI infrastructure. TRIGGER on: "create a profile", "new agent",
  "set up an agent", "add a profile", "configure agent", "user profile", "new user".
---

# Create Profile

MO profiles are JSON files that configure AI agent behavior across three layers:

- **Agent profiles** (`harness/profiles/agents/<name>.json`) — what the agent does
- **User profiles** (`harness/profiles/users/<name>.json`) — who uses the system
- **Global config** (`harness/profiles/_global.json`) — shared defaults for all sessions

## Workflow

1. Determine what the user needs (see decision tree)
2. Gather requirements through focused questions
3. Read the relevant reference file for schema details
4. Generate valid JSON
5. Output the file path and content

## Decision Tree

**"I want a new agent / assistant / bot"**
  Read [references/agent-profile-schema.md](references/agent-profile-schema.md).
  Create `harness/profiles/agents/<name>.json`.

**"I want to organize my projects / set up my account"**
  Read [references/user-profile-schema.md](references/user-profile-schema.md).
  Create `harness/profiles/users/<name>.json`.

**"I want to set defaults for all agents" / "configure my local LLM"**
  Read [references/global-config.md](references/global-config.md).
  Update `harness/profiles/_global.json`.

**"Set up everything for a new use case"** (full stack)
  Create all three: user profile + agent profile + update global config if needed.
  Create the agent profile first (it defines the behavior), then the user profile
  (which references the agent profile by name).

## Gathering Requirements

### For agent profiles, ask:

1. **What should it do?** (coding, research, creative, ops, monitoring, etc.)
2. **What provider/model?** Default is `claude-code` with Claude Opus. Alternatives:
   `anthropic`, `openai`, `litellm` (local models), `ollama`
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
  "model": "claude-sonnet-4-6",
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
  "model": "claude-sonnet-4-6",
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
  "provider": "litellm",
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

| Provider | Models | Use case |
|----------|--------|----------|
| `claude-code` | Claude Opus/Sonnet/Haiku (Anthropic) | Full agent features, sub-agents, permissions |
| `anthropic` | Same models via PI framework | Simpler, auto-compaction |
| `openai` | GPT-4o, GPT models | OpenAI API |
| `litellm` | Any OpenAI-compatible endpoint | Local models, vLLM, llama.cpp |
| `ollama` | Ollama models | Local Ollama server |
| `openrouter` | 300+ models (Claude, GPT, Gemini, etc.) | Unified API for multiple providers |

## Output Format

Always output:
1. The file path where the JSON should be saved
2. The complete JSON content
3. Any follow-up steps (e.g., "add this agent name to your user profile's agentProfiles list")

If the user is creating a full stack, output each file separately with clear labels.
