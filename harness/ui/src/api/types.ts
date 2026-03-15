// ── Tool Calls ──

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result?: string;
  startedAt: number;
  duration?: number;
  /** For Agent tool calls: the SDK task ID (used for stopTask) */
  taskId?: string;
  /** For Agent tool calls: nested sub-agent messages */
  subMessages?: Message[];
  /** For Agent tool calls: sub-agent summary from task_notification */
  subSummary?: string;
};

// ── Sub-agent Tasks ──

export type SubTask = {
  taskId: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  lastToolName?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
};

// ── Attachments ──

export type Attachment = {
  type: "image";
  mediaType: string; // e.g. "image/png", "image/jpeg"
  data: string;      // base64-encoded
  name?: string;     // original filename if available
};

export type SessionArtifact = {
  id: number;
  sessionId: string;
  seq: number;
  targetMessageUuid?: string;
  name: string;
  mime: string;
  url: string;
  sourceAction?: string;
  createdAt: number;
  previewText?: string;
  metadata?: Record<string, unknown>;
};

// ── Messages ──

let _msgId = 0;
export function nextMsgId(): string { return `m${++_msgId}`; }

export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  uuid?: string;
  thinking?: string;
  thinkingDuration?: number;
  toolCalls?: ToolCall[];
  attachments?: Attachment[];
  artifacts?: SessionArtifact[];
  /** Event seq (user prompt or result event) — used as branch point */
  seq?: number;
  /** Epoch ms timestamp from the event's created_at */
  timestamp?: number;
  meta?: {
    cost?: number;
    duration?: number;
    model?: string;
    turns?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  /** Aggregated full-turn content for copy button. Set on result event. */
  turnCopy?: { text: string; thinking?: string; toolCalls?: ToolCall[] };
};

// ── Permission Requests ──

export type PendingPermission = {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseID?: string;
  interactive: boolean; // true = AskUserQuestion (needs user input, not just approve/deny)
  decisionReason?: string;
  requestedAt: number;
};

// ── Session Status ──

export type SessionStatus = "starting" | "running" | "idle" | "done" | "error";

export type AgentConfigState = {
  toolStates: Record<string, "inherit" | "on" | "off">;
  model: string;
  provider: string;
  effort: string;
  maxTurns: string;
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

export type Session = {
  id: string;
  status: SessionStatus;
  preview: string;
  profile?: string;
  provider?: string;
  nextProfile?: string;
  nextAgentConfig?: AgentConfigState;
  model?: string;
  agentConfig: AgentConfigState;
  cwd?: string;
  additionalDirectories?: string[];
  loadProjectSettings?: boolean;
  messages: Message[];
  totalCost: number;
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
  activeToolName?: string;
  activeToolElapsed?: number;
  /** All tools reported by SDK init (built-in + MCP) */
  availableTools?: string[];
  /** Pending permission requests awaiting user response */
  pendingPermissions?: PendingPermission[];
  /** Rolling feed of recent stream content for noise display */
  streamFeed?: string;
};

// ── API Types ──

export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export type ProfileUi = {
  label?: string;
  showThinking?: boolean;
  showMeta?: boolean;
  showToolCalls?: boolean;
  showGitEvents?: boolean;
  placeholder?: string;
  emptyTitle?: string;
  emptySubtitle?: string;
  panelWidgets?: string[];
};

export type Profile = {
  name: string;
  description: string;
  prompt: string;
  promptMode?: "custom" | "append";
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  tools?: string[] | "all";
  disallowedTools?: string[];
  loadProjectSettings?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  ui?: ProfileUi;
};

export type GlobalConfig = {
  mcpServers?: Record<string, McpServerConfig>;
  clientExtensions?: {
    paths?: string[];
    enabled?: string[];
    disabled?: string[];
  };
};

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
  action_name: string | null;
  tags: string;
  last_input_tokens?: number | null;
  last_output_tokens?: number | null;
};

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
  seq: number;
  subscribers: number;
  cwd: string | null;
  additionalDirectories: string[] | null;
  archived?: boolean;
};

export type SearchHit = {
  session_id: string;
  preview: string;
  profile: string | null;
  model: string | null;
  cwd: string | null;
  last_message_at: number;
  total_cost_usd: number;
  snippet: string;
};

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
  commitAttribution?: CommitAttribution;
};

export type CommitAttributionReason =
  | "no-session-cwd"
  | "no-file-touches"
  | "no-nearby-commit"
  | "no-file-overlap";

export type CommitAttribution = {
  matched: boolean;
  commit?: GitCommit;
  matchedFiles?: string[];
  source?: "session";
  reason?: CommitAttributionReason;
};

export type ApiAttachment = {
  type: "image";
  mediaType: string;
  data: string;
  name?: string;
};

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
  sessionId?: string;
};

export type BrowseResult = {
  path: string;
  parent: string | null;
  dirs: string[];
};

export type PermissionResponse = {
  requestId: string;
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
  scope?: "once" | "session";
};

