// ── ModusClient SDK Types ──

/** Options for constructing a ModusClient connection to the harness server. */
export type ModusClientOptions = {
  url: string;
  token?: string;
  pin?: string;
  /** If provided, used instead of PIN-based auth. For browser usage with localStorage tokens. */
  getToken?: () => string | undefined;
};

// ── Interact ──

/** A move to activate alongside a prompt, with optional pre-filled inputs. */
export type MoveBinding = {
  name: string;
  inputs?: Record<string, unknown>;
};

/**
 * Options for the high-level `interact()` call that creates or continues a session in one shot.
 * Combines session creation, provider/model selection, move activation, and streaming into a single request.
 * Most fields are optional and fall back to profile or global defaults.
 */
export type InteractOptions = {
  /** If provided, continues an existing session instead of creating a new one. */
  sessionId?: string;
  prompt: string;
  profile?: string;
  userProfile?: string;
  provider?: string;
  model?: string;
  /** Controls how much work the agent puts into reasoning. Provider-specific interpretation. */
  effort?: "off" | "low" | "medium" | "high" | "max";
  /** Cap on agent turns (tool-use cycles) before the session auto-stops. */
  maxTurns?: number;
  /** Moves to activate in the session alongside this prompt. */
  moves?: MoveBinding[];
  cwd?: string;
  additionalDirectories?: string[];
  /** Explicit tool allowlist; overrides profile defaults when provided. */
  tools?: string[];
  disallowedTools?: string[];
  /** Per-tool state overrides; "inherit" defers to profile default. */
  toolStates?: Record<string, "inherit" | "on" | "off">;
  /** Provider-specific control knobs (e.g. codex sandbox mode, claude permission mode). */
  providerControls?: Record<string, unknown>;
  /** Whether to load .modus/ project settings for the session's cwd. */
  loadProjectSettings?: boolean;
  /** Whether to bypass or interactively handle tool permission requests. */
  permissionMode?: "bypass" | "interactive";
  /** If true, opens an SSE stream for real-time events on this session. */
  subscribe?: boolean;
  /** If sessionId is given but doesn't exist, create it. */
  createIfMissing?: boolean;
  attachments?: Attachment[];
};

/** A base64-encoded image attachment sent with a prompt. */
export type Attachment = {
  type: "image";
  mediaType: string;
  /** Base64-encoded image data. */
  data: string;
  name?: string;
};

/** Result of an `interact()` call -- the session ID and its current status. */
export type InteractResult = {
  sessionId: string;
  status: string;
};

// ── Tool Calls ──

/** A tool invocation within an agent turn, including status, timing, and optional sub-agent messages. */
export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result?: string;
  /** Epoch ms when the tool call started. */
  startedAt: number;
  /** Elapsed ms for completed calls. */
  duration?: number;
  /** If this tool spawned a sub-agent, the task ID tracking it. */
  taskId?: string;
  /** Messages from a sub-agent spawned by this tool call. */
  subMessages?: Message[];
  /** Condensed summary of sub-agent work, if available. */
  subSummary?: string;
};

/** A sub-agent task spawned by a tool call (e.g. Claude's Agent tool). */
export type SubTask = {
  taskId: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  lastToolName?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
};

// ── Attachments (API wire format) ──

/** Wire-format attachment for the REST API (identical shape to Attachment but used in API payloads). */
export type ApiAttachment = {
  type: "image";
  mediaType: string;
  data: string;
  name?: string;
};

/** A file artifact produced during a session (e.g. generated image, exported data). */
export type SessionArtifact = {
  id: number;
  sessionId: string;
  /** Sequence number within the session's event stream. */
  seq: number;
  /** UUID of the message this artifact is associated with. */
  targetMessageUuid?: string;
  name: string;
  mime: string;
  /** Relative URL to fetch the artifact content. */
  url: string;
  /** The action that produced this artifact, if action-generated. */
  sourceAction?: string;
  createdAt: number;
  previewText?: string;
  metadata?: Record<string, unknown>;
};

// ── Messages ──

let _msgId = 0;
export function nextMsgId(): string { return `m${++_msgId}`; }

/** A single message in a session conversation, including assistant metadata and tool calls. */
export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Server-assigned UUID for deduplication and artifact targeting. */
  uuid?: string;
  /** Extended thinking text from models that support it. */
  thinking?: string;
  /** How long the model spent in extended thinking, in ms. */
  thinkingDuration?: number;
  toolCalls?: ToolCall[];
  attachments?: Attachment[];
  artifacts?: SessionArtifact[];
  /** Position in the session's event stream. */
  seq?: number;
  timestamp?: number;
  /** Cost, token usage, and model info for this turn. Only present on assistant messages. */
  meta?: {
    cost?: number;
    duration?: number;
    model?: string;
    turns?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    contextWindow?: number;
  };
  /** Pre-rendered copy of this turn's content for display, avoiding re-parsing tool calls. */
  turnCopy?: { text: string; thinking?: string; toolCalls?: ToolCall[] };
};

// ── Permission Requests ──

/** A tool permission request awaiting user approval (used in interactive permission mode). */
export type PendingPermission = {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseID?: string;
  /** Whether this permission was raised in interactive mode (vs. auto-denied). */
  interactive: boolean;
  decisionReason?: string;
  requestedAt: number;
};

/** User's response to a pending tool permission request. */
export type PermissionResponse = {
  requestId: string;
  behavior: "allow" | "deny";
  /** Optionally modify the tool input before allowing execution. */
  updatedInput?: Record<string, unknown>;
  message?: string;
  /** "once" applies to this call only; "session" remembers for the rest of the session. */
  scope?: "once" | "session";
};

// ── Session Status ──

export type SessionStatus = "starting" | "running" | "idle" | "paused" | "done" | "error";

