# Claude Agent SDK (TypeScript) — Deep Implementation Guide
*Generated: 2026-03-02*

## Summary

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, v0.2.63) is Anthropic's official TypeScript library for building production AI agents with the same capabilities that power Claude Code. It wraps the Claude Code CLI as a subprocess, providing a typed async generator interface over a streaming JSON protocol. The SDK supports OAuth token authentication (subscription billing), 18 hook event types for intercepting agent behavior, custom tools via in-process MCP servers, programmatic subagents, session management with resume/fork, and real-time streaming events. It runs on Node.js 18+ and Bun (with one known bundling caveat). A V2 preview interface simplifies multi-turn conversations with `send()`/`stream()` patterns.

---

## Findings

### 1. Package & Setup

#### Installation and Version

```bash
npm install @anthropic-ai/claude-agent-sdk
# or
bun add @anthropic-ai/claude-agent-sdk
```

- **Current version**: 0.2.63 (released Feb 28, 2026)
- **Package name**: `@anthropic-ai/claude-agent-sdk` (renamed from `@anthropic-ai/claude-code`)
- **Repository**: https://github.com/anthropics/claude-agent-sdk-typescript
- **License**: Anthropic Commercial Terms of Service

#### Authentication

**API Key (standard)**:
```bash
export ANTHROPIC_API_KEY=your-api-key
```

**OAuth Token (subscription billing)**:
```bash
claude setup-token  # Browser auth flow
# Sets CLAUDE_CODE_OAUTH_TOKEN automatically
```

The SDK wraps the CLI process, so it inherits whatever auth the CLI has. OAuth works because the underlying Claude Code binary handles the token. This means subscription quota (Pro/Max plans) can be used instead of pay-per-token API billing.

> **Important**: Anthropic's official docs state that unless previously approved, third-party developers should not offer claude.ai login or rate limits for their products. OAuth is suitable for first-party/personal use.

**Third-party providers** are also supported:
- Amazon Bedrock: `CLAUDE_CODE_USE_BEDROCK=1`
- Google Vertex AI: `CLAUDE_CODE_USE_VERTEX=1`
- Microsoft Azure: `CLAUDE_CODE_USE_FOUNDRY=1`

#### Bun Runtime Compatibility

The SDK supports Bun as a runtime via the `executable` option:

```typescript
options: {
  executable: 'bun'  // Also: 'node' (default), 'deno'
}
```

