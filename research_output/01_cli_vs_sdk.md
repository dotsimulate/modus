# Claude Code CLI vs Agent SDK — Research Report
*Generated: 2026-03-02*

## Summary

Claude Code provides two primary interfaces for programmatic interaction: the **Claude Code CLI** (the `claude` command) and the **Claude Agent SDK** (available as `claude-agent-sdk` for Python and `@anthropic-ai/claude-agent-sdk` for TypeScript/Node.js). Both share the same underlying agentic engine — the same tools, agent loop, and context management — but they serve fundamentally different use cases. The CLI is optimized for direct terminal usage, scripting, and one-off automation, while the SDK is designed for embedding Claude's agent capabilities into custom applications, backend services, and production systems.

A billing nuance exists between the two. The CLI supports both Pro/Max subscription billing and API key authentication natively. The Agent SDK's official docs emphasize API key authentication, but **subscription billing works via OAuth token**: run `claude setup-token` to get an OAuth token, set `CLAUDE_CODE_OAUTH_TOKEN`, and the SDK bills against your subscription quota. This works because the SDK wraps the CLI under the hood and inherits its auth. The `claude_agent_sdk_oauth_demo` project (GitHub) demonstrates this pattern. Note: Anthropic's docs discourage third-party developers from offering claude.ai login to end users, but for first-party/personal use, OAuth token auth is a supported path.

Both interfaces support session management, tool control, MCP server integration, custom system prompts, and streaming output. However, the SDK provides substantially more programmatic control — including in-process hooks (PreToolUse, PostToolUse, etc.), custom tool creation via `@tool` decorators, streaming input mode with image uploads, and container-based hosting patterns for production deployment. The CLI excels at rapid iteration, piping, and interactive development workflows.

## Findings

### 1. Claude Code CLI Capabilities

**Core Invocation Modes** [HIGH confidence]
- `claude` — Start interactive REPL session
- `claude "query"` — Start interactive session with initial prompt
- `claude -p "query"` — Non-interactive (print) mode: query, get response, exit. This is the scripting workhorse.
- `cat file | claude -p "query"` — Pipe content as context into non-interactive mode

**Session Management** [HIGH confidence]
- `claude -c` / `--continue` — Continue the most recent conversation in the current directory, preserving full context
- `claude -r <session>` / `--resume <session>` — Resume a specific session by ID or name, or open an interactive picker
- `--session-id <uuid>` — Use a specific UUID for the conversation
- `--fork-session` — When resuming, create a new session branch instead of continuing the original
- `--no-session-persistence` — Disable saving sessions to disk (print mode only)
- `--from-pr <number>` — Resume sessions linked to a GitHub PR
- All conversations are automatically saved locally with full message history, tool usage, and results

**Output Formats** [HIGH confidence]
- `--output-format text` — Plain text output (default)
- `--output-format json` — Full JSON response with metadata, useful for scripting
- `--output-format stream-json` — Streaming JSON messages as they arrive, enables real-time processing
- `--include-partial-messages` — Include partial streaming events (requires `--print` and `stream-json`)
- `--input-format text|stream-json` — Control input format for programmatic piping

**System Prompt Control** [HIGH confidence]
- `--system-prompt "text"` — **Replace** the entire default system prompt (removes all built-in Claude Code instructions)
- `--system-prompt-file ./prompt.txt` — Replace with file contents (print mode only)
- `--append-system-prompt "text"` — **Append** to default prompt while preserving built-in capabilities
- `--append-system-prompt-file ./file.txt` — Append file contents (print mode only)
- `--system-prompt` and `--system-prompt-file` are mutually exclusive; append flags can combine with either

