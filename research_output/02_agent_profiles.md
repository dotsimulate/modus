# Agent Profile / Tool Config Patterns -- Research Report
*Generated: 2026-03-02*

## Summary

Claude Code provides a deeply configurable system for controlling agent behavior, tool access, and session-level configuration. The configuration hierarchy spans managed (enterprise) settings, user-level settings, project-level settings, and local overrides -- with array-valued settings merging across scopes and deny rules always taking precedence. Combined with CLI flags like `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--agent`, `--agents`, `--tools`, and `--mcp-config`, it is entirely feasible to build swappable "agent profiles" that constrain Claude Code to specific tool sets, system prompts, and MCP integrations per session.

The most powerful mechanism for agent profiles is the subagent system (`.claude/agents/` markdown files with YAML frontmatter), which can be used both as delegated subagents AND as main-thread agents via the `--agent` flag. These agent definitions support tool allowlists/denylists, model selection, permission modes, MCP server attachment, hooks, skill preloading, and persistent memory scopes. For programmatic control, the Claude Agent SDK (Python/TypeScript) exposes the same configuration surface through `allowed_tools`, `disallowed_tools`, `permission_mode`, `mcp_servers`, `agents`, and `hooks` parameters.

The practical approach to swappable profiles involves: (1) defining agent markdown files in `.claude/agents/` or `~/.claude/agents/`, (2) launching sessions with `claude --agent <profile-name>` or passing `--agents` JSON inline, and (3) optionally wrapping these in shell aliases or scripts that bundle environment variables, MCP configs, and permission settings. For SDK-based automation, profiles can be encoded as configuration objects passed to the `query()` function.

---

## Findings

### 1. Claude Code Settings System

**Confidence: HIGH** -- sourced directly from official Anthropic documentation.

#### Settings File Locations and Hierarchy

| Scope | Location | Shared | Purpose |
|-------|----------|--------|---------|
| Managed | Server, plist, registry, or `/etc/claude-code/managed-settings.json` | Yes (IT-deployed) | Organization-wide policies |
| User | `~/.claude/settings.json` | No | Personal preferences across all projects |
| Project | `.claude/settings.json` | Yes (in git) | Team-shared project settings |
| Local | `.claude/settings.local.json` | No (auto-gitignored) | Personal project overrides |

**Configuration Precedence** (highest to lowest):
1. Managed settings (cannot be overridden)
2. Command-line arguments
3. Local project settings (`.claude/settings.local.json`)
4. Shared project settings (`.claude/settings.json`)
5. User settings (`~/.claude/settings.json`)

**Critical detail**: Array-valued settings (e.g., `permissions.allow`, `permissions.deny`) **merge across scopes** rather than replace. Deny rules always win over allow rules regardless of scope.

#### settings.json Format

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": ["Bash(npm run *)"],
    "deny": ["Bash(curl *)", "Read(./.env)"],
    "ask": ["Bash(git push *)"],
    "defaultMode": "acceptEdits",
    "additionalDirectories": ["../docs/"]
  },
  "env": {
    "FOO": "bar"
  },
  "model": "claude-sonnet-4-6",
  "hooks": { },
  "sandbox": { }
}
```

The `$schema` line enables autocomplete and validation in editors.

#### settings.local.json

Same format as `settings.json`. Automatically gitignored when created. Overrides project and user settings. Useful for personal experiments and machine-specific configuration.

#### CLAUDE.md File Locations and Loading Order

| Scope | Location | Loaded | Shared |
|-------|----------|--------|--------|
| User | `~/.claude/CLAUDE.md` | Always | No |
| Project | `CLAUDE.md` (root) or `.claude/CLAUDE.md` | Always | Yes |
| Local | `.claude/CLAUDE.local.md` | Always | No (gitignored) |
| Additional dirs | `CLAUDE.md` in `--add-dir` folders | If `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` | Depends |

Loading order: User memory -> Project memory -> Local memory -> Additional directory memory. All combined and loaded at session startup.

#### .claude/ Directory Structure

```
.claude/
  settings.json              # Project-shared settings (in git)
  settings.local.json        # Local overrides (gitignored)
  CLAUDE.md                  # Project-shared memory (in git)
  CLAUDE.local.md            # Local memory (gitignored)
  agents/                    # Subagent definitions
    my-agent.md
  skills/                    # Skill definitions
  commands/                  # Custom slash commands