export type ProviderToolGroup = {
  label: string;
  tools: string[];
};

export type ProviderCapabilities = {
  name: string;
  label: string;
  family: "claude-code" | "codex" | "gemini-cli" | "pi-agent";
  builtInTools: string[];
  builtInToolGroups: ProviderToolGroup[];
  builtInToolMode: "explicit" | "event-derived";
  supportsMcp: boolean;
  mcpSupport: "full" | "stdio-only" | "none";
  nonToolSignals: string[];
  permissionModel: {
    mode: "per-tool-ui" | "runtime-native" | "none";
    interactive: boolean;
    summary: string;
  };
  sessionMutability: {
    providerSwitchAfterStart: boolean;
    profileSwitch: "allowed" | "provider-locked";
    configApplies: "immediate" | "next-turn";
  };
};

export type UserProfileState = {
  sidebarGroupMode?: "time" | "agent";
  sidebarCollapsedGroups?: string[];
  sidebarConfigExpanded?: boolean;
  lastAgentProfile?: string;
  lastCwd?: string;
  lastSessionId?: string | null;
};

export type UserProfile = {
  name: string;
  displayName: string;
  templateVars?: Record<string, string>;
  projects: string[];
  agentProfiles?: string[];
  defaultAgentProfile?: string;
  provider?: string;
  model?: string;
  effort?: string;
  memoryFilter?: string;
  /** Show project paths from ALL user profiles in the CWD picker */
  showAllProjectPaths?: boolean;
  /** Dashboard widget layout */
  dashboard?: {
    widgets?: Array<{ type: string; [key: string]: unknown }>;
    pages?: Array<{
      id: string;
      title: string;
      blocks: Array<
        | { kind: "widget"; widget: { type: string; [key: string]: unknown } }
        | { kind: "module"; module: "memory" | "actions" | "git"; [key: string]: unknown }
        | { kind: "text"; markdown: string; [key: string]: unknown }
      >;
    }>;
  };
  /** Computer/machine name — displayed in top-nav status bar */
  computer?: string;
  /** Preferred editor CLI command for "open in editor" */
  editor?: string;
  clientExtensions?: {
    paths?: string[];
    enabled?: string[];
    disabled?: string[];
  };
};

export type ClientExtensionManifestItem = {
  id: string;
  fileName: string;
  source: "project" | "global";
  enabled: boolean;
  moduleUrl: string;
};

export type ProjectUiAssetInfo = {
  id: string;
  label: string;
  file: string;
  createdAt: string;
  archived: boolean;
  source?: string;
  notes?: string;
  updatedAt?: string;
  active: boolean;
  absolutePath: string;
};

export type ActiveProjectUiAsset = {
  id: string;
  label: string;
  file: string;
  activeFile: string;
  css: string;
  variables: Record<string, string>;
};

export type ProjectUiState = {
  themes: ProjectUiAssetInfo[];
  fonts: ProjectUiAssetInfo[];
  activeTheme: ActiveProjectUiAsset | null;
  activeFont: ActiveProjectUiAsset | null;
};

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

export type ActionTrigger =
  | { type: "interval"; every: string; from?: "completion" | "start"; activeHours?: { start: string; end: string } }
  | { type: "webhook"; token?: string }
  | { type: "manual" }
  | { type: "action"; source: string; condition: "any" | "done" | "error" };

export type ArtifactSpec = {
  name: string;
  mime: string;
  required?: boolean;
};

export type NotifySpec = {
  on: string | string[];
  channel: string;
  message?: string;
};

export type ActionInfo = {
  name: string;
  description: string;
  origin?: "harness" | "project";
  agentProfile: string;
  trigger: ActionTrigger;
  cycleInterval?: string;
  enabled: boolean;
  maxTurns?: number;
  maxRuns?: number;
  maxCycles?: number;
  maxRetries?: number;
  onGatherError?: "fail" | "retry";
  maxTransientRetries?: number;
  onTransientFailure?: "retry" | "skip";
  artifacts?: ArtifactSpec[];
  notify?: NotifySpec[];
  tags?: string[];
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  running: boolean;
  cycleNumber: number;
  cycleRunCount: number;
  exhausted: boolean;
};

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
  afterRunError: string | null;
  attempts?: number;
  verifyError?: string | null;
};

export type GitStatus = {
  git: boolean;
  branch?: string;
  remote?: string;
  ahead?: number;
  behind?: number;
  files?: { modified: string[]; staged: string[]; untracked: string[] };
};

export type GitCommit = {
  hash: string;
  date: string;
  message: string;
  author: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
};

export type DiffLine = {
  type: "add" | "del" | "ctx";
  content: string;
  oldNum: number | null;
  newNum: number | null;
};

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

export type EventStreamCallbacks = {
  onEvent: (event: any, seq: number) => void;
  onDone: () => void;
  /** Stream closed without server sending "done" — likely network drop */
  onDisconnect?: () => void;
  onError: (error: string) => void;
};