**Tool Control** [HIGH confidence]
- `--allowedTools "Read,Write,Bash"` — Pre-approve specific tools to run without permission prompts. Supports pattern matching (e.g., `"Bash(git log *)"`)
- `--disallowedTools "Bash(rm:*)" "Bash(sudo:*)"` — Remove specific tools entirely from the model's context
- `--tools "Bash,Edit,Read"` — Restrict which built-in tools are available at all. Use `""` to disable all, `"default"` for all
- `--dangerously-skip-permissions` — Skip ALL permission prompts ("YOLO mode"). Bypasses command blocklist, write restrictions, permission system, and MCP trust verification
- `--allow-dangerously-skip-permissions` — Enable permission bypassing as an option without immediately activating it; composable with `--permission-mode`
- `--permission-mode plan|acceptEdits|bypassPermissions` — Begin in a specific permission mode
- `--permission-prompt-tool mcp_tool` — Delegate permission prompts to an MCP tool in non-interactive mode

**Model and Budget Control** [HIGH confidence]
- `--model claude-sonnet-4-6` — Set model for the session; accepts aliases (`sonnet`, `opus`) or full names
- `--fallback-model sonnet` — Automatic fallback when default model is overloaded (print mode only)
- `--max-turns 3` — Limit autonomous agentic turns (print mode only). No limit by default
- `--max-budget-usd 5.00` — Maximum dollar spend on API calls before stopping (print mode only)

**MCP Server Integration** [HIGH confidence]
- `--mcp-config ./mcp.json` — Load MCP servers from a JSON configuration file
- `--strict-mcp-config` — Only use MCP servers from the config, ignoring all others
- `claude mcp` — Subcommand for managing MCP server configurations

**Other Notable Flags** [HIGH confidence]
- `--verbose` — Enable detailed diagnostic output showing internal operations, tool executions, and API communications
- `--debug "api,hooks"` — Debug mode with optional category filtering
- `--add-dir ../apps ../lib` — Add additional working directories for Claude to access
- `--worktree` / `-w` — Start in an isolated git worktree
- `--chrome` / `--no-chrome` — Enable/disable Chrome browser integration
- `--agent my-agent` — Specify a custom agent for the session
- `--agents '{...}'` — Define custom subagents dynamically via JSON (with description, prompt, tools, model, etc.)
- `--json-schema '{...}'` — Get validated JSON output matching a schema (print mode only)
- `--settings ./settings.json` — Load additional settings from a file
- `--setting-sources user,project,local` — Control which setting sources are loaded
- `--remote "task"` — Create a web session on claude.ai
- `--teleport` — Resume a web session in your local terminal

**Project Context** [HIGH confidence]
- `CLAUDE.md` — Project-level context file in repo root, automatically loaded into system prompt
- `~/.claude/CLAUDE.md` — Global personal preferences applied to all projects
- `.claude/settings.json` — Structured settings for permissions, hooks, environment, and tool configuration
- `.claude/settings.local.json` — Personal overrides (gitignored)
- `.claude/skills/` — Custom skill definitions in Markdown
- `.claude/commands/` — Slash commands for common tasks
- `.claude/agents/` — Custom AI agent definitions

**Piping and Headless Operation** [HIGH confidence]
- Full stdin/stdout support with JSON messages
- Stream-JSON chaining enables connecting multiple `claude -p` processes for multi-agent pipelines
- `--input-format stream-json` allows writing JSON messages to the CLI's stdin
- Suitable for CI/CD, GitHub Actions, and automated workflows

### 2. Agent SDK Capabilities

**Package Names and Installation** [HIGH confidence]
- **Python**: `pip install claude-agent-sdk` — imports as `from claude_agent_sdk import query, ClaudeAgentOptions`
- **TypeScript/Node.js**: `npm install @anthropic-ai/claude-agent-sdk` — imports as `import { query } from "@anthropic-ai/claude-agent-sdk"`
- **Note**: Previously called "Claude Code SDK"; renamed to "Claude Agent SDK" with migration guide available
- **Go**: Unofficial community port exists (`github.com/schlunsen/claude-agent-sdk-go`)