**Known issue**: When bundling with `bun build`, the SDK fails to locate the Claude CLI binary at runtime because it uses `import.meta.url` for path resolution, which breaks during bundling (GitHub issue #150). **Workaround**: Run with `bun run` (unbundled) rather than `bun build`.

Anthropic acquired Bun (the company), and Claude Code itself runs on Bun internally. The SDK auto-detects the runtime.

#### Minimum System Requirements

- Node.js 18+ or Bun runtime
- Claude Code CLI installed (bundled with the SDK package)
- Valid authentication (API key, OAuth token, or cloud provider credentials)

#### How the SDK Works Internally

The SDK spawns a Claude Code subprocess and communicates via JSON over stdin/stdout. The `query()` function creates an async generator that yields typed `SDKMessage` objects as they arrive from the subprocess. You can override the subprocess spawn behavior with the `spawnClaudeCodeProcess` option for running in VMs, containers, or remote environments.

---

### 2. Core API — `query()` Function

#### Full Signature

```typescript
function query({
  prompt,
  options
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

- **`prompt`**: Either a simple string (one-shot) or an async iterable of `SDKUserMessage` objects (streaming/multi-turn mode).
- **`options`**: Configuration object (see below).
- **Returns**: A `Query` object extending `AsyncGenerator<SDKMessage, void>`.

#### Complete Options Type

| Property | Type | Default | Description |
|:---------|:-----|:--------|:------------|
| `abortController` | `AbortController` | `new AbortController()` | Controller for cancelling operations |
| `additionalDirectories` | `string[]` | `[]` | Additional directories Claude can access |
| `agent` | `string` | `undefined` | Agent name for the main thread |
| `agents` | `Record<string, AgentDefinition>` | `undefined` | Programmatically define subagents |
| `allowDangerouslySkipPermissions` | `boolean` | `false` | Required when using `bypassPermissions` mode |
| `allowedTools` | `string[]` | All tools | List of allowed tool names |
| `betas` | `SdkBeta[]` | `[]` | Enable beta features |
| `canUseTool` | `CanUseTool` | `undefined` | Custom permission function |
| `continue` | `boolean` | `false` | Continue the most recent conversation |
| `cwd` | `string` | `process.cwd()` | Current working directory |
| `debug` | `boolean` | `false` | Enable debug mode |
| `debugFile` | `string` | `undefined` | Write debug logs to file |
| `disallowedTools` | `string[]` | `[]` | Disallowed tool names |
| `effort` | `'low' \| 'medium' \| 'high' \| 'max'` | `'high'` | Reasoning effort level |
| `enableFileCheckpointing` | `boolean` | `false` | Enable file change tracking for rewinding |
| `env` | `Record<string, string \| undefined>` | `process.env` | Environment variables |
| `executable` | `'bun' \| 'deno' \| 'node'` | Auto-detected | JavaScript runtime |
| `executableArgs` | `string[]` | `[]` | Args to pass to the executable |
| `extraArgs` | `Record<string, string \| null>` | `{}` | Additional arguments |
| `fallbackModel` | `string` | `undefined` | Model to use if primary fails |
| `forkSession` | `boolean` | `false` | Fork to new session ID on resume |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | `{}` | Hook callbacks for events |
| `includePartialMessages` | `boolean` | `false` | Include streaming partial messages |
| `maxBudgetUsd` | `number` | `undefined` | Maximum budget in USD |
| `maxThinkingTokens` | `number` | `undefined` | *(Deprecated)* Use `thinking` instead |
| `maxTurns` | `number` | `undefined` | Maximum conversation turns |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | MCP server configurations |
| `model` | `string` | Default from CLI | Claude model to use |
| `outputFormat` | `{ type: 'json_schema', schema: JSONSchema }` | `undefined` | Structured output schema |
| `pathToClaudeCodeExecutable` | `string` | Bundled | Custom path to CLI |
| `permissionMode` | `PermissionMode` | `'default'` | Permission handling mode |
| `permissionPromptToolName` | `string` | `undefined` | MCP tool name for permission prompts |
| `persistSession` | `boolean` | `true` | Persist session to disk |
| `plugins` | `SdkPluginConfig[]` | `[]` | Local plugins to load |
| `promptSuggestions` | `boolean` | `false` | Emit predicted next prompts |
| `resume` | `string` | `undefined` | Session ID to resume |
| `resumeSessionAt` | `string` | `undefined` | Resume at specific message UUID |
| `sandbox` | `SandboxSettings` | `undefined` | Sandbox behavior config |
| `sessionId` | `string` | Auto-generated | Use specific UUID for session |
| `settingSources` | `SettingSource[]` | `[]` | Which filesystem settings to load |
| `spawnClaudeCodeProcess` | `(options: SpawnOptions) => SpawnedProcess` | `undefined` | Custom process spawn function |
| `stderr` | `(data: string) => void` | `undefined` | Callback for stderr |
| `strictMcpConfig` | `boolean` | `false` | Enforce strict MCP validation |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | `undefined` | System prompt configuration |
| `thinking` | `ThinkingConfig` | `{ type: 'adaptive' }` | Controls reasoning behavior |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | `undefined` | Tool configuration |

#### Query Object Methods

The `Query` object extends `AsyncGenerator<SDKMessage, void>` with these methods:

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  accountInfo(): Promise<AccountInfo>;
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  close(): void;
}
```

Key methods:
- **`setMcpServers()`** — Dynamically replace MCP servers mid-session
- **`toggleMcpServer()`** — Enable/disable individual MCP servers mid-session
- **`rewindFiles()`** — Restore files to state at a specific message (requires `enableFileCheckpointing`)
- **`streamInput()`** — Feed multi-turn messages into an active query
- **`close()`** — Forcefully terminate the query and clean up

#### All Message Types

```typescript
type SDKMessage =
  | SDKAssistantMessage       // Complete assistant response
  | SDKUserMessage            // User input
  | SDKUserMessageReplay      // Replayed user message (with isReplay: true)
  | SDKResultMessage          // Final result (success or error)
  | SDKSystemMessage          // System init message
  | SDKPartialAssistantMessage // Streaming event (when includePartialMessages: true)
  | SDKCompactBoundaryMessage // Conversation compaction boundary
  | SDKStatusMessage          // Status updates
  | SDKHookStartedMessage     // Hook execution started
  | SDKHookProgressMessage    // Hook execution progress
  | SDKHookResponseMessage    // Hook execution response
  | SDKToolProgressMessage    // Tool execution progress
  | SDKAuthStatusMessage      // Authentication status
  | SDKTaskNotificationMessage // Background task notification
  | SDKTaskStartedMessage     // Background task started
  | SDKTaskProgressMessage    // Background task progress
  | SDKFilesPersistedEvent    // File persistence event
  | SDKToolUseSummaryMessage  // Tool use summary
  | SDKRateLimitEvent         // Rate limit encountered
  | SDKPromptSuggestionMessage; // Predicted next prompt
```

**SDKSystemMessage** (init, always first message):
```typescript
type SDKSystemMessage = {
  type: "system";
  subtype: "init";
  uuid: UUID;
  session_id: string;        // <-- Capture this for resume
  agents?: string[];
  apiKeySource: ApiKeySource;
  betas?: string[];
  claude_code_version: string;
  cwd: string;
  tools: string[];            // All available tools
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
  skills: string[];
  plugins: { name: string; path: string }[];
};
```

**SDKAssistantMessage**:
```typescript
type SDKAssistantMessage = {
  type: "assistant";
  uuid: UUID;
  session_id: string;
  message: BetaMessage;           // Anthropic SDK type with content, usage, etc.
  parent_tool_use_id: string | null; // Non-null when inside a subagent
  error?: SDKAssistantMessageError;  // 'authentication_failed' | 'billing_error' | 'rate_limit' | etc.
};
```

**SDKResultMessage** (always last message):
```typescript
type SDKResultMessage =
  | {
      type: "result";
      subtype: "success";
      uuid: UUID;
      session_id: string;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;                    // <-- The final text result
      stop_reason: string | null;
      total_cost_usd: number;
      usage: NonNullableUsage;
      modelUsage: { [modelName: string]: ModelUsage };
      permission_denials: SDKPermissionDenial[];
      structured_output?: unknown;
    }
  | {
      type: "result";
      subtype: "error_max_turns" | "error_during_execution"
             | "error_max_budget_usd" | "error_max_structured_output_retries";
      uuid: UUID;
      session_id: string;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      stop_reason: string | null;
      total_cost_usd: number;
      usage: NonNullableUsage;
      modelUsage: { [modelName: string]: ModelUsage };
      permission_denials: SDKPermissionDenial[];
      errors: string[];
    };
```

#### Detecting Completion

```typescript
for await (const message of query({ prompt: "...", options })) {
  if (message.type === "system" && message.subtype === "init") {
    const sessionId = message.session_id;  // Capture session ID
  }

  if (message.type === "result") {
    if (message.subtype === "success") {
      console.log("Result:", message.result);
      console.log("Cost:", message.total_cost_usd);
      console.log("Turns:", message.num_turns);
    } else {
      console.error("Error:", message.subtype, message.errors);
    }
    // This is always the last message
  }
}
```

#### Error Handling

- **Authentication failure**: `SDKAssistantMessage.error === 'authentication_failed'`
- **Rate limit**: `SDKAssistantMessage.error === 'rate_limit'` or `SDKRateLimitEvent` message
- **Billing error**: `SDKAssistantMessage.error === 'billing_error'`
- **Max turns exceeded**: `SDKResultMessage.subtype === 'error_max_turns'`
- **Budget exceeded**: `SDKResultMessage.subtype === 'error_max_budget_usd'`
- **Execution error**: `SDKResultMessage.subtype === 'error_during_execution'`
- **Cancellation**: Use `AbortController` passed via options

---

### 3. All 18 Hook Event Types

#### Hook Event Type Enum

```typescript
type HookEvent =
  | "PreToolUse"        // Tool call about to execute (can block/modify)
  | "PostToolUse"       // Tool execution completed successfully
  | "PostToolUseFailure" // Tool execution failed
  | "UserPromptSubmit"  // User prompt submitted
  | "Stop"              // Agent execution stopping
  | "SubagentStart"     // Subagent initializing
  | "SubagentStop"      // Subagent completed
  | "PreCompact"        // Conversation compaction about to happen
  | "PermissionRequest" // Permission dialog would be shown
  | "Notification"      // Agent status notification
  | "SessionStart"      // Session initialized (TS only)
  | "SessionEnd"        // Session terminated (TS only)
  | "Setup"             // Session setup/maintenance (TS only)
  | "TeammateIdle"      // Teammate becomes idle (TS only)
  | "TaskCompleted"     // Background task completed (TS only)
  | "ConfigChange"      // Config file changed (TS only)
  | "WorktreeCreate"    // Git worktree created (TS only)
  | "WorktreeRemove";   // Git worktree removed (TS only)
```

8 hooks are available in both Python and TypeScript SDKs. 10 are TypeScript-only.

#### Hook Callback Signature

```typescript
type HookCallback = (
  input: HookInput,              // Typed per event type
  toolUseID: string | undefined, // Correlates Pre/PostToolUse for same call
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

#### Hook Matcher Configuration

```typescript
interface HookCallbackMatcher {
  matcher?: string;        // Regex pattern against tool name (or event-specific field)
  hooks: HookCallback[];   // Array of callbacks to execute
  timeout?: number;        // Timeout in seconds (default: 60)
}
```

**Matcher is a regex string**, not glob. Examples:
- `"Bash"` — matches Bash tool only
- `"Write|Edit"` — matches Write or Edit tools
- `"^mcp__"` — matches all MCP tools
- No matcher — matches all events of that type

For tool-based hooks, the matcher tests against the **tool name only**, not file paths or arguments. Filter by file path inside your callback.

#### Hook Registration

```typescript
const options = {
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [myBashHook], timeout: 30 },
      { matcher: "Write|Edit", hooks: [myFileHook] },
      { hooks: [globalLogger] }  // No matcher = all tools
    ],
    PostToolUse: [
      { hooks: [auditLogger] }
    ],
    Stop: [
      { hooks: [cleanupHook] }
    ]
  }
};
```

#### Hook Execution Order and Priority

1. Hooks execute **in array order** within each event type
2. Multiple matchers are checked sequentially
3. **Priority**: `deny` > `ask` > `allow` — if any hook returns `deny`, the operation is blocked regardless of other hooks

#### All 18 Hook Input Types

**BaseHookInput** (shared by all):
```typescript
type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
};
```

| Hook Event | Additional Input Fields | Practical Use Cases |
|:-----------|:----------------------|:-------------------|
| **PreToolUse** | `tool_name: string`, `tool_input: unknown`, `tool_use_id: string` | Block dangerous commands, modify input, auto-approve safe tools |
| **PostToolUse** | `tool_name: string`, `tool_input: unknown`, `tool_response: unknown`, `tool_use_id: string` | Audit logging, add context to results, webhook notifications |
| **PostToolUseFailure** | `tool_name: string`, `tool_input: unknown`, `tool_use_id: string`, `error: string`, `is_interrupt?: boolean` | Error logging, retry logic, alerting |
| **UserPromptSubmit** | `prompt: string` | Inject context, validate/sanitize prompts |
| **Stop** | `stop_hook_active: boolean`, `last_assistant_message?: string` | Save state, cleanup, send notifications |
| **SubagentStart** | `agent_id: string`, `agent_type: string` | Track parallel task spawning, init resources |
| **SubagentStop** | `stop_hook_active: boolean`, `agent_id: string`, `agent_transcript_path: string`, `agent_type: string`, `last_assistant_message?: string` | Aggregate results, cleanup |
| **PreCompact** | `trigger: "manual" \| "auto"`, `custom_instructions: string \| null` | Archive full transcript before summarization |
| **PermissionRequest** | `tool_name: string`, `tool_input: unknown`, `permission_suggestions?: PermissionUpdate[]` | Custom permission handling |
| **Notification** | `message: string`, `title?: string`, `notification_type: string` | Forward to Slack/PagerDuty, log status |
| **SessionStart** | `source: "startup" \| "resume" \| "clear" \| "compact"`, `agent_type?: string`, `model?: string` | Init logging/telemetry |
| **SessionEnd** | `reason: ExitReason` | Clean up temp resources |
| **Setup** | `trigger: "init" \| "maintenance"` | Run initialization tasks |
| **TeammateIdle** | `teammate_name: string`, `team_name: string` | Reassign work |
| **TaskCompleted** | `task_id: string`, `task_subject: string`, `task_description?: string`, `teammate_name?: string`, `team_name?: string` | Aggregate parallel task results |
| **ConfigChange** | `source: "user_settings" \| "project_settings" \| "local_settings" \| "policy_settings" \| "skills"`, `file_path?: string` | Reload settings dynamically |
| **WorktreeCreate** | `name: string` | Track isolated workspaces |
| **WorktreeRemove** | `worktree_path: string` | Clean up workspace resources |

#### Hook Output Types

**Sync output (blocking)**:
```typescript
type SyncHookJSONOutput = {
  continue?: boolean;          // Should the agent keep running?
  suppressOutput?: boolean;    // Suppress this event's output
  stopReason?: string;         // Reason for stopping
  decision?: "approve" | "block";
  systemMessage?: string;      // Inject context into conversation (visible to model)
  reason?: string;
  hookSpecificOutput?:
    | { hookEventName: "PreToolUse";
        permissionDecision?: "allow" | "deny" | "ask";
        permissionDecisionReason?: string;
        updatedInput?: Record<string, unknown>;  // Modify tool input
        additionalContext?: string; }
    | { hookEventName: "PostToolUse";
        additionalContext?: string;
        updatedMCPToolOutput?: unknown; }
    | { hookEventName: "PostToolUseFailure"; additionalContext?: string; }
    | { hookEventName: "UserPromptSubmit"; additionalContext?: string; }
    | { hookEventName: "SessionStart"; additionalContext?: string; }
    | { hookEventName: "Setup"; additionalContext?: string; }
    | { hookEventName: "SubagentStart"; additionalContext?: string; }
    | { hookEventName: "Notification"; additionalContext?: string; }
    | { hookEventName: "PermissionRequest";
        decision: { behavior: "allow"; updatedInput?: Record<string, unknown>;
                     updatedPermissions?: PermissionUpdate[]; }
                 | { behavior: "deny"; message?: string; interrupt?: boolean; }; };
};
```

**Async output (fire-and-forget)**:
```typescript
type AsyncHookJSONOutput = {
  async: true;
  asyncTimeout?: number;  // Optional timeout in ms
};
```

When returning `{ async: true }`, the agent proceeds immediately without waiting. The hook cannot block or modify the operation. Use for logging, metrics, webhooks.

---

### 4. Streaming Events in Detail

#### Enabling Streaming

```typescript
for await (const message of query({
  prompt: "...",
  options: { includePartialMessages: true }
})) {
  // Now receives SDKPartialAssistantMessage in addition to other message types
}
```

#### SDKPartialAssistantMessage Structure

```typescript
type SDKPartialAssistantMessage = {
  type: "stream_event";
  event: BetaRawMessageStreamEvent;  // From @anthropic-ai/sdk
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
};
```

#### Stream Event Types

| Event Type | Description |
|:-----------|:------------|
| `message_start` | Start of a new message |
| `content_block_start` | Start of a content block (text or tool_use) |
| `content_block_delta` | Incremental update (text_delta or input_json_delta) |
| `content_block_stop` | End of a content block |
| `message_delta` | Message-level updates (stop_reason, usage) |
| `message_stop` | End of the message |

#### Message Flow (with streaming)

```
StreamEvent (message_start)
StreamEvent (content_block_start)    — text block
StreamEvent (content_block_delta)    — text chunks...
StreamEvent (content_block_stop)
StreamEvent (content_block_start)    — tool_use block
StreamEvent (content_block_delta)    — tool input JSON chunks...
StreamEvent (content_block_stop)
StreamEvent (message_delta)
StreamEvent (message_stop)
AssistantMessage                     — complete message with all content
... tool executes ...
ResultMessage                        — final result
```

#### Reconstructing Text from Deltas

```typescript
for await (const message of query({
  prompt: "Explain databases",
  options: { includePartialMessages: true }
})) {
  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      process.stdout.write(event.delta.text);  // Print each chunk as it arrives
    }
  }
}
```

#### Detecting Tool Use from Stream Events

```typescript
let currentTool: string | null = null;
let toolInput = "";

