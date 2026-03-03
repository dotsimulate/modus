# Lightweight Agent Harness Architectures -- Research Report
*Generated: 2026-03-02*

## Summary

This report surveys the current landscape for building lightweight backend harnesses around Claude Code -- the agentic coding tool from Anthropic. The goal is to understand how to programmatically control Claude Code sessions, stream their output to frontends, manage concurrent agents, and persist state across restarts. The research covers three primary integration vectors: the CLI subprocess approach, the official Agent SDK (available in both Python and TypeScript), and community-built wrappers that combine these primitives into higher-level abstractions.

The most significant finding is that Anthropic has substantially matured the programmatic surface area since mid-2025. The "Claude Code SDK" has been renamed to the "Claude Agent SDK" and is now available as both `@anthropic-ai/claude-agent-sdk` (npm) and `claude-agent-sdk` (PyPI). This SDK provides native async iterators, structured streaming events, session resumption, session forking, lifecycle hooks, subagent orchestration, and MCP integration -- all without requiring raw subprocess management. The CLI subprocess approach remains viable for simpler use cases and CI/CD pipelines, but for production harnesses the SDK is now the clearly recommended path.

Several open-source projects have already demonstrated viable architectures: `claude-agent-server` (WebSocket bridge over the SDK with E2B sandbox support), `claude-code-openai-wrapper` (FastAPI server exposing OpenAI-compatible endpoints), `claude-code-webui` (React frontend spawning CLI subprocesses), and `opcode` (Tauri desktop app managing sessions). These projects validate distinct architectural patterns and provide reference implementations worth studying. A critical operational concern is token efficiency: naively spawning Claude subprocesses can burn 50K tokens per turn due to repeated global configuration injection, but a documented "4-layer isolation" technique reduces this by 10x.

## Findings

### 1. CLI Subprocess Wrapper

**Confidence: HIGH** -- This approach is well-documented in official Anthropic docs and validated by multiple community projects.

#### Spawning Claude Code Processes

The `claude` CLI supports a `-p` (or `--print`) flag for non-interactive execution. This is the foundation of all subprocess-based harnesses:

```bash
claude -p "Find and fix the bug in auth.py" --allowedTools "Read,Edit,Bash"
```