**Authentication** [HIGH confidence]
- Primary: `ANTHROPIC_API_KEY` environment variable (API key from Console)
- Amazon Bedrock: Set `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials
- Google Vertex AI: Set `CLAUDE_CODE_USE_VERTEX=1` + Google Cloud credentials
- Microsoft Azure: Set `CLAUDE_CODE_USE_FOUNDRY=1` + Azure credentials
- Workaround for subscription billing: `CLAUDE_CODE_OAUTH_TOKEN` (unofficial, community-discovered)

**Core API** [HIGH confidence]
- `query(prompt, options)` — Primary entry point; returns an async iterator of messages
- `ClaudeAgentOptions` (Python) / options object (TypeScript) — Configuration for all agent behavior
- `ClaudeSDKClient` (Python) — Context manager for streaming input mode with `client.query()` and `client.receive_response()`
- Both single-message and streaming input modes supported

**Built-in Tools** [HIGH confidence]
| Tool | Purpose |
|------|---------|
| Read | Read any file in the working directory |
| Write | Create new files |
| Edit | Make precise edits to existing files |
| Bash | Run terminal commands, scripts, git operations |
| Glob | Find files by pattern |
| Grep | Search file contents with regex |
| WebSearch | Search the web for current information |
| WebFetch | Fetch and parse web page content |
| AskUserQuestion | Ask user clarifying questions with multiple choice |
| Task | Invoke subagents |

**Custom Tools** [HIGH confidence]
- `@tool` decorator (Python) / `tool()` function (TypeScript) for defining custom tools
- `create_sdk_mcp_server()` / `createSdkMcpServer()` — Wraps custom tools into in-process MCP servers
- Tools run in-process (no IPC overhead), with type safety via simple type hints (Python) or Zod schemas (TypeScript)
- Custom tools require streaming input mode (async generator for prompt parameter)
- Tool names follow pattern `mcp__{server_name}__{tool_name}`

**Hooks System** [HIGH confidence]
- **PreToolUse** — Before tool execution; can block (`deny`), allow, modify input (`updatedInput`), or ask for approval
- **PostToolUse** — After tool execution; can add context to tool results
- **PostToolUseFailure** — When a tool execution fails
- **UserPromptSubmit** — When user submits a prompt
- **Stop** — When agent execution stops
- **SubagentStart** / **SubagentStop** — Subagent lifecycle events
- **PreCompact** — Before conversation compaction
- **PermissionRequest** — When a permission dialog would be displayed
- **Notification** — Agent status messages (permission_prompt, idle_prompt, auth_success, elicitation_dialog)
- **SessionStart** / **SessionEnd** — TypeScript only (Python uses shell command hooks via settings files)
- **Setup**, **TeammateIdle**, **TaskCompleted**, **ConfigChange**, **WorktreeCreate**, **WorktreeRemove** — TypeScript only
- Hooks configured via `HookMatcher` with regex patterns for filtering by tool name
- Callbacks receive typed input data, tool_use_id, and context (with AbortSignal in TS)
- Outputs can inject `systemMessage` into conversation, set `permissionDecision`, provide `updatedInput`
- Async mode available for fire-and-forget side effects (logging, webhooks)

**Streaming Events** [HIGH confidence]
- Default: yields complete `AssistantMessage` objects after each generation
- With `include_partial_messages=True`: also yields `StreamEvent` messages containing raw Claude API events
- Event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- Text chunks arrive as `content_block_delta` with `delta.type == "text_delta"`
- Tool inputs stream as `content_block_delta` with `delta.type == "input_json_delta"`
- Final message types: `SystemMessage` (init), `AssistantMessage` (complete responses), `ResultMessage` (final result), `CompactBoundaryMessage`
- Limitation: streaming incompatible with extended thinking (`max_thinking_tokens`) and structured output

**Session Management** [HIGH confidence]
- Session ID automatically returned in initial `system/init` message
- Resume sessions via `options.resume = session_id`
- Fork sessions via `options.fork_session = True` — creates new branch preserving original
- Continue most recent via `options.continue_conversation = True` (Python) / `options.continue = true` (TypeScript)
- Full conversation history, tool usage, and results preserved on resume

**Subagents** [HIGH confidence]
- Define via `agents` parameter in options with `AgentDefinition` (Python) / plain object (TypeScript)
- Each subagent has: description, prompt, tools, model, disallowedTools, skills, mcpServers, maxTurns
- Invoked via the `Task` tool (must include "Task" in allowedTools)
- Messages from subagents include `parent_tool_use_id` for tracking

**Permissions** [HIGH confidence]
- `permission_mode` options: `"bypassPermissions"`, `"acceptEdits"`, `"plan"`, etc.
- `allowed_tools` — Pre-approve specific tools
- Fine-grained control via PreToolUse hooks
- Deny takes priority over ask, which takes priority over allow

**Hosting and Production Deployment** [HIGH confidence]
- Container-based sandboxing recommended for security and isolation
- System requirements: Python 3.10+ or Node.js 18+, Claude Code CLI, ~1GiB RAM, 5GiB disk, 1 CPU
- Outbound HTTPS to `api.anthropic.com` required
- Four deployment patterns documented:
  1. **Ephemeral Sessions** — New container per task, destroy when complete
  2. **Long-Running Sessions** — Persistent containers for proactive agents
  3. **Hybrid Sessions** — Ephemeral containers hydrated with session history
  4. **Single Container** — Multiple SDK processes in one container (for agent collaboration)
- Sandbox providers: Modal, Cloudflare, Daytona, E2B, Fly Machines, Vercel Sandbox
- Container cost: ~$0.05/hour minimum; token cost is dominant

### 3. Key Differences

| Aspect | CLI (`claude`) | Agent SDK |
|--------|---------------|-----------|
| **Interface** | Terminal command, stdin/stdout | Library import in Python/TypeScript |
| **Primary use case** | Interactive dev, scripting, CI/CD | Custom applications, backend services, production agents |
| **Billing** | Pro/Max subscription OR API key | API key only (subscription workaround exists but unofficial) |
| **Custom tools** | No (MCP servers only via config) | Yes — `@tool` decorator, in-process MCP servers |
| **Hooks (in-process)** | Shell command hooks only (via settings.json) | Full programmatic callback hooks with typed I/O |
| **Image uploads** | Not directly via CLI flags | Yes, via streaming input mode |
| **Streaming input** | Via `--input-format stream-json` | Native async generator/iterable |
| **System prompt** | `--system-prompt` or `--append-system-prompt` | `system_prompt` or `append_system_prompt` in options |
| **Session management** | `--resume`, `--continue`, `--fork-session` | `resume`, `continue`, `fork_session` in options |
| **Subagents** | `--agents` JSON flag or `.claude/agents/` | `agents` parameter with `AgentDefinition` |
| **MCP servers** | `--mcp-config` flag | `mcp_servers` in options (including in-process servers) |
| **Tool restriction** | `--tools`, `--allowedTools`, `--disallowedTools` | `allowed_tools`, `disallowed_tools`, `tools` in options |
| **Output format** | text, json, stream-json | Typed message objects via async iterator |
| **Permission modes** | `--permission-mode`, `--dangerously-skip-permissions` | `permission_mode`, `bypassPermissions` |
| **Budget control** | `--max-budget-usd`, `--max-turns` | `max_turns` in options (budget control via API) |
| **Structured output** | `--json-schema` flag | `json_schema` in options |
| **Concurrent sessions** | Multiple terminal instances / background processes | Multiple `query()` calls / container orchestration |
| **Chrome integration** | `--chrome` flag | Not directly supported |
| **Remote/web sessions** | `--remote`, `--teleport` | Not applicable |

**SDK-Exclusive Features:**
- In-process custom tools via `@tool` decorator (no separate process needed)
- Programmatic hooks with typed callbacks (PreToolUse, PostToolUse, etc. — not just shell commands)
- Streaming input mode with image uploads and message queueing
- Container-based hosting patterns with documented deployment architectures
- More hook event types in TypeScript: SessionStart, SessionEnd, TeammateIdle, TaskCompleted, ConfigChange, WorktreeCreate, WorktreeRemove

**CLI-Exclusive Features:**
- Interactive REPL with slash commands, keyboard shortcuts
- Chrome browser integration (`--chrome`)
- Remote/web sessions (`--remote`, `--teleport`)
- `--from-pr` for PR-linked session management
- Git worktree management (`--worktree`)
- `--fallback-model` for automatic model failover
- `--max-budget-usd` for dollar-amount budget caps
- Pro/Max subscription billing (native support)
- `claude mcp` subcommand for MCP management
- `claude agents` for listing configured subagents
- `claude auth` for authentication management

### 4. Speed and Reliability

**Latency** [MEDIUM confidence]
- Both CLI and SDK communicate with the same Claude API backend, so model inference latency is identical
- SDK has slightly lower overhead for programmatic use (no process spawn, no CLI parsing)
- CLI process spawn adds ~1-3s overhead per invocation in non-interactive mode
- Streaming output available in both, enabling real-time token display

**Recent Service Issues (March 2026)** [HIGH confidence]
- Major outage on March 2, 2026 affecting Claude.ai, developer console, and Claude Code
- Intermittent failures across web app, API, and Claude Code reported
- Engineers deployed preliminary fixes with additional error modes discovered during remediation

**Known Bugs (February-March 2026)** [HIGH confidence]
- Startup hang after auto-update when `settings.local.json` contains certain previously-valid settings (e.g., `enableAllProjectMcpServers: true`)
- Windows config file write contention starting with Claude Code 2.1.59
- MCP server detection can fail with `--dangerously-skip-permissions` (GitHub issue #6856)
- MCP server initialization issues on first run with skip-permissions flag (issue #6130)
- Worktree launch issues, Windows panics, process spawn crashes fixed in recent updates

**Community Observations** [MEDIUM confidence]
- Claude Code described as "one of the most reliable AI development assistants available in 2026"
- Daily benchmark tracking exists for degradation detection (Hacker News discussion)
- Agent SDK adoption growing but still early; fewer community reports compared to CLI
- Non-determinism between CLI and SDK outputs confirmed — no seed parameter exists

### 5. Backend Integration Suitability

**For Wrapping in a Backend Service:**
- **SDK is strongly preferred.** It provides a native library interface, typed message objects, async iteration, and documented hosting patterns for containers. You avoid process management, stdin/stdout parsing, and CLI overhead.
- **CLI is viable** for simpler integrations via `claude -p --output-format json` piped to your service, but you're managing subprocesses and parsing JSON output yourself.

**For Running Headless:**
- **Both work.** CLI uses `-p` (print mode) for headless operation. SDK is inherently headless.
- **CLI caveat:** `--dangerously-skip-permissions` is required for fully unattended operation but has known MCP detection bugs. The SDK offers `permission_mode="bypassPermissions"` which is cleaner.

**For Multiple Concurrent Sessions:**
- **SDK is better suited.** Multiple `query()` calls can run concurrently in the same process. Container orchestration patterns are documented.
- **CLI requires** spawning multiple processes or using tools like `claude-flow` for multi-agent orchestration.

**For Custom System Prompts:**
- **Both offer full control.** CLI: `--system-prompt` or `--append-system-prompt`. SDK: `system_prompt` or `append_system_prompt` in options.
- **Important difference:** CLI uses a rich modular system prompt (~269 base tokens with conditional loading). SDK uses a minimal prompt by default. This means behavior can differ between the two even with identical custom prompts.

**For Disabling/Restricting Tools:**
- **Both provide granular control.** CLI: `--tools`, `--allowedTools`, `--disallowedTools`. SDK: `allowed_tools`, `disallowed_tools`, `tools`.
- **SDK advantage:** PreToolUse hooks can dynamically approve/deny/modify tool calls based on runtime logic (e.g., checking file paths, rate limiting).

**For Attaching MCP Servers:**
- **Both support it.** CLI: `--mcp-config ./mcp.json`. SDK: `mcp_servers` in options.
- **SDK advantage:** In-process MCP servers via `create_sdk_mcp_server()` eliminate IPC overhead and simplify deployment to a single process.

**For Resuming Sessions:**
- **Both support it.** CLI: `--resume <id>`, `--continue`, `--fork-session`. SDK: `resume`, `continue`, `fork_session` in options.
- **SDK advantage:** Programmatic access to session IDs from init messages, enabling database-backed session tracking.

**Billing Consideration for Backend Use:**
- If building a product on the SDK, you MUST use API key billing (pay-per-token). This can be expensive at scale.
- If using CLI with Pro/Max subscription, you get predictable monthly costs but are subject to rate limits.
- The unofficial `CLAUDE_CODE_OAUTH_TOKEN` workaround for SDK subscription billing is not guaranteed to remain available.

**Recommendation:**
For a backend agent harness, the **Agent SDK** is the right choice. It provides the programmatic control, hook system, custom tooling, and hosting patterns needed for production deployment. Use the CLI for development, testing, and one-off scripting tasks. Be prepared for API billing costs and plan your token budget accordingly.

## Sources

1. [Claude Code CLI Reference (Official)](https://code.claude.com/docs/en/cli-reference)
2. [Agent SDK Overview (Official)](https://platform.claude.com/docs/en/agent-sdk/overview)
3. [Agent SDK Hooks Documentation](https://platform.claude.com/docs/en/agent-sdk/hooks)
4. [Agent SDK Session Management](https://platform.claude.com/docs/en/agent-sdk/sessions)
5. [Agent SDK Hosting Guide](https://platform.claude.com/docs/en/agent-sdk/hosting)
6. [Agent SDK Streaming Output](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
7. [Agent SDK Streaming vs Single Mode](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
8. [Agent SDK Custom Tools](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
9. [Claude Agent SDK Python (GitHub)](https://github.com/anthropics/claude-agent-sdk-python)
10. [Claude Agent SDK TypeScript (GitHub)](https://github.com/anthropics/claude-agent-sdk-typescript)
11. [Claude Agent SDK Python (PyPI)](https://pypi.org/project/claude-agent-sdk/)
12. [@anthropic-ai/claude-agent-sdk (npm)](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
13. [Agent SDK Max Plan Billing Issue #559](https://github.com/anthropics/claude-agent-sdk-python/issues/559)
14. [Using Claude Code with Pro/Max Plan (Help Center)](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)
15. [Claude Code vs Claude Agent SDK (Medium)](https://drlee.io/claude-code-vs-claude-agent-sdk-whats-the-difference-177971c442a9)
16. [Building Agents with the Claude Agent SDK (Anthropic Blog)](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
17. [Agent SDK vs CLI System Prompts Comparison](https://github.com/shanraisshan/claude-code-best-practice/blob/main/reports/claude-agent-sdk-vs-cli-system-prompts.md)
18. [Claude Code Troubleshooting](https://code.claude.com/docs/en/troubleshooting)
19. [Claude Code MCP Server Bug #6856](https://github.com/anthropics/claude-code/issues/6856)
20. [Claude Code Startup Hang Bug #29652](https://github.com/anthropics/claude-code/issues/29652)
21. [Shipyard — Claude Code CLI Cheatsheet](https://shipyard.build/blog/claude-code-cheat-sheet/)
22. [Nader Dabit — Complete Guide to Building Agents with Claude Agent SDK](https://nader.substack.com/p/the-complete-guide-to-building-agents)
23. [Claude Agent SDK — From Weekend Hacks to Production-Ready Agents](https://www.vibesparking.com/en/blog/ai/2026-02-02-claude-agent-sdk-enterprise-guide/)
24. [Inside the Claude Agent SDK: stdin/stdout to Production on AWS](https://buildwithaws.substack.com/p/inside-the-claude-agent-sdk-from)

## Implications

For building our agent harness, several implications emerge from this research:

1. **Use the Agent SDK as the primary integration layer.** It provides typed async message streams, in-process hooks for monitoring and control, custom tool creation without separate processes, and documented production hosting patterns. The CLI should remain our tool for interactive development and testing.

2. **Billing architecture matters.** The SDK requires API key billing (pay-per-token), not subscription. At scale, this cost structure needs budgeting. The `--max-turns` option and hook-based rate limiting are our primary cost controls. The unofficial `CLAUDE_CODE_OAUTH_TOKEN` workaround for subscription billing is worth testing but cannot be relied upon for production.

3. **The hook system is our control plane.** PreToolUse hooks give us the ability to block dangerous operations, enforce sandboxing, audit tool calls, and inject context — all programmatically. This is significantly more powerful than the CLI's shell-command hooks.

4. **Session management enables stateful agents.** Capturing session IDs from init messages and storing them in a database enables resume, fork, and multi-step workflows. The SDK's hybrid session pattern (ephemeral containers hydrated with session state) aligns well with a backend architecture.

5. **System prompt differences need testing.** The CLI and SDK use different default system prompts. When migrating prompts from CLI testing to SDK production, expect behavioral differences. The SDK's minimal default prompt means you may need to add instructions that the CLI provides automatically.

6. **MCP integration is flexible in both.** The SDK's in-process MCP servers via `create_sdk_mcp_server()` are particularly useful for our custom tools — no separate process management needed.

## Open Questions

1. **CLAUDE_CODE_OAUTH_TOKEN reliability:** Does the community workaround for subscription billing in the SDK work reliably? Is it subject to rate limiting? Could Anthropic disable it at any time? Needs hands-on testing.

2. **Concurrent session limits:** What are the practical limits on concurrent `query()` calls in a single process? How does the SDK handle backpressure when running many parallel agents? The hosting guide mentions it but doesn't specify numbers.

3. **Session storage location and portability:** Where are sessions stored on disk? Can session data be moved between machines for distributed resumption? The documentation doesn't clarify this.

4. **SDK system prompt content:** What exactly is in the SDK's minimal default system prompt vs the CLI's modular one? The comparison report references ~269 base tokens for CLI but doesn't detail the SDK's. We need to inspect this for behavioral parity.

5. **Hook performance impact:** What is the latency overhead of hooks, especially when chaining multiple PreToolUse hooks? Are there benchmarks?

6. **Extended thinking compatibility:** Streaming is incompatible with `max_thinking_tokens`. How does this affect our use case if we want both streaming UI and thinking? Is there a workaround?

7. **Python vs TypeScript SDK parity:** Several hook types (SessionStart, SessionEnd, TeammateIdle, TaskCompleted, etc.) are TypeScript-only. Will Python catch up, or should we use TypeScript for maximum capability?

8. **Cost tracking in SDK:** The hosting guide mentions a "Cost Tracking" page. What granularity of cost data is available per session / per tool call? Needs investigation for budget management.

9. **Agent teams stability:** The experimental "agent teams" feature (multiple Claude Code instances coordinating) is disabled by default with known issues. When will this stabilize for production use?

10. **MCP detection bug with skip-permissions:** GitHub issues #6856 and #6130 report that MCP servers fail to load with `--dangerously-skip-permissions`. Is this also an issue in the SDK's `bypassPermissions` mode? Needs testing.