for await (const message of query({
  prompt: "Read README.md",
  options: { includePartialMessages: true, allowedTools: ["Read", "Bash"] }
})) {
  if (message.type === "stream_event") {
    const event = message.event;

    if (event.type === "content_block_start") {
      if (event.content_block.type === "tool_use") {
        currentTool = event.content_block.name;
        toolInput = "";
        console.log(`[Tool starting: ${currentTool}]`);
      }
    } else if (event.type === "content_block_delta") {
      if (event.delta.type === "input_json_delta") {
        toolInput += event.delta.partial_json;
      }
    } else if (event.type === "content_block_stop") {
      if (currentTool) {
        console.log(`[Tool ${currentTool} called with: ${toolInput}]`);
        currentTool = null;
      }
    }
  }
}
```

#### Building a Real-Time UI Feed

```typescript
let inTool = false;

for await (const message of query({
  prompt: "Find all TODO comments",
  options: {
    includePartialMessages: true,
    allowedTools: ["Read", "Bash", "Grep"]
  }
})) {
  if (message.type === "stream_event") {
    const event = message.event;

    if (event.type === "content_block_start") {
      if (event.content_block.type === "tool_use") {
        process.stdout.write(`\n[Using ${event.content_block.name}...]`);
        inTool = true;
      }
    } else if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta" && !inTool) {
        process.stdout.write(event.delta.text);  // Stream text when not in tool
      }
    } else if (event.type === "content_block_stop") {
      if (inTool) {
        console.log(" done");
        inTool = false;
      }
    }
  } else if (message.type === "result") {
    console.log("\n--- Complete ---");
  }
}
```

#### Known Streaming Limitations

- **Extended thinking**: When `maxThinkingTokens` is explicitly set, `StreamEvent` messages are NOT emitted. Only complete messages appear.
- **Structured output**: JSON result appears only in `ResultMessage.structured_output`, not as streaming deltas.

---

### 5. Session Management

#### Session Storage

Sessions are stored on disk at `~/.claude/projects/<project-hash>/`. The SDK persists session transcripts as JSON files containing the full conversation history, tool calls, and results.

#### Creating Sessions and Capturing session_id

```typescript
let sessionId: string | undefined;