/** Mutable agent configuration for an active session (model, tools, provider controls). */
export type AgentConfigState = {
  toolStates: Record<string, "inherit" | "on" | "off">;
  model: string;
  provider: string;
  effort: string;
  maxTurns: string;
  /** Provider-specific control knobs, keyed by provider family. */
  providerControls?: {
    codex?: {
      sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
      webSearchMode?: "disabled" | "cached" | "live";
    };
    claude?: {
      permissionMode?: "default" | "acceptEdits" | "plan" | "dontAsk";
    };
  };
};

// ── Session ──

/** Full in-memory session state including messages, config, cost tracking, and streaming info. */
export type Session = {
  id: string;
  status: SessionStatus;
  /** First line of the initial prompt, used as a display label. */
  preview: string;
  profile?: string;
  provider?: string;
  /** Profile queued for next turn (set when user changes profile mid-session). */
  nextProfile?: string;
  /** Config queued for next turn (applied when the current turn completes). */
  nextAgentConfig?: AgentConfigState;
  model?: string;
  agentConfig: AgentConfigState;
  cwd?: string;
  additionalDirectories?: string[];
  loadProjectSettings?: boolean;
  messages: Message[];
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Highest event sequence number seen. Used for SSE catch-up. */
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
  /** Name of the tool currently being executed, if any. */
  activeToolName?: string;
  /** Elapsed ms since the active tool started. */
  activeToolElapsed?: number;
  availableTools?: string[];
  pendingPermissions?: PendingPermission[];
  /** SSE feed URL path for subscribing to this session's events. */
  streamFeed?: string;
};

// ── Sessions ──

/** Lightweight session info returned by list/search endpoints (DB row shape, snake_case). */
export type SessionInfo = {
  id: string;
  preview: string;
  title: string | null;
  profile: string | null;
  provider: string | null;
  model: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  last_message_at: number;
  message_count: number;
  total_cost_usd: number;
  last_prompt: string | null;
  last_response: string | null;
  cwd: string | null;
  /** Name of the action that spawned this session, if action-triggered. */
  action_name: string | null;
  /** Comma-separated session tags. */
  tags: string;
  last_input_tokens?: number | null;
  last_output_tokens?: number | null;
};

/** Live session info for currently active (in-memory) sessions. */
export type ActiveSessionInfo = {
  id: string;
  status: string;
  profile: string | null;
  provider: string | null;
  model: string | null;
  costUsd: number;
  numTurns: number;
  startedAt: number;
  lastEventAt: number;
  preview: string;
  lastText: string | null;
  /** Current event sequence number for SSE catch-up. */
  seq: number;
  /** Number of SSE clients currently subscribed to this session. */
  subscribers: number;
  cwd: string | null;
  additionalDirectories: string[] | null;
  /** Whether the session has been archived (hidden from default lists). */
  archived?: boolean;
};

/** A full-text search result matching a session's messages. */
export type SearchHit = {
  session_id: string;
  preview: string;
  profile: string | null;
  model: string | null;
  cwd: string | null;
  last_message_at: number;
  total_cost_usd: number;
  /** Highlighted text snippet showing the search match in context. */
  snippet: string;
};

/** Polling-friendly status snapshot for a session, including error state and commit attribution. */
export type SessionStatusInfo = {
  sessionId: string;
  status: string;
  seq: number;
  costUsd: number;
  numTurns: number;
  startedAt: number;
  lastEventAt: number;
  error: string | null;
  archived?: boolean;
  /** If the session's cwd is a git repo, whether a recent commit can be attributed to this session. */
  commitAttribution?: CommitAttribution;
};

export type CommitAttributionReason =
  | "no-session-cwd"
  | "no-file-touches"
  | "no-nearby-commit"
  | "no-file-overlap";

/** Result of attempting to attribute a git commit to a session based on file overlap. */
export type CommitAttribution = {
  matched: boolean;
  commit?: GitCommit;
  matchedFiles?: string[];
  source?: "session";
  /** Why attribution failed, if matched is false. */
  reason?: CommitAttributionReason;
};

/** Options for creating a new session via the REST API. */
export type CreateSessionOpts = {
  prompt: string;
  attachments?: ApiAttachment[];
  profile?: string;
  userProfile?: string;
  provider?: string;
  model?: string;
  toolStates?: Record<string, "inherit" | "on" | "off">;
  maxTurns?: number;
  effort?: string;
  cwd?: string;
  additionalDirectories?: string[];
  tools?: string[];
  disallowedTools?: string[];
  providerControls?: AgentConfigState["providerControls"];
  loadProjectSettings?: boolean;
  /** If provided, reuse this ID instead of generating one. Fails if already in use. */
  sessionId?: string;
};

/** Options for sending a follow-up message to an existing session. */
export type SendMessageOpts = {
  prompt: string;
  /** Switch the session's profile for this message onward. */
  profile?: string;
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  /** Moves to activate alongside this message. */
  moves?: MoveBinding[];
  cwd?: string;
  tools?: string[];
  disallowedTools?: string[];
  attachments?: Attachment[];
};

/**
 * A single turn's content extracted from the event stream, used for polling-based clients
 * that don't subscribe to SSE but need turn-by-turn content.
 */
export type TurnContent = {
  role: "user" | "assistant";
  seq: number;
  text: string;
  thinking?: string;
  toolCalls?: { name: string; input: Record<string, unknown>; result?: string }[];
  uuid?: string;
  artifacts?: SessionArtifact[];
  timestamp: number;
};

export type SessionHistorySnapshot = {
  sessionId: string;
  status: SessionStatus;
  model: string;
  cwd: string;
  additionalDirectories: string[];
  loadProjectSettings: boolean;
  agentConfig: AgentConfigState;
  messages: TurnContent[];
  lastSeq: number;
  createdAt: number;
};

// ── Events ──