~/.claude/
  settings.json              # User-wide settings
  CLAUDE.md                  # User memory
  agents/                    # User subagents
  .mcp.json                  # User MCP servers (also stored in ~/.claude.json)
```

Project root also uses `.mcp.json` for project-scoped MCP servers (checked into git).

---

### 2. Tool Control Mechanisms

**Confidence: HIGH** -- sourced from official docs and verified with community reports.

#### CLI Flags for Tool Control

| Flag | Effect | Example |
|------|--------|---------|
| `--allowedTools` | Tools auto-approved without prompting | `claude --allowedTools "Bash(git log *)" "Read"` |
| `--disallowedTools` | Tools removed from model's context entirely | `claude --disallowedTools "Edit" "WebFetch"` |
| `--tools` | Restrict which built-in tools are available | `claude --tools "Bash,Read,Glob"` |
| `--permission-mode` | Set permission mode for session | `claude --permission-mode plan` |
| `--dangerously-skip-permissions` | Bypass all permission checks | `claude --dangerously-skip-permissions` |

**Important distinction**: `--allowedTools` means "allow these without prompting" (others still available, just require approval). `--tools` means "restrict to ONLY these tools" (others are not available at all). `--disallowedTools` means "remove these from context entirely."

#### SDK Equivalents

**Python:**
```python
from claude_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="Review this code",
    options=ClaudeAgentOptions(
        allowed_tools=["Read", "Glob", "Grep"],
        permission_mode="bypassPermissions"
    ),
):
    print(message)
```

**TypeScript:**
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Review this code",
  options: {
    allowedTools: ["Read", "Glob", "Grep"],
    permissionMode: "bypassPermissions"
  }
})) {
  console.log(message);
}
```

**Known issue (as of early 2026)**: There are reported bugs where `allowed_tools` does not properly restrict built-in tools in the SDK -- `disallowed_tools` works more reliably for blocking. Monitor the SDK repos for fixes.

#### Tool Name Formats