for await (const message of query({
  prompt: "Help me build a web app",
  options: { model: "claude-opus-4-6" }
})) {
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;
    // Save this for later resumption
  }
}
```

Every message also contains `session_id`, so you can capture it from any message.

#### Resume — Continue a Previous Session

```typescript
const response = query({
  prompt: "Continue where we left off",
  options: {
    resume: sessionId,  // Session ID from previous conversation
  }
});
```

The SDK loads the full conversation history and context. Claude continues exactly where it left off, remembering files read, analysis done, and prior tool results.

#### Fork Session — Branch from a Point

```typescript
const forkedResponse = query({
  prompt: "Let's try a different approach",
  options: {
    resume: sessionId,
    forkSession: true,  // Creates a NEW session ID
  }
});
```

| Behavior | `forkSession: false` (default) | `forkSession: true` |
|:---------|:-------------------------------|:--------------------|
| Session ID | Same as original | New ID generated |
| History | Appends to original | Creates branch from resume point |
| Original session | Modified | Preserved unchanged |

#### Continue — Resume Most Recent Session

```typescript
const response = query({
  prompt: "Continue what you were doing",
  options: {
    continue: true,  // Resume the most recent session for this directory
  }
});
```

#### Resume at Specific Message

```typescript
const response = query({
  prompt: "Try again from this point",
  options: {
    resumeSessionAt: "specific-message-uuid",  // Jump to exact point
  }
});
```

#### Disable Session Persistence

```typescript
const response = query({
  prompt: "One-off query, don't save",
  options: {
    persistSession: false,  // Session cannot be resumed later
  }
});
```

#### Set Custom Session ID

```typescript
const response = query({
  prompt: "...",
  options: {
    sessionId: "my-custom-uuid",  // Use specific UUID instead of auto-generated
  }
});
```

#### List Previous Sessions

```typescript
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