/** A single server-sent event from a session's event stream (untyped, kept for backward compat). */
export type SSEEvent = {
  event: string;
  data: Record<string, unknown>;
  seq: number;
};

/** Streaming token events from the model. */
export type SSEStreamEvent = {
  event: "stream_event";
  data: { type: string; event: Record<string, unknown> };
  seq: number;
};

/** Turn completion with the final assistant message and usage metadata. */
export type SSEResultEvent = {
  event: "result";
  data: {
    type: "result";
    subtype: "result";
    message: { role: "assistant"; content: string };
    session_id: string;
    cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    duration_ms?: number;
    result?: string;
    [key: string]: unknown;
  };
  seq: number;
};

/** Session lifecycle events (init, switch, interrupted, artifact, config, etc). */
export type SSESystemEvent = {
  event: "system";
  data: {
    type: "system";
    subtype: "init" | "switch" | "interrupted" | "artifact" | "config" | string;
    session_id?: string;
    [key: string]: unknown;
  };
  seq: number;
};

/** Replayed user messages during catch-up. */
export type SSEUserEvent = {
  event: "user";
  data: { type: "user"; subtype: "prompt"; message: { role: "user"; content: string } };
  seq: number;
};

/** Replayed assistant messages during catch-up. */
export type SSEAssistantEvent = {
  event: "assistant";
  data: { type: "assistant"; subtype: "response"; message: { role: "assistant"; content: string } };
  seq: number;
};

/** Tool execution progress updates. */
export type SSEToolProgressEvent = {
  event: "tool_progress";
  data: { type: "tool_progress"; tool_name?: string; elapsed_time_seconds?: number; [key: string]: unknown };
  seq: number;
};

/** Tool use completed — clears active tool state. */
export type SSEToolUseSummaryEvent = {
  event: "tool_use_summary";
  data: { type: "tool_use_summary"; [key: string]: unknown };
  seq: number;
};

/** Error events from the server. */
export type SSEErrorEvent = {
  event: "error";
  data: { type: "error"; error: string };
  seq: number;
};

/** Rate limiting notifications. */
export type SSERateLimitEvent = {
  event: "rate_limit_event";
  data: { type: "rate_limit_event"; [key: string]: unknown };
  seq: number;
};

/** Discriminated union of all typed SSE events. Narrow on `event` field. */
export type TypedSSEEvent =
  | SSEStreamEvent
  | SSEResultEvent
  | SSESystemEvent
  | SSEUserEvent
  | SSEAssistantEvent
  | SSEToolProgressEvent
  | SSEToolUseSummaryEvent
  | SSEErrorEvent
  | SSERateLimitEvent;

/** Handle returned when opening an SSE stream -- provides an async iterable of events and an abort function. */
export type EventStreamHandle = {
  events: AsyncIterable<TypedSSEEvent>;
  abort: () => void;
};

/** Callback-based interface for consuming an SSE event stream. */
export type EventStreamCallbacks = {
  onEvent: (event: any, seq: number) => void;
  onDone: () => void;
  onDisconnect?: () => void;
  onError: (error: string) => void;
};

// ── Session Stats ──

/** Aggregate usage statistics across sessions, broken down by project, profile, model, and day. */
export type SessionStats = {
  totals: { sessions: number; cost: number; messages: number; firstSession: number | null; lastSession: number | null };
  byProject: { project: string; sessions: number; cost: number; messages: number }[];
  byProfile: { profile: string; sessions: number; cost: number; messages: number }[];
  byModel: { model: string; sessions: number; cost: number }[];
  daily: { day: string; sessions: number; cost: number }[];
  topSessions: { id: string; preview: string; cost: number; messages: number; profile: string | null; cwd: string | null }[];
};

// ── Account ──

/** Current account authentication state and cost summary across time windows. */
export type AccountInfo = {
  account: {
    loggedIn: boolean;
    authMethod: string;
    apiProvider: string;
    email: string;
    orgId: string;
    orgName: string;
    subscriptionType: string;
  } | null;
  costs: {
    today: { cost: number; sessions: number; messages: number };
    week: { cost: number; sessions: number; messages: number };
    month: { cost: number; sessions: number; messages: number };
  };
};

/** Gemini API availability and quota information for the configured account. */
export type GeminiUsageInfo = {
  available: boolean;
  authType: string;
  model: string;
  checkedAt: number;
  quota: {
    remaining?: number;
    limit?: number;
    resetTime?: string;
  };
  tier?: string;
  paidTier?: string;
  error?: string;
};

// ── Profiles ──

/** MCP server connection config -- stdio (local process), SSE, or HTTP transport. */
export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/** UI display overrides for a specific agent profile. */
export type ProfileUi = {
  label?: string;
  showThinking?: boolean;
  showMeta?: boolean;
  showToolCalls?: boolean;
  showGitEvents?: boolean;
  placeholder?: string;
  emptyTitle?: string;
  emptySubtitle?: string;
  /** Widget names to display in the side panel when this profile is active. */
  panelWidgets?: string[];
};

/**
 * An agent profile defining HOW an agent behaves: its system prompt, model, tools, and UI treatment.
 * Loaded from `profiles/agents/*.json` or `.modus/profiles/agents/*.json`.
 */
export type Profile = {
  name: string;
  description: string;
  prompt: string;
  /** "custom" replaces the base prompt entirely; "append" adds to it. Defaults to "custom". */
  promptMode?: "custom" | "append";
  cwd?: string;
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  /** Explicit tool allowlist, or "all" to enable everything the provider offers. */
  tools?: string[] | "all";
  disallowedTools?: string[];
  loadProjectSettings?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  ui?: ProfileUi;
  /** Suggested working directories shown in the UI profile picker. */
  cwdSuggestions?: string[];
};