In Python, this is typically done with `subprocess.Popen` or `asyncio.create_subprocess_exec`. In Node.js, `child_process.spawn` is used. There is a known issue (GitHub #771) where Claude Code v0.2.69 could not be spawned from Node.js on macOS, though this has been addressed in later versions.

A critical environment variable concern: when spawning Claude Code from within a Claude Code session (e.g., hooks or plugins), the child process inherits the `CLAUDECODE=1` environment variable, which can cause the SDK to malfunction (GitHub #573). The workaround is to explicitly unset this variable in the child's environment.

#### Capturing Streaming Output

The `--output-format stream-json` flag emits newline-delimited JSON (NDJSON) where each line is a complete JSON object. Combined with `--verbose` and `--include-partial-messages`, you get token-level streaming:

```bash
claude -p "Explain recursion" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages
```

Event types in the NDJSON stream include:
- `init` -- session ID and timestamp
- `message` -- assistant or user messages with content arrays
- `tool_use` -- tool invocations with name and input
- `tool_result` -- tool execution outputs
- `stream_event` -- raw API streaming events (content_block_delta, text_delta, etc.)
- `result` -- final result with status, duration, cost, and usage metadata

For filtering text output in real-time:
```bash
claude -p "Write a poem" --output-format stream-json --verbose --include-partial-messages | \
  jq -rj 'select(.type == "stream_event" and .event.delta.type? == "text_delta") | .event.delta.text'
```

#### Session Management

The CLI provides two session continuation flags:
- `--continue` / `-c` -- resumes the most recent conversation in the current directory
- `--resume <session-id>` / `-r <session-id>` -- resumes a specific session by ID

For programmatic session management:
```bash
# Capture session ID from first request
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
# Resume that specific session
claude -p "Continue that review" --resume "$session_id"
```

#### Error Recovery and Process Death

When a Claude Code process dies unexpectedly, session data generally survives because Claude Code writes interaction data to disk as soon as it is created (append-only JSONL). However, there is a known bug (GitHub #27463) where the session storage directory is sometimes never created, leading to complete session loss on crash.

Recovery strategy: capture the session ID at process start, monitor the process exit code, and use `--resume` to restart. Since session history is persisted to disk incrementally, most data survives even unclean shutdowns.

#### Resource Management

Resource concerns for subprocess-based architectures are substantial:

- **Memory**: Claude Code's Node.js process idles at 400-700 MB but can grow to 1-4 GB during active prompts. All subprocess stdout/stderr is retained permanently in the JavaScript heap. Anthropic recommends at least 4 GB of available RAM per instance.
- **CPU**: Multiple CLI processes can accumulate and cause high CPU usage (GitHub #11122). A known issue causes 100% CPU and memory consumption (GitHub #5771), and JSON serialization during multi-agent tasks can cause freezes (GitHub #4580).
- **Token burn**: Each fresh subprocess inherits the entire global configuration (~50K tokens before any work). This is the most critical cost concern. See Section 5 for mitigation.
- **Cleanup**: Processes must be explicitly killed; orphaned processes will continue consuming resources. Implement process group management and SIGTERM/SIGKILL escalation.

#### Persistent Stream-JSON Pattern

Instead of spawning a fresh subprocess per interaction, maintain a single long-lived process:
```bash
claude --print --input-format stream-json --output-format stream-json --session-id <id>
```
This keeps the process stateful in memory. The system prompt loads once on initialization; subsequent turns transmit only new messages through stdin. This eliminates redundant context re-injection and is the recommended approach for 24/7 wrappers.


### 2. SDK Wrapper Approach

**Confidence: HIGH** -- Based on official Anthropic documentation and SDK source code.

#### Architecture

The Claude Agent SDK wraps the Claude Code CLI internally. When you call `query()`, the SDK spawns the CLI as a subprocess, manages the communication, and surfaces events through a clean async iterator interface. The key difference from raw subprocess management is that the SDK handles all the serialization, event parsing, session management, and error recovery.

#### Python SDK (`claude-agent-sdk`)

Installation: `pip install claude-agent-sdk`

Basic usage:
```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions

async def main():
    async for message in query(
        prompt="Find and fix the bug in auth.py",
        options=ClaudeAgentOptions(allowed_tools=["Read", "Edit", "Bash"]),
    ):
        print(message)

asyncio.run(main())
```

The `ClaudeAgentOptions` class accepts:
- `allowed_tools` -- list of tools to auto-approve
- `permission_mode` -- "bypassPermissions", "acceptEdits", etc.
- `model` -- model identifier (e.g., "claude-opus-4-6")
- `system_prompt` -- custom system prompt
- `max_turns` -- limit on agent turns
- `resume` -- session ID for resumption
- `fork_session` -- boolean to fork instead of continue
- `include_partial_messages` -- enable streaming events
- `mcp_servers` -- MCP server configurations
- `hooks` -- lifecycle callback hooks
- `agents` -- subagent definitions
- `setting_sources` -- which config files to load ("project", "local")
- `cwd` -- working directory

#### TypeScript SDK (`@anthropic-ai/claude-agent-sdk`)

Installation: `npm install @anthropic-ai/claude-agent-sdk`

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

The TypeScript SDK provides more hook events than Python (18 vs 10), including `SessionStart`, `SessionEnd`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `WorktreeCreate`, and `WorktreeRemove`.

#### Event Stream Types

With `include_partial_messages: true` (Python) or `includePartialMessages: true` (TypeScript), the SDK yields the following message types:

| Type | Description |
|------|-------------|
| `SystemMessage` (subtype: `init`) | Session initialization with session_id |
| `StreamEvent` | Raw API streaming events (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop) |
| `AssistantMessage` | Complete assistant response with all content blocks |
| `ResultMessage` | Final result with success/error status, duration, cost, usage |
| `CompactBoundaryMessage` | Indicates conversation history was compacted |

The `StreamEvent` contains a raw `event` field with standard Claude API event types:
- `message_start` -- start of a new message
- `content_block_start` -- start of text or tool_use block
- `content_block_delta` -- incremental text or tool input chunks
- `content_block_stop` -- end of a content block
- `message_delta` -- message-level updates (stop reason, usage)
- `message_stop` -- end of message

The `ResultMessage` includes: `uuid`, `session_id`, `duration_ms`, `is_error`, `num_turns`, `result` string, `total_cost_usd`, and usage breakdown.

#### Hook System

The SDK provides a comprehensive hooks system with callback functions that fire at key points in the agent lifecycle:

**Available hooks (both SDKs):** PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SubagentStart, SubagentStop, PreCompact, PermissionRequest, Notification.

**TypeScript-only:** SessionStart, SessionEnd, Setup, TeammateIdle, TaskCompleted, ConfigChange, WorktreeCreate, WorktreeRemove.

Hook callbacks receive three arguments:
1. `input_data` -- typed object with event details (tool_name, tool_input, session_id, cwd, etc.)
2. `tool_use_id` -- correlates PreToolUse and PostToolUse for the same call
3. `context` -- AbortSignal (TypeScript) or reserved (Python)

Hooks can return:
- `{}` -- allow the operation without changes
- `{ hookSpecificOutput: { permissionDecision: "deny", ... } }` -- block a tool call
- `{ hookSpecificOutput: { updatedInput: {...}, permissionDecision: "allow" } }` -- modify tool input
- `{ systemMessage: "..." }` -- inject context into the conversation
- `{ async_: True }` -- fire-and-forget for side effects

Multiple hooks execute in order and follow priority: deny > ask > allow.

#### Session Management via SDK

```python
# Capture session ID
session_id = None
async for message in query(prompt="Read the auth module", options=ClaudeAgentOptions(allowed_tools=["Read"])):
    if hasattr(message, "subtype") and message.subtype == "init":
        session_id = message.session_id

# Resume later
async for message in query(prompt="Continue", options=ClaudeAgentOptions(resume=session_id)):
    print(message)

# Fork instead of continuing
async for message in query(prompt="Try different approach", options=ClaudeAgentOptions(resume=session_id, fork_session=True)):
    print(message)
```

Forking creates a new session that branches from the resume point while preserving the original session unchanged.

#### Subagent Support

The SDK supports spawning specialized subagents via the `Task` tool:
```python
options = ClaudeAgentOptions(
    allowed_tools=["Read", "Glob", "Grep", "Task"],
    agents={
        "code-reviewer": AgentDefinition(
            description="Expert code reviewer",
            prompt="Analyze code quality and suggest improvements.",
            tools=["Read", "Glob", "Grep"],
        )
    },
)
```

Messages from subagents include a `parent_tool_use_id` field for tracking which messages belong to which subagent execution.


### 3. WebSocket Bridge Patterns

**Confidence: MEDIUM** -- Multiple reference implementations exist, but no single dominant pattern has emerged.

#### CLI-to-WebSocket Bridge

The simplest pattern spawns the CLI with `--output-format stream-json` and forwards each NDJSON line as a WebSocket message. This is what `claude-code-webui` does: Deno/Node.js backend spawns the CLI, captures stdout via child process stdio pipes, and streams results to a React frontend.

A more robust implementation is `claude-agent-server` by dzhng, which uses the Agent SDK (not raw CLI) and exposes a WebSocket interface:

**Message types (client to server):**
- `user_message` -- wrapped SDKUserMessage with role, content, and session ID
- `interrupt` -- stops current agent operation

**Message types (server to client):**
- `connected` -- initial handshake confirmation
- `sdk_message` -- agent responses (thoughts, tool results, completions)
- `error` -- operation failures

Architecture: Bun-based HTTP/WebSocket server wrapping the Agent SDK, deployable as an E2B sandbox. The client library (`@dzhng/claude-agent`) handles connection management.

#### SDK-to-WebSocket Bridge

The SDK's async iterator maps naturally to WebSocket events:

```typescript
// Pseudocode for SDK-to-WebSocket bridge
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    const { prompt, sessionId } = JSON.parse(data);
    for await (const message of query({
      prompt,
      options: { resume: sessionId, includePartialMessages: true }
    })) {
      ws.send(JSON.stringify(message));
    }
  });
});
```

#### Message Format Design

Based on the patterns observed across projects, a well-designed agent-to-frontend protocol should include:

1. **Session lifecycle events**: `session.started`, `session.resumed`, `session.ended`
2. **Streaming text**: `text.delta` (partial), `text.complete` (full block)
3. **Tool activity**: `tool.started`, `tool.progress`, `tool.completed`, `tool.failed`
4. **Agent status**: `agent.thinking`, `agent.idle`, `agent.error`
5. **Metadata**: `cost.update`, `usage.update`

The `cc-connect` project takes a different approach, bridging Claude Code to messaging platforms (Slack, Telegram, Discord, etc.) using Go interfaces for full pluggability.

#### Existing Libraries

- **claude-agent-server** (526 GitHub stars) -- WebSocket + E2B sandbox, Bun-based
- **cc-connect** -- Bridge to messaging platforms via Go interfaces
- **claude-flow / ruflo** -- Multi-agent orchestration with WebSocket server support
- **AI Coding Agent Dashboard** (blog.marcnuri.com) -- WebSocket relay between browser and remote terminal, with enricher pattern for processing hook data


### 4. HTTP Server Patterns

**Confidence: HIGH** -- Well-established patterns from both community projects and official documentation.

#### FastAPI Server Pattern

The `claude-code-openai-wrapper` project demonstrates a production-quality FastAPI server fronting the Claude Agent SDK:

**Tech stack**: FastAPI + Uvicorn (ASGI) + Pydantic + Claude Agent SDK v0.1.18

**Endpoints**:
- `POST /v1/chat/completions` -- OpenAI-compatible chat completions
- `POST /v1/messages` -- Anthropic native messages endpoint
- `GET /v1/models` -- list available models
- `GET /sessions` -- list active sessions
- `DELETE /sessions/{id}` -- clear a session
- `GET /health` -- health check

**Streaming**: SSE (Server-Sent Events) for streaming responses, compatible with OpenAI SDK streaming format.

**Session management**: Stateful sessions with conversation history maintained across requests. Session IDs enable tracking multiple independent conversations.

**Authentication**: Optional API key protection with auto-generated tokens. Per-IP rate limiting using a fixed-window algorithm (chat: 10/min, debug: 2/min, health: 30/min).

**Performance**: Tools disabled by default for 5-10x speed improvement (no filesystem access needed for simple chat). Configurable timeout (default 300s).

#### Express / Node.js Server Pattern

The `claude-agent-server` project uses a Bun-based HTTP server with REST configuration endpoints alongside its WebSocket interface:

- `POST /config` -- update agent configuration (system prompt, allowed tools, model, custom agents)
- `GET /config` -- retrieve current settings

#### SSE vs WebSocket for Streaming

Based on current research and community consensus:

| Dimension | SSE | WebSocket |
|-----------|-----|-----------|
| **Direction** | Server-to-client only | Full duplex |
| **Complexity** | Low (standard HTTP) | Higher (connection lifecycle management) |
| **Auto-reconnect** | Built-in browser support | Must implement manually |
| **Data format** | Text only | Text + binary |
| **HTTP/2 compatibility** | Excellent (multiplexed) | Requires upgrade |
| **Scalability** | Better with existing HTTP infra | Requires sticky sessions |
| **Latency** | ~3ms slower than WebSocket | Slightly lower |
| **AI agent fit** | Good for token streaming | Better for multi-turn interactive agents |

**Recommendation for agent harness**: Use SSE for simple streaming UIs (one-shot prompt -> streamed response). Use WebSocket for multi-turn interactive sessions where the client needs to send interrupts, follow-up messages, or control signals during streaming.

For a hybrid approach: use REST endpoints for session management (create, list, delete) and SSE or WebSocket for the actual streaming conversation.

#### Authentication and Authorization

Anthropic explicitly prohibits third-party developers from offering claude.ai login or rate limits for their products. All harnesses must use API key authentication. Approaches seen in the wild:

1. **API key passthrough**: Client provides their own Anthropic API key, harness forwards it
2. **Server-side API key**: Harness owns the API key, requires its own auth layer (JWT, API tokens)
3. **Provider flexibility**: Support multiple backends (Anthropic direct, AWS Bedrock, Google Vertex AI, Azure AI Foundry)

The `claude-code-openai-wrapper` generates a random API token on first run and requires it on all requests, plus per-IP rate limiting.


### 5. Concurrent Session Management

**Confidence: MEDIUM-HIGH** -- Well-documented constraints exist, but real-world patterns for large-scale concurrent management are still emerging.

#### Running Multiple Agents

Claude Code supports multiple concurrent sessions through several mechanisms:

1. **Agent Teams** (experimental) -- built-in multi-agent coordination with a team lead, shared task list, and inter-agent messaging. Currently disabled by default; enable via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Supports 3-5 teammates as the recommended range, with each teammate being a full independent Claude Code instance.

2. **Subagents** -- lighter-weight agents spawned within a single session via the `Task` tool. Results are summarized back to the main context. Lower token cost than agent teams but no inter-agent communication.

3. **Git Worktrees** -- manual parallel sessions using `git worktree` to isolate filesystem state. Each session operates in its own worktree to prevent file conflicts.

4. **Independent Processes** -- simply spawn multiple `claude` processes with separate session IDs and working directories.

#### Resource Constraints and Limits

- **API rate limits**: Applied per-model; using different models allows concurrent usage up to each model's limit. Free tier: 5 concurrent agents triggers immediate Error 429.
- **Usage framework**: 5-hour rolling window for burst activity + 7-day weekly ceiling for total active compute hours.
- **Memory**: 400MB-4GB per instance means a machine with 32GB RAM can realistically run 8-16 concurrent agents.
- **CPU**: Each instance can spike to 100% during processing; budget 1 CPU core per agent.
- **Tokens**: Token costs scale linearly with number of agents. Agent teams are especially expensive since each teammate has its own full context window.

#### Session Isolation

Critical isolation concerns:

1. **Filesystem**: Agents working in the same directory will overwrite each other's files. Use separate working directories, git worktrees, or container-level isolation.
2. **Environment variables**: The `CLAUDECODE=1` env var is inherited by child processes and must be explicitly unset for nested SDK usage (GitHub #573).
3. **Global config**: All agents read from `~/.claude/settings.json` and `~/CLAUDE.md`. The 4-layer isolation technique (see below) prevents unwanted config inheritance.
4. **Session storage**: Sessions are stored in `~/.claude/projects/<project-hash>/<session-id>/`, namespaced by both project path and session ID, so they don't interfere.

#### The 4-Layer Isolation Technique

To prevent subprocess token waste from global config re-injection:

1. **Layer 1 -- Scoped Working Directory**: Set cwd to an isolated workspace (not home directory) to prevent loading `~/CLAUDE.md`.
2. **Layer 2 -- Git Boundary**: Create a `.git/HEAD` file in the workspace. Claude Code respects git boundaries and stops upward directory traversal.
3. **Layer 3 -- Empty Plugin Directory**: Point `--plugin-dir` to an empty directory to block global plugin injection.
4. **Layer 4 -- Setting Sources Restriction**: Use `--setting-sources project,local` to exclude user-level settings.

Result: 10x token reduction (50K -> 5K per subprocess turn).

#### Queue Management for Rate Limiting

Community patterns for rate limiting concurrent agents:

- **Token bucket algorithm**: Allows bursts while maintaining sustained rate limits
- **Exponential backoff**: Retries on 429 errors with increasing delays
- **Process pooling**: Maintain a pool of long-lived worker processes for reuse instead of spawning fresh subprocesses
- **Per-endpoint rate limiting**: Different limits for different operation types (e.g., chat vs health check)


### 6. Session Persistence

**Confidence: HIGH** -- Well-documented in official sources and confirmed by community analysis.

#### Storage Location and Structure

Claude Code stores all session data under `~/.claude/`:

```
~/.claude/
  projects/
    -home-user-myapp-/          # Path-encoded project directory
      <session-id>/
        metadata.json           # Session metadata
        messages.jsonl          # Conversation history (JSON Lines format)
        context.json            # Context window state
        tasks.json              # Background tasks state
        session-memory/
          summary.md            # Session memory summary
  teams/
    {team-name}/
      config.json               # Agent team configuration
  tasks/
    {team-name}/                # Shared task list for agent teams
  settings.json                 # User settings (global)
  settings.local.json           # Local settings
```

Path encoding: directory separators (`/`) are replaced with hyphens (`-`), so `/home/user/myapp` becomes `-home-user-myapp-`.

#### What Survives Process Restarts

Claude Code writes interaction data to disk as soon as it is created. Each event is appended as a new JSONL entry, so if the process crashes or is closed unexpectedly, almost everything is preserved. Specifically:

- **Survives**: Full message history, tool outputs, assistant responses, session metadata
- **May not survive**: In-flight tool executions that haven't completed, any buffered data not yet flushed
- **Known issue**: In some cases, the session storage directory is never created (GitHub #27463), leading to complete session loss

#### Resuming After Crash

```bash
# Resume the most recent session
claude --continue

# Resume a specific session by ID
claude --resume "abc123"
```

When resuming, the entire message history is restored -- not a summary or reconstruction. Messages, tool outputs, and all context are exactly as they were.

Via the SDK:
```python
async for message in query(
    prompt="Continue where we left off",
    options=ClaudeAgentOptions(resume="abc123"),
):
    print(message)
```

#### Session Forking

The SDK supports forking sessions to explore different approaches from the same starting point:

| Behavior | `fork_session=False` (default) | `fork_session=True` |
|----------|-------------------------------|---------------------|
| Session ID | Same as original | New ID generated |
| History | Appends to original | Creates new branch |
| Original | Modified | Preserved unchanged |

#### Conversation History in Agent Teams

Agent team data is stored at `~/.claude/teams/{team-name}/config.json` with a `members` array containing each teammate's name, agent ID, and type. However, agent teams have a known limitation: `/resume` and `/rewind` do not restore in-process teammates after a session ends.

#### External Persistence Strategies

For production harnesses that need persistence beyond the default filesystem storage:

1. **Database-backed sessions**: Copy JSONL files to a database after each turn, restore on resume
2. **Hybrid sessions**: Use SDK session resumption combined with database storage for metadata
3. **Depot integration**: Services like Depot (depot.dev) offer managed Claude Code session hosting with built-in persistence


### 7. Open-Source Projects & Community Patterns

**Confidence: HIGH** -- Multiple active projects verified on GitHub with substantial community adoption.

#### claude-agent-server (dzhng)
- **URL**: https://github.com/dzhng/claude-agent-server
- **Stars**: 526, Forks: 54
- **Approach**: SDK wrapper with WebSocket interface
- **Stack**: Bun, TypeScript, E2B sandbox
- **Key insight**: Clean separation of concerns -- REST for config, WebSocket for real-time agent communication
- **Session management**: Multiple concurrent sessions identified by ID
- **Deployment**: E2B sandbox template for production, local mode for development

#### claude-code-openai-wrapper (RichardAtCT)
- **URL**: https://github.com/RichardAtCT/claude-code-openai-wrapper
- **Approach**: OpenAI API-compatible REST server over Agent SDK
- **Stack**: Python, FastAPI, Uvicorn, Claude Agent SDK
- **Key insight**: Drop-in replacement for OpenAI API clients; supports both `/v1/chat/completions` and `/v1/messages`
- **Features**: Session continuity, rate limiting, Docker deployment, cost tracking from SDK metadata
- **Performance**: Tools disabled by default for 5-10x speed; optional enablement via request parameter

#### claude-code-webui (sugyan)
- **URL**: https://github.com/sugyan/claude-code-webui
- **Approach**: CLI subprocess wrapper with web frontend
- **Stack**: Deno/Node.js backend, React + Vite frontend, Primer React UI
- **Key insight**: Simplest viable architecture -- spawn CLI, capture stdio, stream to browser
- **Features**: Granular permission controls, project picker, dark/light theme

#### opcode (winfunc)
- **URL**: https://github.com/winfunc/opcode
- **Approach**: Desktop GUI application
- **Stack**: Tauri 2 (Rust backend + React frontend)
- **Key insight**: Native desktop integration with checkpoint/timeline management and process management at the OS level
- **Features**: Custom agent creation, session management, usage tracking, background agents

#### ruflo / claude-flow (ruvnet)
- **URL**: https://github.com/ruvnet/ruflo
- **Approach**: Multi-agent orchestration platform
- **Features**: Stream-JSON chaining, distributed swarm intelligence, RAG integration, WebSocket server
- **Key insight**: Advanced stream chaining patterns for multi-agent workflows

#### claude-code-acp
- **URL**: https://pypi.org/project/claude-code-acp/
- **Approach**: ACP (Agent Communication Protocol) client
- **Key insight**: Subprocess communication via stdio using a standardized agent communication protocol

#### cc-connect (chenhg5)
- **URL**: https://github.com/chenhg5/cc-connect
- **Approach**: Bridge to messaging platforms (Slack, Telegram, Discord, Feishu, etc.)
- **Stack**: Go
- **Key insight**: Decoupled architecture via Go interfaces; no public IP required for most platforms

#### claude-code-hooks-multi-agent-observability (disler)
- **URL**: https://github.com/disler/claude-code-hooks-multi-agent-observability
- **Approach**: Real-time monitoring for Claude Code agents through hook event tracking
- **Key insight**: Hooks as an observability primitive for agent harnesses

#### Community Patterns and Conventions

Based on analysis of these projects, several consistent patterns emerge:

1. **SDK over subprocess**: Projects started with subprocess spawning are migrating to the Agent SDK as it has stabilized
2. **NDJSON as interchange format**: Both the CLI and SDK use newline-delimited JSON for streaming, making it the natural wire format
3. **Session ID as correlation key**: All architectures use the session ID returned in the init event as the primary key for routing and persistence
4. **Hooks for extensibility**: The hook system is used for logging, security, rate limiting, and notification forwarding
5. **Container isolation for production**: E2B, Modal, Fly.io, and Vercel Sandbox are the preferred hosting environments


## Architecture Comparison Table

| Dimension | CLI Subprocess | Agent SDK | Hybrid (SDK + WebSocket) |
|-----------|---------------|-----------|--------------------------|
| **Complexity** | Low | Medium | Medium-High |
| **Setup time** | Minutes | Hours | Days |
| **Streaming** | NDJSON via stdout | Async iterators with typed events | WebSocket/SSE wrapping SDK events |
| **Session management** | Manual (--resume, --continue) | Native (resume, fork_session) | SDK session + external state store |
| **Error recovery** | Process exit codes + manual restart | Structured error types in ResultMessage | Automatic reconnection + retry |
| **Type safety** | None (raw JSON) | Full TypeScript/Python types | Full types at SDK layer |
| **Hook support** | Shell command hooks only | Callback hooks (10-18 event types) | Full hook support + custom middleware |
| **Concurrent sessions** | Manual process management | Built-in subagents + agent teams | Session routing layer + SDK |
| **Token efficiency** | Poor without isolation (50K/turn) | Better (SDK manages config) | Best with 4-layer isolation |
| **Frontend integration** | Requires bridge layer | Requires bridge layer | Native WebSocket/SSE |
| **Production readiness** | CI/CD and scripts | Production applications | Production multi-user systems |
| **MCP support** | Via CLI flags | Native mcpServers option | Full MCP via SDK |
| **Maintenance** | Low (CLI is stable) | Medium (SDK versioned with semver) | Higher (more moving parts) |
| **Memory per instance** | 400MB-4GB | 400MB-4GB (same underlying process) | 400MB-4GB + server overhead |
| **Best use case** | CI/CD, scripts, one-off tasks | Single-user applications, backends | Multi-user platforms, dashboards |


## Sources

1. [Run Claude Code Programmatically -- Official Docs](https://code.claude.com/docs/en/headless)
2. [Agent SDK Overview -- Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/overview)
3. [Stream Responses in Real-Time -- Agent SDK Docs](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
4. [Session Management -- Agent SDK Docs](https://platform.claude.com/docs/en/agent-sdk/sessions)
5. [Intercept and Control Agent Behavior with Hooks -- Agent SDK Docs](https://platform.claude.com/docs/en/agent-sdk/hooks)
6. [Hosting the Agent SDK -- Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/hosting)
7. [Orchestrate Teams of Claude Code Sessions -- Claude Code Docs](https://code.claude.com/docs/en/agent-teams)
8. [Agent SDK Reference -- Python](https://platform.claude.com/docs/en/agent-sdk/python)
9. [Agent SDK Reference -- TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript)
10. [Building a 24/7 Claude Code Wrapper -- Token Burn Analysis (DEV Community)](https://dev.to/jungjaehoon/why-claude-code-subagents-waste-50k-tokens-per-turn-and-how-to-fix-it-41ma)
11. [claude-agent-server (GitHub -- dzhng)](https://github.com/dzhng/claude-agent-server)
12. [claude-code-openai-wrapper (GitHub -- RichardAtCT)](https://github.com/RichardAtCT/claude-code-openai-wrapper)
13. [claude-code-webui (GitHub -- sugyan)](https://github.com/sugyan/claude-code-webui)
14. [opcode -- GUI Toolkit for Claude Code (GitHub -- winfunc)](https://github.com/winfunc/opcode)
15. [ruflo / claude-flow (GitHub -- ruvnet)](https://github.com/ruvnet/ruflo)
16. [cc-connect -- Bridge to Messaging Platforms (GitHub -- chenhg5)](https://github.com/chenhg5/cc-connect)
17. [claude-code-hooks-multi-agent-observability (GitHub -- disler)](https://github.com/disler/claude-code-hooks-multi-agent-observability)
18. [@anthropic-ai/claude-agent-sdk -- npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
19. [claude-agent-sdk -- PyPI](https://pypi.org/project/claude-agent-sdk/)
20. [Claude Code Session State Management -- Internals Analysis](https://kotrotsos.medium.com/claude-code-internals-part-6-session-state-management-e729f49c8bb9)
21. [How Claude Code Manages Local Storage -- Milvus Blog](https://milvus.io/blog/why-claude-code-feels-so-stable-a-developers-deep-dive-into-its-local-storage-design.md)
22. [Claude Code Rate Limits -- ClaudeLog](https://claudelog.com/claude-code-limits/)
23. [Anthropic Rate Limits -- API Docs](https://platform.claude.com/docs/en/api/rate-limits)
24. [Concurrent Session Blocking -- GitHub Issue #13352](https://github.com/anthropics/claude-code/issues/13352)
25. [Session Freezes with Multiple Background Agents -- GitHub Issue #17540](https://github.com/anthropics/claude-code/issues/17540)
26. [CLAUDECODE=1 Environment Variable Bug -- GitHub Issue #573](https://github.com/anthropics/claude-agent-sdk-python/issues/573)
27. [Session Storage Directory Not Created -- GitHub Issue #27463](https://github.com/anthropics/claude-code/issues/27463)
28. [Stream-JSON Chaining -- claude-flow Wiki](https://github.com/ruvnet/claude-flow/wiki/Stream-Chaining)
29. [SSE vs WebSocket for AI Agent Streaming -- Medium Analysis](https://medium.com/@pranavprakash4777/streaming-ai-responses-with-websockets-sse-and-grpc-which-one-wins-a481cab403d3)
30. [AI Agent Chat: Choosing Between WebSockets and SSE](https://www.karls.io/ai-agent-progress-chat-websocket-server-sent-events/)
31. [Securely Deploying AI Agents -- Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/secure-deployment)
32. [Multi-Agent Rate Limits Playbook](https://claudecodeplugins.io/playbooks/01-multi-agent-rate-limits/)
33. [A Practical Guide to the Python Claude Code SDK](https://www.eesel.ai/blog/python-claude-code-sdk)
34. [The Definitive Guide to the Claude Agent SDK (Medium)](https://datapoetica.medium.com/the-definitive-guide-to-the-claude-agent-sdk-building-the-next-generation-of-ai-69fda0a0530f)


## Implications

### Recommended Approach for Our Use Case

Based on the research, the recommended architecture for a lightweight agent harness is a **hybrid approach**: use the **Claude Agent SDK (Python)** as the core engine, with a **FastAPI server** providing HTTP/SSE endpoints for session management and streaming.

**Why this stack:**

1. **Agent SDK over raw subprocess**: The SDK handles all the complexity of process management, event parsing, session resumption, and error recovery. It provides typed events, hook callbacks, and native session forking. Building on raw subprocess would mean reimplementing all of this.

2. **Python over TypeScript**: While the TypeScript SDK has more hook events, Python's ecosystem is better suited for our backend needs (FastAPI, async/await, scientific computing integration). The Python SDK covers all essential hook events.

3. **FastAPI over Express**: FastAPI provides native async support, automatic OpenAPI docs, Pydantic validation, and excellent SSE/WebSocket support. The `claude-code-openai-wrapper` project validates this choice.

4. **SSE for streaming, REST for management**: Use REST endpoints for session CRUD operations and SSE for streaming agent responses. Add WebSocket only if bidirectional real-time communication (interrupts, live control) is needed.

5. **4-layer isolation for subprocesses**: If spawning multiple agents, implement the 4-layer isolation technique to prevent 50K token waste per turn.

**Minimal viable architecture:**

```
[Frontend] <-- SSE/REST --> [FastAPI Server] <-- async iterator --> [Claude Agent SDK] <-- subprocess --> [Claude CLI]
```

**Endpoints:**
- `POST /sessions` -- create a new session
- `GET /sessions` -- list active sessions
- `POST /sessions/{id}/messages` -- send a message (SSE response with streaming)
- `GET /sessions/{id}/history` -- get conversation history
- `DELETE /sessions/{id}` -- end a session
- `POST /sessions/{id}/resume` -- resume a session
- `POST /sessions/{id}/fork` -- fork a session

### Production Deployment

For production, run the Agent SDK inside a sandboxed container (E2B, Modal, Fly.io, or Docker with gVisor). Anthropic recommends 1 GiB RAM, 5 GiB disk, and 1 CPU per instance as a baseline, though real-world usage may require 2-4 GiB RAM.

The dominant cost is tokens (not compute). Container hosting adds roughly 5 cents per hour, while token costs scale with agent complexity and conversation length.


## Open Questions

1. **SDK stability and versioning**: The Agent SDK is relatively new and actively evolving (renamed from "Claude Code SDK" to "Claude Agent SDK"). Breaking changes are versioned with semver, but the API surface may shift. How tightly should we couple to SDK internals vs abstracting behind our own interface layer?

2. **Session storage durability**: The known bug where session storage directories are sometimes not created (GitHub #27463) is concerning for production use. Should we implement our own persistence layer on top of the SDK's, or wait for this to be fixed?

3. **Agent Teams viability**: Agent Teams are experimental and have known limitations (no session resumption, task status lag, one team per session). Should we build our own multi-agent coordination on top of subagents instead?

4. **Token cost modeling**: With the 4-layer isolation technique, a subprocess turn drops from ~50K to ~5K tokens overhead. But how does this scale with 10-50 concurrent agents? What is the realistic monthly cost for a moderate-scale deployment?

5. **Hook latency impact**: Synchronous hooks that make HTTP requests (e.g., for audit logging) block the agent. The async hook option avoids this but cannot influence behavior. What is the measured latency impact of synchronous hooks in a production scenario?

6. **WebSocket vs SSE decision**: For our specific use case (agent dashboard with live streaming), do we need the full duplex capability of WebSockets, or is SSE sufficient with REST for the client-to-server direction? The answer depends on whether we need real-time interrupts and control signals during streaming.

7. **Container warm pool sizing**: For the hybrid session pattern (ephemeral containers hydrated with state), how many warm containers should be maintained? What is the cold-start latency for spinning up a new Agent SDK instance?

8. **Extended thinking compatibility**: The SDK's streaming mode is incompatible with explicit `max_thinking_tokens` settings. If we need extended thinking for complex tasks, we cannot stream those responses. Is there a workaround, or should we design the UI to handle non-streaming responses gracefully?

9. **MCP server lifecycle**: When running MCP servers alongside the Agent SDK, who manages their lifecycle? Does the SDK start/stop them, or does the harness need to manage them separately? What happens to MCP connections during session resumption?

10. **Prototype needed**: The `claude-code-openai-wrapper` project is the closest existing reference to our needs. Should we fork it and extend, or build from scratch using the patterns documented here? A spike prototype comparing both approaches would answer this definitively.