// List sessions for a specific project
const sessions = await listSessions({ dir: "/path/to/project" });
for (const session of sessions) {
  console.log(`${session.summary} (${new Date(session.lastModified).toLocaleDateString()})`);
}

// List all sessions, limited to 10
const recent = await listSessions({ limit: 10 });
```

`SDKSessionInfo` type:
```typescript
type SDKSessionInfo = {
  sessionId: string;
  summary: string;          // Custom title, auto-generated, or first prompt
  lastModified: number;     // ms since epoch
  fileSize: number;         // bytes
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
};
```

#### Can Multiple SDK Instances Share Session State?

Sessions are stored as files on disk. Concurrent writes to the same session would conflict. In practice, only one SDK instance should write to a given session at a time. You can read/list sessions from multiple processes, but concurrent `query()` calls to the same session ID will cause issues.

---

### 6. Subagents

#### Defining Subagents

```typescript
const options = {
  allowedTools: ["Read", "Grep", "Glob", "Task"],  // Task tool REQUIRED
  agents: {
    "code-reviewer": {
      description: "Expert code review specialist. Use for quality, security reviews.",
      prompt: `You are a code review specialist. Identify security vulnerabilities,
performance issues, and suggest improvements.`,
      tools: ["Read", "Grep", "Glob"],  // Read-only
      model: "sonnet",
    },
    "test-runner": {
      description: "Runs and analyzes test suites.",
      prompt: "Run tests and provide clear analysis of results.",
      tools: ["Bash", "Read", "Grep"],  // Can execute commands
    }
  }
};
```

#### AgentDefinition Type

```typescript
type AgentDefinition = {
  description: string;          // REQUIRED: When to use this agent
  prompt: string;               // REQUIRED: System prompt
  tools?: string[];             // Optional: Inherits all if omitted
  disallowedTools?: string[];   // Optional: Explicitly block tools
  model?: "sonnet" | "opus" | "haiku" | "inherit";  // Optional: Defaults to parent model
  mcpServers?: AgentMcpServerSpec[];  // Optional: MCP servers for this agent
  skills?: string[];            // Optional: Preload skill names
  maxTurns?: number;            // Optional: Max API round-trips
  criticalSystemReminder_EXPERIMENTAL?: string;  // Experimental
};
```

#### How Subagents Are Invoked

Claude decides to invoke subagents based on the `description` field, using the **Task tool**. You can also force invocation by naming the agent in your prompt: "Use the code-reviewer agent to..."

The `Task` tool must be in `allowedTools`. Without it, Claude cannot spawn subagents.

#### Task Tool Input Schema

```typescript
type AgentInput = {
  description: string;
  prompt: string;
  subagent_type: string;       // The agent name key
  model?: "sonnet" | "opus" | "haiku";
  resume?: string;
  run_in_background?: boolean;
  max_turns?: number;
  name?: string;
  team_name?: string;
  mode?: "acceptEdits" | "bypassPermissions" | "default" | "dontAsk" | "plan";
  isolation?: "worktree";
};
```

#### Tracking Subagent Messages via parent_tool_use_id

```typescript
for await (const message of query({ prompt: "...", options })) {
  // Check for subagent invocation
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use" && block.name === "Task") {
        console.log(`Subagent invoked: ${block.input.subagent_type}`);
      }
    }
  }

  // Check if message originates from within a subagent
  if ("parent_tool_use_id" in message && message.parent_tool_use_id) {
    console.log("  (from subagent)");
  }
}
```

#### Can Subagents Have Their Own Hooks?

No. Hooks are registered at the top-level `query()` options. However, hooks fire for subagent activity too -- the `SubagentStart` and `SubagentStop` hooks track subagent lifecycle, and `PreToolUse`/`PostToolUse` hooks fire for tool calls within subagents (including the `Task` tool itself).

**Important**: Subagent permission prompts may multiply. Each subagent requests permissions separately. Use `PreToolUse` hooks to auto-approve specific tools for subagents, or set a `permissionMode`.

#### Can Subagents Have Their Own MCP Servers?

Yes. Use the `mcpServers` field in `AgentDefinition`:

```typescript
type AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>;
```

Subagents can reference parent MCP servers by name (string) or define inline server configs.

#### Subagent Limitations

- **Subagents cannot spawn their own subagents.** Do not include `Task` in a subagent's `tools` array.
- **Windows**: Long prompts may fail due to 8191 char command line limit.
- Subagent transcripts persist independently and are cleaned up after 30 days by default.

---

### 7. MCP Integration

#### mcpServers Option Format

```typescript
options: {
  mcpServers: {
    "server-name": McpServerConfig
  }
}
```

Where `McpServerConfig` is a union of four transport types:

```typescript
type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfigWithInstance;
```

#### Stdio Servers (local processes)

```typescript
type McpStdioServerConfig = {
  type?: "stdio";    // Optional, default
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

// Example:
mcpServers: {
  github: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  }
}
```

#### SSE Servers (remote, streaming)

```typescript
type McpSSEServerConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
};
```

#### HTTP Servers (remote, non-streaming)

```typescript
type McpHttpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};
```

#### SDK MCP Servers (in-process)

```typescript
type McpSdkServerConfigWithInstance = {
  type: "sdk";
  name: string;
  instance: McpServer;
};