/** Global configuration shared across all profiles (MCP servers, client extensions). */
export type GlobalConfig = {
  mcpServers?: Record<string, McpServerConfig>;
  clientExtensions?: {
    paths?: string[];
    enabled?: string[];
    disabled?: string[];
    settings?: Record<string, Record<string, unknown>>;
  };
};

// ── Providers ──

export type ProviderModel = { id: string; owned_by?: string };

/** A named group of tools exposed by a provider (e.g. "File Operations", "Git"). */
export type ProviderToolGroup = {
  label: string;
  tools: string[];
};

/**
 * Static capabilities declared by a provider -- what tools it offers, how it handles
 * permissions, MCP support level, and whether config changes apply mid-turn or next-turn.
 */
export type ProviderCapabilities = {
  name: string;
  label: string;
  family: "claude-code" | "codex" | "cursor" | "gemini-cli" | "pi-agent";
  builtInTools: string[];
  builtInToolGroups: ProviderToolGroup[];
  /** "explicit" means the tool list is known upfront; "event-derived" means tools are discovered from events. */
  builtInToolMode: "explicit" | "event-derived";
  supportsMcp: boolean;
  mcpSupport: "full" | "stdio-only" | "none";
  /** Events the provider emits that aren't tool calls (e.g. "thinking", "git_event"). */
  nonToolSignals: string[];
  permissionModel: {
    mode: "per-tool-ui" | "runtime-native" | "none";
    interactive: boolean;
    summary: string;
  };
  sessionMutability: {
    providerSwitchAfterStart: boolean;
    profileSwitch: "allowed" | "provider-locked";
    /** Whether config changes (model, effort, tools) take effect immediately or on the next turn. */
    configApplies: "immediate" | "next-turn";
  };
};

/** A single health check result for a provider (e.g. CLI installed, API key set). */
export type ProviderHealthCheck = {
  type: "cli" | "env" | "local" | "auth";
  label: string;
  passed: boolean;
  detail?: string;
};

/** Provider health status with individual check results. */
export type ProviderHealthInfo = {
  name: string;
  label: string;
  family: string;
  status: "ready" | "misconfigured" | "unavailable" | "unknown";
  checks: ProviderHealthCheck[];
};

export type ProviderInfo = {
  name: string;
  label?: string;
  [key: string]: unknown;
};

export type ProviderCapability = ProviderCapabilities;
export type ProviderHealth = ProviderHealthInfo;

// ── User Profiles ──

/**
 * UI customization for a user profile -- dashboard layout, side panel widgets,
 * preferred editor/terminal, and client extension configuration.
 */
export type UserProfileUiConfig = {
  panelWidgets?: Array<{ id?: string; type: string; [key: string]: unknown }>;
  dashboard?: {
    widgets?: Array<{ type: string; [key: string]: unknown }>;
    pages?: Array<{
      id: string;
      title: string;
      blocks?: Array<
        | { kind: "widget"; widget: { type: string; [key: string]: unknown } }
        | { kind: "module"; module: "actions" | "git"; [key: string]: unknown }
        | { kind: "text"; markdown: string; [key: string]: unknown }
      >;
      layout?: unknown;
      nav?: boolean;
      fullscreen?: boolean;
    }>;
  };
  leftPanel?: {
    widgets?: string[];
  };
  /** Per-view panel layout overrides. Keys are view names (e.g. "chat", "actions"). */
  layouts?: Record<string, {
    left?: { mode?: "list" | "tabs"; widgets?: Array<string | { id?: string; type: string; [key: string]: unknown }>; tree?: unknown };
    right?: { mode?: "list" | "tabs"; widgets?: Array<string | { id?: string; type: string; [key: string]: unknown }>; tree?: unknown };
  }>;
  computer?: string;
  editor?: string;
  clientExtensions?: {
    paths?: string[];
    enabled?: string[];
    disabled?: string[];
    settings?: Record<string, Record<string, unknown>>;
  };
};

/** Persisted UI state for a user profile (sidebar preferences, last-used agent/session). */
export type UserProfileState = {
  sidebarGroupMode?: "time" | "agent";
  sidebarCollapsedGroups?: string[];
  sidebarConfigExpanded?: boolean;
  lastAgentProfile?: string;
  lastCwd?: string;
  lastSessionId?: string | null;
};

/**
 * A user profile scoping which projects, agents, and defaults a specific user sees.
 * Loaded from `profiles/users/*.json`.
 */
export type UserProfile = {
  name: string;
  displayName: string;
  /** Variables available in Handlebars prompt templates (e.g. {{userName}}). */
  templateVars?: Record<string, string>;
  /** Project paths this user has access to. */
  projects: string[];
  /** Which agent profiles are visible to this user. If omitted, all are visible. */
  agentProfiles?: string[];
  defaultAgentProfile?: string;
  provider?: string;
  model?: string;
  effort?: string;
  /** Tag filter for memory queries scoped to this user. */
  memoryFilter?: string;
  /** If true, show all registered project paths regardless of user scoping. */
  showAllProjectPaths?: boolean;
  dashboard?: {
    widgets?: Array<{ type: string; [key: string]: unknown }>;
    pages?: Array<{
      id: string;
      title: string;
      blocks?: Array<
        | { kind: "widget"; widget: { type: string; [key: string]: unknown } }
        | { kind: "module"; module: "actions" | "git"; [key: string]: unknown }
        | { kind: "text"; markdown: string; [key: string]: unknown }
      >;
      layout?: unknown;
      nav?: boolean;
      fullscreen?: boolean;
    }>;
  };
  leftPanel?: {
    widgets?: string[];
  };
  /** Per-view panel layout overrides. Keys are view names (e.g. "chat", "actions"). */
  layouts?: Record<string, {
    left?: { mode?: "list" | "tabs"; widgets?: Array<string | { id?: string; type: string; [key: string]: unknown }>; tree?: unknown };
    right?: { mode?: "list" | "tabs"; widgets?: Array<string | { id?: string; type: string; [key: string]: unknown }>; tree?: unknown };
  }>;
  computer?: string;
  editor?: string;
  clientExtensions?: {
    paths?: string[];
    enabled?: string[];
    disabled?: string[];
    settings?: Record<string, Record<string, unknown>>;
  };
};