| Category | Format | Examples |
|----------|--------|---------|
| Built-in tools | `ToolName` | `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `NotebookEditCell` |
| Bash with specifier | `Bash(command pattern)` | `Bash(npm run *)`, `Bash(git commit *)` |
| Read/Edit with path | `Tool(path pattern)` | `Read(./.env)`, `Edit(/src/**)`, `Read(~/Documents/*.pdf)` |
| WebFetch with domain | `WebFetch(domain:host)` | `WebFetch(domain:example.com)` |
| MCP tools | `mcp__servername__toolname` | `mcp__github__list_issues`, `mcp__puppeteer__puppeteer_navigate` |
| MCP wildcard | `mcp__servername__*` | `mcp__puppeteer__*` (all tools from server) |
| MCP all (no wildcard) | `mcp__servername` | `mcp__puppeteer` (also matches all tools from server) |
| Agent/Subagent | `Agent(agent-name)` | `Agent(Explore)`, `Agent(my-custom-agent)` |

#### Wildcard and Pattern Support

- Bash rules support glob patterns with `*` at any position: `Bash(npm run *)`, `Bash(* --version)`, `Bash(git * main)`
- The space before `*` matters: `Bash(ls *)` matches `ls -la` but not `lsof`; `Bash(ls*)` matches both
- Read and Edit rules follow gitignore specification: `*` matches files in one directory, `**` matches recursively
- Path prefixes: `//` = absolute, `~/` = home, `/` = project root, `./` or none = current directory
- MCP tools support `*` wildcard: `mcp__servername__*`

#### Permission Evaluation Order

1. **Deny rules** checked first (always block)
2. **Ask rules** checked second (prompt for approval)
3. **Allow rules** checked third (auto-approve if matched)
4. First match wins

#### Permission Modes

| Mode | Description |
|------|-------------|
| `default` | Standard -- prompts for unapproved tools |
| `acceptEdits` | Auto-accept file edits; other tools still prompt |
| `plan` | Read-only exploration, no modifications |
| `dontAsk` | Auto-deny unless pre-approved in allow rules |
| `bypassPermissions` | Skip all checks (dangerous -- use in containers only) |

---

### 3. Agent Profile Patterns

**Confidence: HIGH for mechanisms, MEDIUM for community patterns** -- mechanisms are well-documented; community adoption patterns are emerging.

#### Primary Mechanism: Subagent Markdown Files

The most powerful way to define agent profiles is through subagent markdown files. These support all the configuration needed for a profile:

```markdown
---
name: research-agent
description: Research agent with web search and read-only access
tools: Read, Glob, Grep, WebSearch, WebFetch
disallowedTools: Write, Edit, Bash
model: sonnet
permissionMode: plan
---

You are a research assistant. Your job is to search the web and read
code to answer questions. You cannot modify files or run commands.
Focus on thorough analysis and clear summaries.
```

**File locations by scope:**
- Session-only: `--agents` CLI flag (JSON, not saved)
- Project: `.claude/agents/` (checked into git)
- User: `~/.claude/agents/` (personal, cross-project)
- Plugin: Plugin's `agents/` directory

#### Profile Switching Approaches

**Approach 1: `--agent` flag (main-thread agent)**

```bash
# Run entire session as a specialized agent
claude --agent research-agent
claude --agent coding-agent
claude --agent review-agent
```

The `--agent` flag applies the specified agent's system prompt, tool restrictions, and model to the main thread. Introduced in v2.0.59.

**Approach 2: `--agents` JSON (session-only inline definition)**

```bash
claude --agents '{
  "researcher": {
    "description": "Research-only agent",
    "prompt": "You are a research assistant. Read and search only.",
    "tools": ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
    "model": "sonnet"
  }
}'
```

**Approach 3: Shell aliases / wrapper scripts**

```bash
# ~/.bashrc or ~/.zshrc
alias claude-research='claude --agent research-agent --permission-mode plan'
alias claude-code='claude --permission-mode acceptEdits'
alias claude-review='claude --agent review-agent --permission-mode plan'
alias claude-ops='claude --agent ops-agent --mcp-config ~/.claude/mcp-ops.json'
```

**Approach 4: Wrapper script with full control**

```bash
#!/bin/bash
# ~/bin/claude-research
exec claude \
  --agent research-agent \
  --permission-mode plan \
  --tools "Read,Glob,Grep,WebSearch,WebFetch" \
  --disallowedTools "Bash,Edit,Write" \
  --append-system-prompt "Focus on thorough research. Never attempt to modify files." \
  "$@"
```

**Approach 5: SDK programmatic profiles**

```python
PROFILES = {
    "research": ClaudeAgentOptions(
        allowed_tools=["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
        permission_mode="plan",
        system_prompt="You are a research assistant..."
    ),
    "coding": ClaudeAgentOptions(
        allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        permission_mode="acceptEdits"
    ),
    "review": ClaudeAgentOptions(
        allowed_tools=["Read", "Glob", "Grep"],
        permission_mode="bypassPermissions"
    ),
}

profile = PROFILES[sys.argv[1]]
async for msg in query(prompt=task, options=profile):
    ...
```

#### Example Profile Definitions

**Research Agent** (`.claude/agents/research-agent.md`):
```markdown
---
name: research-agent
description: Web research and codebase analysis without modifications
tools: Read, Glob, Grep, WebSearch, WebFetch
model: sonnet
permissionMode: plan
---

You are a thorough research assistant. Search the web, read documentation,
and analyze code. Provide comprehensive summaries with sources.
Never attempt to modify files or run commands.
```

**Coding Agent** (`.claude/agents/coding-agent.md`):
```markdown
---
name: coding-agent
description: Full-featured coding agent for implementation tasks
model: opus
permissionMode: acceptEdits
---

You are an expert software engineer. Write clean, well-tested code.
Follow existing conventions in the codebase.
```

**Review Agent** (`.claude/agents/review-agent.md`):
```markdown
---
name: review-agent
description: Code review specialist -- read-only analysis
tools: Read, Glob, Grep, Bash
disallowedTools: Write, Edit
model: sonnet
---

You are a senior code reviewer. Analyze code for quality, security,
and best practices. Never modify files directly.

Review checklist:
- Code clarity and readability
- Error handling
- Security vulnerabilities
- Test coverage
- Performance considerations
```

**Ops Agent** (`.claude/agents/ops-agent.md`):
```markdown
---
name: ops-agent
description: Operations agent for infrastructure tasks
tools: Bash, Read, Glob, Grep
mcpServers:
  - kubernetes-mcp
  - docker-mcp
model: sonnet
---

You are an infrastructure operations specialist. Execute ops commands,
check system status, and manage deployments. Be cautious with
destructive operations -- always confirm before deleting resources.
```

#### Existing Community Patterns

The Trail of Bits `claude-code-config` project demonstrates a production-grade configuration approach:
- Runs in `bypassPermissions` mode secured by OS-level sandboxing (Seatbelt/bubblewrap)
- Uses PreToolUse hooks as guardrails (blocking `rm -rf`, blocking pushes to main)
- Defines credential access deny rules for SSH, GPG, cloud providers, package tokens
- Uses custom statusline scripts for context usage monitoring
- Separates global CLAUDE.md instructions from project-level overrides

---

### 4. MCP Server Configuration

**Confidence: HIGH** -- sourced directly from official Anthropic documentation.

#### Configuration Locations

| Scope | Location | Managed By |
|-------|----------|------------|
| Local (per-project, private) | `~/.claude.json` under project path | `claude mcp add` (default) |
| Project (shared, in git) | `.mcp.json` in project root | `claude mcp add --scope project` |
| User (cross-project, private) | `~/.claude.json` | `claude mcp add --scope user` |
| Managed (enterprise) | `/etc/claude-code/managed-mcp.json` | IT admin deployment |

#### MCP Server Config Format

```json
{
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": {
        "API_KEY": "${API_KEY}"
      }
    },
    "remote-server": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${TOKEN}"
      }
    }
  }
}
```

Environment variable expansion is supported: `${VAR}` and `${VAR:-default}`.

#### Per-Session MCP Configuration via CLI

**The `--mcp-config` flag** loads MCP servers from JSON files or strings:

```bash
# Load from file
claude --mcp-config ./mcp-research.json

# Load from multiple files
claude --mcp-config ./mcp-base.json ./mcp-extras.json
```

**The `--strict-mcp-config` flag** ensures ONLY servers from `--mcp-config` are used, ignoring all other MCP configurations:

```bash
claude --strict-mcp-config --mcp-config ./mcp-isolated.json
```

This is critical for isolated agent profiles -- it prevents servers from user/project configs from leaking into a restricted profile.

#### Subagent-Level MCP Servers

Agent markdown files can specify which MCP servers are available:

```markdown
---
name: data-agent
description: Data analysis agent
tools: Bash, Read
mcpServers:
  - postgres-mcp
  - bigquery-mcp
---
```

Each entry can be a server name referencing an already-configured server, or an inline definition.

#### CLI Management Commands

```bash
claude mcp add --transport http name https://url    # Add HTTP server
claude mcp add --transport stdio name -- cmd args   # Add stdio server
claude mcp add --scope project name -- cmd args     # Add to project scope
claude mcp add-json name '{"type":"http","url":"..."}' # Add from JSON
claude mcp list                                      # List servers
claude mcp get name                                  # Get server details
claude mcp remove name                               # Remove server
```

#### Conditional MCP Inclusion Patterns

For profile-based MCP switching, combine `--strict-mcp-config` with profile-specific JSON files:

```bash
# Profile-specific MCP configs
cat > ~/.claude/mcp-research.json << 'EOF'
{
  "mcpServers": {
    "exa": {"type": "stdio", "command": "npx", "args": ["-y", "@anthropic/mcp-exa"]},
    "context7": {"type": "http", "url": "https://mcp.context7.com/mcp"}
  }
}
EOF

cat > ~/.claude/mcp-ops.json << 'EOF'
{
  "mcpServers": {
    "kubernetes": {"type": "stdio", "command": "npx", "args": ["-y", "k8s-mcp"]},
    "docker": {"type": "stdio", "command": "docker", "args": ["mcp", "serve"]}
  }
}
EOF

# Use profile with isolated MCP
alias claude-research='claude --agent research-agent --strict-mcp-config --mcp-config ~/.claude/mcp-research.json'
alias claude-ops='claude --agent ops-agent --strict-mcp-config --mcp-config ~/.claude/mcp-ops.json'
```

---

### 5. Programmatic Per-Session Configuration

**Confidence: HIGH** -- sourced from official docs and SDK documentation.

#### CLI-Based Per-Session Control

Every aspect of a session can be controlled at launch time:

```bash
claude \
  --agent research-agent \                    # Agent profile
  --model sonnet \                            # Model selection
  --permission-mode plan \                    # Permission mode
  --tools "Read,Glob,Grep,WebSearch" \        # Restrict available tools
  --allowedTools "Read" "Glob" \              # Auto-approve these
  --disallowedTools "Bash" "Edit" \           # Block these entirely
  --mcp-config ./mcp-research.json \          # MCP servers
  --strict-mcp-config \                       # Only use specified MCP
  --append-system-prompt "Research only" \    # Additional instructions
  --add-dir ../docs \                         # Additional directories
  -p "Research the authentication module"     # Prompt (headless mode)
```

#### Environment Variables That Affect Behavior

Key environment variables for per-session isolation:

| Variable | Purpose | Example |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | API authentication | Different keys per profile |
| `ANTHROPIC_MODEL` | Default model | `claude-sonnet-4-6` |
| `CLAUDE_CODE_SIMPLE` | Minimal mode: Bash/Read/Edit only, no MCP/hooks/CLAUDE.md | `1` |
| `CLAUDE_CODE_SHELL` | Override shell | `bash` |
| `CLAUDE_CONFIG_DIR` | Custom config directory | `/opt/claude-research-config` |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Disable background tasks | `1` |
| `CLAUDE_CODE_DISABLE_FAST_MODE` | Disable fast mode | `1` |
| `ENABLE_TOOL_SEARCH` | MCP tool search behavior | `false` |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | Enable/disable claude.ai MCP servers | `false` |
| `BASH_DEFAULT_TIMEOUT_MS` | Bash timeout | `30000` |
| `MAX_MCP_OUTPUT_TOKENS` | MCP output limit | `50000` |
| `MCP_TIMEOUT` | MCP server startup timeout | `10000` |

**`CLAUDE_CONFIG_DIR`** is particularly useful for complete isolation -- it redirects all config/data to a separate directory, preventing cross-contamination between profiles.

**`CLAUDE_CODE_SIMPLE`** is a quick way to get a stripped-down agent with only Bash, Read, and Edit -- no MCP, no hooks, no CLAUDE.md loading.

#### The `--settings` Flag

Load additional settings from a file or JSON string per session:

```bash
claude --settings ./profiles/research-settings.json
```

This is additive and follows normal precedence rules.

#### The `--setting-sources` Flag

Control which setting scopes are loaded:

```bash
# Only load user settings, ignore project settings
claude --setting-sources user

# Only load project settings
claude --setting-sources project

# Load specific combination
claude --setting-sources user,project
```

#### SDK Programmatic Configuration

The Agent SDK provides full programmatic control:

```python
from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition

async for message in query(
    prompt="Analyze this codebase",
    options=ClaudeAgentOptions(
        allowed_tools=["Read", "Glob", "Grep", "WebSearch"],
        permission_mode="bypassPermissions",
        model="sonnet",
        mcp_servers={
            "exa": {"command": "npx", "args": ["-y", "@anthropic/mcp-exa"]}
        },
        agents={
            "explorer": AgentDefinition(
                description="Codebase explorer",
                prompt="Explore and summarize code structure",
                tools=["Read", "Glob", "Grep"],
            )
        },
        hooks={
            "PostToolUse": [
                HookMatcher(matcher="Edit|Write", hooks=[audit_logger])
            ]
        },
    ),
):
    handle(message)
```

#### Isolated Agent Configuration Pattern

For fully isolated profiles that do not interfere with each other:

```bash
#!/bin/bash
# ~/bin/claude-isolated-research

export CLAUDE_CONFIG_DIR="/tmp/claude-research-$$"
mkdir -p "$CLAUDE_CONFIG_DIR"

# Write isolated settings
cat > "$CLAUDE_CONFIG_DIR/settings.json" << 'EOF'
{
  "permissions": {
    "deny": ["Bash", "Edit", "Write"],
    "allow": ["Read", "Glob", "Grep"]
  }
}
EOF

exec claude \
  --permission-mode plan \
  --strict-mcp-config \
  --mcp-config ~/.claude/mcp-research.json \
  "$@"
```

---

## Sources

1. [Claude Code Settings -- Official Docs](https://code.claude.com/docs/en/settings)
2. [Configure Permissions -- Official Docs](https://code.claude.com/docs/en/permissions)
3. [Connect Claude Code to tools via MCP -- Official Docs](https://code.claude.com/docs/en/mcp)
4. [Create Custom Subagents -- Official Docs](https://code.claude.com/docs/en/sub-agents)
5. [Run Claude Code Programmatically -- Official Docs](https://code.claude.com/docs/en/headless)
6. [CLI Reference -- Official Docs](https://code.claude.com/docs/en/cli-reference)
7. [Agent SDK Overview -- Official Docs](https://platform.claude.com/docs/en/agent-sdk/overview)
8. [Configure Permissions (Agent SDK) -- Official Docs](https://platform.claude.com/docs/en/agent-sdk/permissions)
9. [Trail of Bits claude-code-config -- GitHub](https://github.com/trailofbits/claude-code-config)
10. [Claude Code Permissions Issue #12232 -- GitHub](https://github.com/anthropics/claude-code/issues/12232)
11. [allowed_tools SDK Issue #361 -- GitHub](https://github.com/anthropics/claude-agent-sdk-python/issues/361)
12. [allowedTools SDK Issue #115 -- GitHub](https://github.com/anthropics/claude-agent-sdk-typescript/issues/115)
13. [Using CLAUDE.MD Files -- Anthropic Blog](https://claude.com/blog/using-claude-md-files)
14. [feiskyer/claude-code-settings -- GitHub](https://github.com/feiskyer/claude-code-settings)

---

## Implications

### Building Swappable Agent Profiles Is Fully Supported

Claude Code's configuration system was designed for exactly this use case. The combination of:
- **Agent markdown files** (`.claude/agents/`) for reusable profile definitions
- **`--agent` flag** for main-thread profile switching
- **`--tools`, `--allowedTools`, `--disallowedTools`** for tool restriction at launch
- **`--mcp-config` and `--strict-mcp-config`** for per-profile MCP server sets
- **`--permission-mode`** for security posture per profile
- **`--settings` and `--setting-sources`** for per-profile settings
- **`CLAUDE_CONFIG_DIR`** for complete config isolation

...means agent profiles can be defined as simple markdown files and invoked with a single command or alias.

### Recommended Architecture

1. **Define profiles as agent markdown files** in `~/.claude/agents/` (user-level, cross-project) or `.claude/agents/` (project-specific)
2. **Create per-profile MCP config files** (e.g., `~/.claude/mcp-research.json`, `~/.claude/mcp-ops.json`)
3. **Wrap in shell aliases** that combine `--agent`, `--strict-mcp-config`, `--mcp-config`, and any environment overrides
4. **For SDK automation**, encode profiles as `ClaudeAgentOptions` dictionaries and select at runtime

### Defense-in-Depth

Tool restrictions via `--tools` and `--disallowedTools` are the first line of defense. For stronger guarantees, combine with:
- `--permission-mode plan` for truly read-only profiles
- Sandboxing (`sandbox` settings) for OS-level isolation
- PreToolUse hooks for conditional validation (e.g., block SQL writes but allow reads)
- `CLAUDE_CONFIG_DIR` for complete config isolation between profiles

---

## Open Questions

1. **`allowed_tools` SDK reliability**: There are open GitHub issues indicating that `allowed_tools` in the Python/TypeScript SDK does not reliably restrict built-in tools. Testing is needed to confirm current behavior and determine if `disallowed_tools` is the more reliable mechanism.

2. **`--tools` vs `--allowedTools` interaction**: The distinction between "which tools exist" (`--tools`) and "which tools are auto-approved" (`--allowedTools`) needs hands-on testing to confirm exact behavior when combined.

3. **`--strict-mcp-config` + agent `mcpServers`**: Does `--strict-mcp-config` also prevent subagent-level `mcpServers` from loading, or only user/project-level configs? Needs testing.

4. **`CLAUDE_CONFIG_DIR` completeness**: Does redirecting the config directory truly isolate ALL state (sessions, MCP auth tokens, permission history), or do some paths remain hardcoded to `~/.claude/`?

5. **Agent profile hot-reloading**: Agent files are loaded at session start. Can profiles be switched mid-session, or does this require starting a new session?

6. **`--agent` + `--tools` composability**: When using `--agent my-agent` where the agent file specifies `tools: Read, Glob`, does additionally passing `--tools "Read,Glob,Bash"` expand or further restrict the tool set? Precedence needs testing.

7. **Subagent tool restriction inheritance**: When a main-thread agent (via `--agent`) defines restricted tools, do delegated subagents inherit those restrictions or do they get the full tool set?

8. **MCP server per-subagent isolation**: If a subagent specifies `mcpServers: [postgres-mcp]`, does the main thread also gain access to those MCP tools, or are they truly scoped to the subagent?

9. **Profile switching UX**: Is there a way to switch profiles within an interactive session (e.g., via a slash command), or must you start a new session each time?

10. **Enterprise managed settings + profiles**: How do managed settings interact with profile-level tool restrictions? If managed settings deny a tool, can a profile re-allow it? (Expected answer: no, managed deny always wins.)