// Created via createSdkMcpServer() — see Custom Tools section
```

#### Claude AI Proxy Servers

```typescript
type McpClaudeAIProxyServerConfig = {
  type: "claudeai-proxy";
  url: string;
  id: string;
};
```

#### MCP Tool Naming Convention

All MCP tools follow: `mcp__<server-name>__<tool-name>`

Example: Server named `"github"` with tool `list_issues` becomes `mcp__github__list_issues`.

Wildcards work in `allowedTools`: `"mcp__github__*"` allows all tools from github server.

#### Can MCP Servers Be Added/Removed Mid-Session?

**Yes.** The `Query` object provides three methods for dynamic MCP management:

```typescript
const q = query({ prompt: "...", options });

// Replace all MCP servers
await q.setMcpServers({
  "new-server": { command: "npx", args: ["..."] }
});

// Toggle individual server on/off
await q.toggleMcpServer("github", false);  // Disable
await q.toggleMcpServer("github", true);   // Re-enable

// Reconnect a server
await q.reconnectMcpServer("github");
```

#### MCP from Config File (.mcp.json)

Create at project root:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

The SDK loads this automatically.

#### Tool Search (auto mode)

When you have many MCP tools, the SDK can dynamically load them on-demand:

```typescript
options: {
  env: {
    ENABLE_TOOL_SEARCH: "auto"     // Default: activates at 10% context window usage
    // ENABLE_TOOL_SEARCH: "auto:5"  // Activate at 5%
    // ENABLE_TOOL_SEARCH: "true"    // Always on
    // ENABLE_TOOL_SEARCH: "false"   // Always off
  }
}
```

---

### 8. Custom Tools

#### tool() Function

```typescript
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const myTool = tool(
  "tool_name",                          // Name
  "Description of what the tool does",  // Description
  {                                     // Zod schema for input
    param1: z.string().describe("Description"),
    param2: z.number().optional(),
  },
  async (args) => {                     // Handler
    // args is typed based on schema
    return {
      content: [{ type: "text", text: "Result" }]
    };
  },
  { annotations: { readOnly: true } }  // Optional: ToolAnnotations
);
```

**Parameters**:
| Parameter | Type | Description |
|:----------|:-----|:------------|
| `name` | `string` | Tool name |
| `description` | `string` | What the tool does |
| `inputSchema` | `AnyZodRawShape` | Zod schema (supports Zod 3 and Zod 4) |
| `handler` | `(args, extra) => Promise<CallToolResult>` | Async handler |
| `extras` | `{ annotations?: ToolAnnotations }` | Optional MCP annotations (`readOnly`, `destructive`, `openWorld`) |

#### createSdkMcpServer()

```typescript
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