// ── Permission Response (SDK) ──

/** SDK-side permission response with an additional "allowAlways" behavior option. */
export type PermissionResponseOpts = {
  requestId: string;
  /** "allowAlways" permanently whitelists this tool (unlike PermissionResponse which is session-scoped). */
  behavior: "allow" | "deny" | "allowAlways";
  updatedInput?: Record<string, unknown>;
  message?: string;
  scope?: string;
};

// ── Session Tags ──

export type SessionTagsResult = {
  ok?: boolean;
  tags: string[];
};

// ── Branch ──

/** Result of branching a session -- returns the new session's ID. */
export type BranchResult = {
  sessionId: string;
};

// ── Actions ──

/**
 * How an action is triggered: on a time interval, via webhook, manually, or
 * chained from another action's completion.
 */
export type ActionTrigger =
  | { type: "interval"; every: string; from?: "completion" | "start"; activeHours?: { start: string; end: string } }
  | { type: "webhook"; token?: string }
  | { type: "manual" }
  | { type: "action"; source: string; condition: "any" | "done" | "error" };

export type ActionSummary = ActionInfo;

export type ActionDetail = ActionInfo;

/**
 * An automated agent workflow that spawns sessions on triggers. Actions define what agent profile
 * to use, how to trigger, retry/cycle limits, and notification channels.
 */
export type ActionInfo = {
  name: string;
  description: string;
  /** Whether this action is defined in the harness or the project's .modus/ directory. */
  origin?: "harness" | "project";
  agentProfile: string;
  trigger: ActionTrigger;
  /** For interval triggers, how long between cycles (a cycle is a batch of runs). */
  cycleInterval?: string;
  enabled: boolean;
  maxTurns?: number;
  /** Maximum runs before the action auto-disables. */
  maxRuns?: number;
  /** Maximum cycles before the action auto-disables. */
  maxCycles?: number;
  /** Max retries when context gathering (context.ts gather()) fails. */
  maxRetries?: number;
  onGatherError?: "fail" | "retry";
  /** Max retries for transient provider failures (network errors, rate limits). */
  maxTransientRetries?: number;
  onTransientFailure?: "retry" | "skip";
  /** Max concurrent sessions for this action. */
  concurrency?: number;
  notify?: Array<{ channel: string; on: string | string[] }>;
  /** Expected artifacts the agent should produce via modus_submit. */
  artifacts?: Array<{ name: string; mime: string; required?: boolean }>;
  tags?: string[];
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  running: boolean;
  activeSessions: number;
  cycleNumber: number;
  cycleRunCount: number;
  /** True when the action has hit its maxRuns or maxCycles limit. */
  exhausted: boolean;
};

/** A single execution record for an action run. */
export type ActionRun = {
  id: number;
  actionName: string;
  sessionId: string | null;
  runNumber: number;
  cycleNumber: number;
  status: string;
  summary: string | null;
  startedAt: number;
  completedAt: number | null;
  costUsd: number;
  error: string | null;
  triggerType: string;
  /** Error from the afterRun hook, if any. */
  afterRunError: string | null;
  attempts?: number;
  /** Error from the verify step, if the action uses verification. */
  verifyError?: string | null;
};

export type ActionExecution = {
  id?: number;
  action_name?: string;
  status?: string;
  started_at?: number;
  [key: string]: unknown;
};

// ── Moves ──

/** A user-facing input field definition for a move's activation form. */
export type MoveInput = {
  name: string;
  label?: string;
  type: "text" | "textarea" | "select" | "toggle" | "number";
  /** For "select" type: array of option values, or a pipe-delimited string. */
  options?: string[] | string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
};

/**
 * Page declaration — shared shape for moves, actions, and missions that register
 * a navigable page in the UI. When `layout` is present, the page renders as a
 * composable widget layout (same schema as .modus/pages/*.json). Without `layout`,
 * move pages fall back to rendering the move's widget full-screen.
 */
export type MovePageInfo = {
  id: string;
  title: string;
  icon?: string;
  /** Whether to show this page in the main navigation. Defaults to true. */
  nav?: boolean;
  /** Full layout tree — when present, renders as a composable page layout. */
  layout?: unknown;
  /** Initial page-scoped shared state for widget linking (pub/sub). */
  context?: Record<string, unknown>;
  /** Outer padding in pixels around the layout container. */
  padding?: number;
};

/**
 * Summary of a registered move, returned by list endpoints.
 * Moves are user-invoked structured operations -- the WHAT of agent interaction.
 */
export type MoveListItem = {
  name: string;
  label: string;
  description: string;
  origin?: "harness" | "project";
  icon?: string;
  /** How the move executes: inline (current session), branch (new sibling session), or background (fire-and-forget). */
  mode?: "inline" | "branch" | "background";
  /** If true, the move stays active across turns (e.g. ambient context injection). */
  persistent?: boolean;
  inputs?: MoveInput[];
  tags?: string[];
  /** Widget config if this move has a UI component. */
  widget?: { mountOnAttach?: boolean };
  page?: MovePageInfo;
};

/**
 * Widget metadata for a move's UI component -- tells the frontend where to load the widget
 * module and how to cache it.
 */