const server = createSdkMcpServer({
  name: "my-tools",
  version: "1.0.0",
  tools: [myTool1, myTool2]
});
```

Returns a `McpSdkServerConfigWithInstance` that can be passed directly to `mcpServers`.

#### How Custom Tools Are Exposed to the Model

Custom tools are exposed via the MCP protocol with the naming convention `mcp__<server-name>__<tool-name>`. They must be explicitly allowed via `allowedTools`.

**Important**: Custom MCP tools require streaming input mode. You must use an async generator for the `prompt` parameter -- a simple string will not work with MCP servers.

#### Practical Example: Custom Tool Calling a Local API

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const apiServer = createSdkMcpServer({
  name: "local-api",
  version: "1.0.0",
  tools: [
    tool(
      "fetch_user",
      "Fetch user data from the local API",
      {
        userId: z.string().describe("User ID to look up")
      },
      async (args) => {
        try {
          const response = await fetch(`http://localhost:8080/api/users/${args.userId}`);
          const data = await response.json();
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }]
          };
        }
      },
      { annotations: { readOnly: true } }
    )
  ]
});

// Use with streaming input mode (required for MCP)
async function* messages() {
  yield {
    type: "user" as const,
    message: {
      role: "user" as const,
      content: "Look up user abc-123"
    }
  };
}

for await (const message of query({
  prompt: messages(),
  options: {
    mcpServers: { "local-api": apiServer },
    allowedTools: ["mcp__local-api__fetch_user"],
    maxTurns: 3
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

---

### 9. Code Examples

#### Minimal Hello World Agent on Bun

```typescript
// hello.ts — run with: bun run hello.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "What files are in this directory?",
  options: {
    allowedTools: ["Bash", "Glob"],
    executable: "bun"
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

#### Agent with Hooks (Logging All Tool Calls)

```typescript
import { query, type HookCallback, type PreToolUseHookInput, type PostToolUseHookInput }
  from "@anthropic-ai/claude-agent-sdk";
import { appendFile } from "fs/promises";

const logToolCall: HookCallback = async (input, toolUseID, { signal }) => {
  const timestamp = new Date().toISOString();

  if (input.hook_event_name === "PreToolUse") {
    const pre = input as PreToolUseHookInput;
    await appendFile("./tool-audit.log",
      `${timestamp} [PRE] ${pre.tool_name} | input: ${JSON.stringify(pre.tool_input)}\n`
    );
  }

  if (input.hook_event_name === "PostToolUse") {
    const post = input as PostToolUseHookInput;
    await appendFile("./tool-audit.log",
      `${timestamp} [POST] ${post.tool_name} | response length: ${String(post.tool_response).length}\n`
    );
  }

  return {};  // Allow all operations
};

for await (const message of query({
  prompt: "Analyze this codebase structure",
  options: {
    allowedTools: ["Read", "Glob", "Grep"],
    hooks: {
      PreToolUse: [{ hooks: [logToolCall] }],
      PostToolUse: [{ hooks: [logToolCall] }],
    }
  }
})) {
  if (message.type === "assistant") {
    const text = message.message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) process.stdout.write(text);
  }
  if (message.type === "result" && message.subtype === "success") {
    console.log("\n---\nDone. Cost: $" + message.total_cost_usd);
  }
}
```

#### Agent with Custom Tool

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const weatherServer = createSdkMcpServer({
  name: "weather",
  version: "1.0.0",
  tools: [
    tool(
      "get_weather",
      "Get current temperature for a location",
      {
        latitude: z.number().describe("Latitude"),
        longitude: z.number().describe("Longitude"),
      },
      async (args) => {
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m&temperature_unit=fahrenheit`
        );
        const data = await res.json();
        return {
          content: [{ type: "text", text: `Temperature: ${data.current.temperature_2m}F` }]
        };
      }
    )
  ]
});

async function* input() {
  yield {
    type: "user" as const,
    message: { role: "user" as const, content: "What's the weather in San Francisco?" }
  };
}

for await (const message of query({
  prompt: input(),
  options: {
    mcpServers: { weather: weatherServer },
    allowedTools: ["mcp__weather__get_weather"],
    maxTurns: 3
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

#### Agent with Session Resume

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

let sessionId: string | undefined;

// First query: analyze the codebase
for await (const message of query({
  prompt: "Read the authentication module and summarize it",
  options: { allowedTools: ["Read", "Glob", "Grep"] }
})) {
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;
    console.log("Session:", sessionId);
  }
  if (message.type === "result" && message.subtype === "success") {
    console.log("First result:", message.result);
  }
}

// Second query: resume and ask follow-up
if (sessionId) {
  for await (const message of query({
    prompt: "Now find all places that call it",  // "it" = auth module from context
    options: { resume: sessionId }
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log("Follow-up result:", message.result);
    }
  }
}
```

#### Agent with Subagents

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Review this project: check code quality, then run the tests",
  options: {
    allowedTools: ["Read", "Grep", "Glob", "Bash", "Task"],
    agents: {
      "code-reviewer": {
        description: "Expert code reviewer for quality and security reviews.",
        prompt: "Analyze code quality, identify issues, suggest improvements.",
        tools: ["Read", "Grep", "Glob"],
        model: "sonnet",
      },
      "test-runner": {
        description: "Runs test suites and analyzes results.",
        prompt: "Execute tests and provide clear pass/fail analysis.",
        tools: ["Bash", "Read", "Grep"],
        model: "haiku",
      }
    }
  }
})) {
  // Track subagent activity
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use" && block.name === "Task") {
        console.log(`Delegating to: ${(block.input as any).subagent_type}`);
      }
    }
  }

  if ("parent_tool_use_id" in message && message.parent_tool_use_id) {
    // This message is from a subagent
  }

  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

#### Agent with MCP Server Attached

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "List the 3 most recent issues in anthropics/claude-code",
  options: {
    mcpServers: {
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! }
      }
    },
    allowedTools: ["mcp__github__list_issues"]
  }
})) {
  if (message.type === "system" && message.subtype === "init") {
    console.log("MCP servers:", message.mcp_servers);
  }
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

#### V2 Preview: Multi-Turn Session

```typescript
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

await using session = unstable_v2_createSession({
  model: "claude-opus-4-6"
});

// Turn 1
await session.send("What is 5 + 3?");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") {
    const text = msg.message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    console.log(text);
  }
}

// Turn 2 (remembers context)
await session.send("Multiply that by 2");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") {
    const text = msg.message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    console.log(text);
  }
}
```

---

## Sources

1. https://platform.claude.com/docs/en/agent-sdk/typescript — Official TypeScript SDK Reference
2. https://platform.claude.com/docs/en/agent-sdk/hooks — Hooks documentation
3. https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview — V2 SDK Preview
4. https://platform.claude.com/docs/en/agent-sdk/subagents — Subagents documentation
5. https://platform.claude.com/docs/en/agent-sdk/custom-tools — Custom Tools documentation
6. https://platform.claude.com/docs/en/agent-sdk/mcp — MCP Integration documentation
7. https://platform.claude.com/docs/en/agent-sdk/streaming-output — Streaming Events documentation
8. https://platform.claude.com/docs/en/agent-sdk/sessions — Session Management documentation
9. https://platform.claude.com/docs/en/agent-sdk/overview — SDK Overview
10. https://github.com/anthropics/claude-agent-sdk-typescript — GitHub repository
11. https://github.com/anthropics/claude-agent-sdk-typescript/issues/150 — Bun build CLI discovery issue
12. https://nader.substack.com/p/the-complete-guide-to-building-agents — Community guide
13. https://bun.com/blog/bun-joins-anthropic — Bun/Anthropic acquisition

---

## Open Questions

1. **Bun build workaround**: Issue #150 is open -- does `pathToClaudeCodeExecutable` option resolve the bundling issue? Needs hands-on testing.
2. **Concurrent sessions**: Can two `query()` instances write to different sessions simultaneously from the same process? The docs don't explicitly address this.
3. **OAuth token refresh**: Does the SDK handle token refresh automatically, or does the caller need to manage token lifecycle?
4. **V2 interface stability**: The V2 `send()`/`stream()` API is marked "unstable preview." Session forking is not available in V2 yet. Timeline to stable release is unclear.
5. **Custom tool streaming input requirement**: The docs state MCP tools require async generator input mode. Needs verification -- does this apply to SDK MCP servers (`type: "sdk"`) as well, or only external servers?
6. **Hook firing in subagents**: Do `PreToolUse` hooks registered on the parent fire for tool calls made by subagents? The docs imply yes but this needs confirmation.
7. **`spawnClaudeCodeProcess` for remote execution**: How does this work in practice for containerized deployments? What is the `SpawnedProcess` interface?
8. **Session file format**: What is the exact JSON schema of session transcript files? Can they be parsed/inspected programmatically beyond `listSessions()`?
9. **Rate limit handling**: Does the SDK auto-retry on rate limits, or does it surface the error for the caller to handle?
10. **`canUseTool` vs hooks**: When both `canUseTool` and `PreToolUse` hooks are configured, what is the execution order and priority?