export type MoveWidgetInfo = {
  label: string;
  icon?: string;
  /** Whether the widget panel opens automatically on activation. */
  autoOpen?: boolean;
  /** Whether to mount the widget immediately when the move is attached (vs. on first open). */
  mountOnAttach?: boolean;
  /** URL to the widget's ES module (loaded dynamically by the frontend). */
  moduleUrl: string;
  moveName: string;
  /** "instance" caches per activation, "module" caches the module globally, "none" reloads each time. */
  cache?: "instance" | "module" | "none";
};

/**
 * Result of activating a move in a session. Contains the token the agent uses to submit
 * results back via modus_submit, plus widget info if the move has a UI component.
 */
export type ActivateMoveResult = {
  /** Short-lived token (10min TTL) the agent passes to modus_submit to complete this move. */
  token: string;
  mode: "inline" | "branch" | "background" | "persistent";
  persistent?: boolean;
  /** For branch/background modes, the ID of the spawned session. */
  spawnedSessionId?: string;
  /** The rendered prompt injected into the session. */
  prompt?: string;
  moveRunId: number;
  /** API token for moves with an API contract (allows repeated submissions). */
  apiToken?: string;
  /** Unique instance ID for widget-backed moves. */
  instanceId?: string;
  widget?: MoveWidgetInfo;
};

export type MoveDetail = MoveListItem & {
  widget?: { component?: string; [key: string]: unknown };
  [key: string]: unknown;
};

/** Result of attaching to an existing move widget instance (e.g. reconnecting after page reload). */
export type AttachMoveResult = {
  /** API token for making requests to the move's API contract. */
  apiToken: string;
  instanceId: string;
  widget: MoveWidgetInfo;
};

/** Info about an ambient (persistent) move currently active in a session. */
export type AmbientMoveInfo = {
  moveName: string;
  activatedAt: number;
  inputs: Record<string, unknown>;
};

export type MoveRun = {
  id: number;
  move_name?: string;
  session_id?: string;
  status?: string;
  started_at?: number;
  finished_at?: number | null;
  [key: string]: unknown;
};

// ── Missions ──

export type MissionRunStatus = "pending" | "running" | "completed" | "error" | "paused";

/** How work is transferred between agents in a mission (e.g. one agent delegates a subtask to another). */
export type MissionTransferKind = "delegation" | "report" | "review" | "escalation";

export type MissionSummary = MissionListItem;

/** A registered mission template -- a multi-step, multi-agent orchestrated workflow that runs unattended. */
export type MissionListItem = {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  stepCount: number;
  /** Agent roles involved in this mission (e.g. "planner", "reviewer", "implementer"). */
  roles: string[];
  tags: string[];
};

export type MissionDetail = MissionSummary & {
  steps?: unknown[];
  [key: string]: unknown;
};

/** Status of a running or completed mission instance. */
export type MissionRunSummary = {
  id: number;
  missionName: string;
  status: MissionRunStatus;
  currentStepIndex: number;
  /** If paused, what kind of halt (e.g. "gate_failed", "user_review"). */
  haltKind: string | null;
  haltMessage: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type MissionStepSummary = MissionStepRunSummary;

/** Execution status of a single step within a mission run. */
export type MissionStepRunSummary = {
  id: number;
  stepId: string;
  stepOrder: number;
  /** The agent role executing this step. */
  role: string;
  title: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
};

/** A work transfer between agents within a mission (delegation, report-back, escalation). */
export type MissionTransferSummary = {
  id: number;
  stepId: string;
  fromSessionId: string | null;
  toSessionId: string | null;
  kind: MissionTransferKind;
  summary: string | null;
  createdAt: number;
};

/** Result of a quality gate check within a mission step (pass/fail with evidence). */
export type MissionGateResultSummary = {
  id: number;
  stepId: string;
  gateType: string;
  status: "pass" | "fail";
  evidence: string | null;
  checkedAt: number;
};

// ── Git ──

export type GitStatus = {
  /** Whether the directory is a git repository. */
  git: boolean;
  branch?: string;
  remote?: string;
  ahead?: number;
  behind?: number;
  files?: { modified: string[]; staged: string[]; untracked: string[] };
};

export type GitStatusResult = GitStatus;

export type GitCommit = {
  hash: string;
  date: string;
  message: string;
  author: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
};

export type GitLogEntry = GitCommit;

/** A single line in a unified diff. */
export type DiffLine = {
  type: "add" | "del" | "ctx";
  content: string;
  oldNum: number | null;
  newNum: number | null;
};

/** A contiguous block of changes within a file diff. */
export type DiffHunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type FileDiff = {
  path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

export type GitCommitDetail = GitCommit & {
  files: FileDiff[];
};

export type GitShowResult = GitCommitDetail;

// ── Files ──

/** Directory listing result for the file browser. */
export type BrowseResult = {
  path: string;
  parent: string | null;
  dirs: string[];
  files?: string[];
};

/** A single file search hit within a workspace. */
export type FileSearchHit = {
  path: string;
  name: string;
  parent: string;
};

/** Result of a workspace file search. */
export type FileSearchResponse = {
  available: boolean;
  provider: "everything" | "none";
  installHint?: string;
  results: FileSearchHit[];
};

// ── Notes ──

export type NoteListItem = {
  id: string;
  title: string;
  created: string | null;
  updated: string | null;
  tags: string[];
  preview: string;
};

export type NoteDetail = {
  id: string;
  title: string;
  created?: string;
  updated?: string;
  tags?: string[];
  content?: string;
};

// ── Prompts ──

/** An input field definition for a prompt template. */
export type PromptInput = {
  name: string;
  type?: "text" | "toggle" | "select";
  placeholder?: string;
  required?: boolean;
  default?: string;
  options?: string[];
};

/**
 * A registered prompt template -- a reusable Handlebars template with inputs, optional profile binding,
 * and provider/model overrides.
 */
export type PromptListItem = {
  name: string;
  label: string;
  description?: string;
  icon?: string;
  /** Agent profile to use when this prompt is invoked. */
  profile?: string;
  inputs?: PromptInput[];
  /** Provider/model/effort overrides applied when this prompt is used. */
  settings?: {
    provider?: string;
    model?: string;
    effort?: string;
    cwd?: string;
  };
  tags?: string[];
  /** Where the prompt was loaded from (e.g. "harness", "project", file path). */
  source: string;
};

/** Result of rendering a prompt template with provided input values. */
export type RenderResult = {
  /** The fully rendered prompt text. */
  rendered: string;
  config: {
    label: string;
    profile?: string;
    settings?: PromptListItem["settings"];
  };
};

// ── Activity / Analytics ──

/** A timestamped activity log entry for the audit trail (stored in activity.db). */
export type ActivityEntry = {
  id?: number;
  eventType: string;
  summary?: string;
  sessionId?: string;
  agentProfile?: string;
  userProfile?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ActivitySummaryResult = {
  [key: string]: unknown;
};

/** Token and cost usage bucket used as a building block in analytics rollups. */
export type UsageBucket = {
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

export type ProviderUsageTotal = UsageBucket & { provider: string };
export type ModelUsageTotal = UsageBucket & { provider: string; model: string };
export type ProviderUsageDaily = UsageBucket & { day: string; provider: string };

/** Provider usage analytics over a sliding window, broken down by provider, model, and day. */
export type ProviderUsageAnalytics = {
  /** Number of days in the analysis window. */
  windowDays: number;
  totals: UsageBucket;
  providers: ProviderUsageTotal[];
  models: ModelUsageTotal[];
  daily: ProviderUsageDaily[];
};

/** A single row in deep analytics breakdown tables (by provider, model, profile, or project). */
export type DeepAnalyticsMetricRow = {
  key: string;
  sessions: number;
  userMessages: number;
  assistantMessages: number;
  assistantTurns: number;
  toolCalls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

/** A time-bucketed slice of deep analytics (e.g. hourly or daily). */
export type DeepAnalyticsBucket = {
  /** Epoch ms for bucket start. */
  start: number;
  /** Epoch ms for bucket end. */
  end: number;
  sessionsStarted: number;
  userMessages: number;
  assistantMessages: number;
  assistantTurns: number;
  toolCalls: number;
  totalDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  /** Number of file touches in this time bucket. */
  touches: number;
};

/** Hour-of-day activity distribution for deep analytics. */
export type DeepAnalyticsHourRow = {
  /** 0-23 hour of day. */
  hour: number;
  userMessages: number;
  assistantTurns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

/** Per-session row in deep analytics, with full cost/token/touch breakdown. */
export type DeepAnalyticsSessionRow = {
  id: string;
  preview: string;
  profile: string | null;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  createdAt: number;
  lastMessageAt: number;
  totalMessages: number;
  totalCost: number;
  userMessages: number;
  assistantMessages: number;
  assistantTurns: number;
  toolCalls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Number of file touches attributed to this session. */
  touches: number;
};

/**
 * Full deep analytics response combining time-series buckets, dimension breakdowns,
 * per-session details, and file touch trace data.
 */
export type DeepAnalytics = {
  range: {
    start: number;
    end: number;
    /** Bucket width in milliseconds. */
    bucketMs: number;
    bucketCount: number;
  };
  totals: {
    sessionsStarted: number;
    sessionsActive: number;
    userMessages: number;
    assistantMessages: number;
    assistantTurns: number;
    toolCalls: number;
    totalDurationMs: number;
    avgDurationMs: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
  };
  buckets: DeepAnalyticsBucket[];
  byProvider: DeepAnalyticsMetricRow[];
  byModel: DeepAnalyticsMetricRow[];
  byProfile: DeepAnalyticsMetricRow[];
  byProject: DeepAnalyticsMetricRow[];
  byHour: DeepAnalyticsHourRow[];
  sessions: DeepAnalyticsSessionRow[];
  /** File touch trace data -- which files agents read/wrote and how often. */
  trace: {
    summary: {
      total: number;
      byOp: Record<string, number>;
      byConfidence: Record<string, number>;
      byProvider: Record<string, number>;
      byFileKind: Record<string, number>;
      uniqueFiles: number;
      uniqueSessions: number;
    };
    topFiles: Array<{
      filePath: string;
      fileKind: "code" | "docs";
      touches: number;
      sessions: number;
      lastTouched: number;
      provider: string | null;
    }>;
  };
};

// ── Client Extensions ──

/** Schema for a single setting exposed by a client extension. */
export type ExtensionSettingSchema = {
  type: "string" | "number" | "boolean" | "select";
  label: string;
  description?: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
};

/** Metadata declared by a client extension module (name, description, configurable settings). */
export type ExtensionMeta = {
  name?: string;
  description?: string;
  settings?: Record<string, ExtensionSettingSchema>;
};

/** A discovered client extension with its resolution source, enabled state, and current settings. */
export type ClientExtensionManifestItem = {
  id: string;
  fileName: string;
  /** Whether this extension was found in the project's .modus/ or in the global harness config. */
  source: "project" | "global";
  enabled: boolean;
  /** URL to dynamically import the extension module in the browser. */
  moduleUrl: string;
  meta: ExtensionMeta;
  settingsValues: Record<string, unknown>;
};

// ── Memory ──

/** A single memory item from the agent memory store. */
export type MemoryItem = {
  id: string;
  type: string;
  tags: string[];
  confidence: string;
  created: string;
  profile: string | null;
  user_profile: string | null;
  priority: number;
  body: string;
};

// ── Project UI ──

/** Metadata for a registered UI asset (theme or font file). */
export type ProjectUiAssetInfo = {
  id: string;
  label: string;
  /** Relative file path within the asset directory. */
  file: string;
  createdAt: string;
  archived: boolean;
  source?: string;
  notes?: string;
  updatedAt?: string;
  /** Whether this asset is currently active (applied to the UI). */
  active: boolean;
  absolutePath: string;
};

/** An active (applied) UI asset with its resolved CSS content and extracted variables. */
export type ActiveProjectUiAsset = {
  id: string;
  label: string;
  file: string;
  /** Path to the processed/active version of the file. */
  activeFile: string;
  /** Raw CSS content to inject into the document. */
  css: string;
  /** CSS custom properties extracted from the asset. */
  variables: Record<string, string>;
};

/** Current project UI state -- registered themes/fonts and which ones are active. */
export type ProjectUiState = {
  themes: ProjectUiAssetInfo[];
  fonts: ProjectUiAssetInfo[];
  activeTheme: ActiveProjectUiAsset | null;
  activeFont: ActiveProjectUiAsset | null;
};

// ── Projects / Init ──

/** Whether a project directory has been initialized with .modus/ scaffolding. */
export type InitStatus = {
  initialized: boolean;
  projectId: string | null;
  /** Whether this project is registered in the harness's project registry. */
  registered: boolean;
  meta: { id: string; name?: string; created?: string } | null;
  /** Whether the registered path matches the current path (detects moved projects). */
  pathMatch: boolean;
};

/** Result of initializing a project directory with .modus/ scaffolding. */
export type InitResult = {
  ok: true;
  projectId: string;
  /** Files/directories that were created. */
  created: string[];
  /** Files/directories that already existed and were skipped. */
  skipped: string[];
  alreadyInitialized: boolean;
};

export type ProjectInfo = {
  id: string;
  name: string;
  path: string;
  created: string;
  pathExists: boolean;
};

// ── Trace ──

/**
 * A file touch record from the attention trace system -- tracks which files an agent
 * read, wrote, or referenced during a session, with confidence levels.
 */
export type TouchRecord = {
  sessionId: string;
  seq: number;
  timestamp: number;
  provider: string | null;
  cwd: string | null;
  filePath: string;
  fileKind: "code" | "docs";
  /** What operation was performed on the file. */
  op: "read" | "write" | "edit" | "grep" | "glob" | "ls" | "command" | "mention";
  /** How reliably the file reference was identified: "explicit" (tool input), "derived" (parsed from output), "heuristic" (pattern match). */
  confidence: "explicit" | "derived" | "heuristic";
  toolName: string;
};

/** Aggregate summary of file touches across sessions. */
export type TouchSummary = {
  total: number;
  byOp: Record<string, number>;
  byConfidence: Record<string, number>;
  byProvider: Record<string, number>;
  byFileKind: Record<string, number>;
  uniqueFiles: number;
  uniqueSessions: number;
};

/** Response from the file touch query endpoint, containing individual records and an aggregate summary. */
export type TouchesResponse = {
  touches: TouchRecord[];
  summary: TouchSummary;
};

/** Filter parameters for querying file touch records. All fields are optional and combined with AND. */
export type TouchQuery = {
  limit?: number;
  userProfile?: string;
  cwd?: string;
  /** Epoch ms lower bound (inclusive). */
  from?: number;
  /** Epoch ms upper bound (inclusive). */
  to?: number;
  /** Filter by operation types (e.g. ["read", "write"]). */
  ops?: string[];
  /** Filter by confidence levels (e.g. ["explicit"]). */
  confidence?: string[];
  sessionId?: string;
};

// ── Terminals ──

/** Info about a managed terminal (PTY) instance. */
export type TerminalInfo = {
  id: string;
  shell: string;
  cwd: string | null;
  cols: number;
  rows: number;
  /** If this terminal is bound to a session, the session ID. */
  sessionId: string | null;
  sessionOriginId?: string | null;
  kind?: string;
  ownerType?: string | null;
  ownerName?: string | null;
  provider?: string | null;
  interactive?: boolean;
  pid?: number | null;
  stopMode?: "terminate" | "delegate" | "observe";
  canStop?: boolean;
  canRestart?: boolean;
  createdAt: number;
  lastOutputAt?: number | null;
  /** Number of WebSocket clients connected to this terminal. */
  clients?: number;
  status?: string;
};

/** Options for creating a new managed terminal instance. */
export type CreateTerminalOpts = {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Bind this terminal to a session for context association. */
  sessionId?: string;
  kind?: string;
  ownerType?: string;
  ownerName?: string;
  provider?: string;
  interactive?: boolean;
};

// ── Process Registry ──

export type ProcessKind = "orchestrator" | "worker" | "session" | "terminal";

/** A managed process (agent session, mission worker, terminal) tracked by the harness. */
export type ProcessInfo = {
  id: string;
  kind: ProcessKind;
  status: string;
  profile: string | null;
  provider: string;
  model: string | null;
  costUsd: number;
  numTurns: number;
  startedAt: number;
  lastEventAt: number;
  preview: string;
  cwd: string | null;
  mission: {
    runId: number;
    missionName: string;
    role: string;
    currentCycle: number;
    runStatus: string;
  } | null;
  activeMoves: string[];
  subscribers: number;
  canKill: boolean;
};

/** Snapshot of all managed processes at a point in time. */
export type ProcessSnapshot = {
  timestamp: number;
  processes: ProcessInfo[];
  summary: {
    total: number;
    byKind: Record<string, number>;
    totalCostUsd: number;
    missionRuns: number;
  };
};

// ── Web Positions ──

/** Saved position of a UI node in the web/canvas view (e.g. draggable panels). */
export type WebPosition = {
  nodeId: string;
  x: number;
  y: number;
  pinned: boolean;
};

// ── Filesystem Events ──

/** A filesystem change notification from the harness's directory watcher. */
export type FsChangeEvent = {
  dir: string;
  kind: "add" | "remove" | "modify" | "unknown";
  entry: string | null;
};
