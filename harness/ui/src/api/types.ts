// ── Tool Calls ──

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result?: string;
  startedAt: number;
  duration?: number;
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

// ── Messages ──

let _msgId = 0;
export function nextMsgId(): string { return `m${++_msgId}`; }

export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  thinkingDuration?: number;
  toolCalls?: ToolCall[];
  attachments?: Attachment[];
  meta?: {
    cost?: number;
    duration?: number;
    model?: string;
    turns?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
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

// ── Session ──

export type Session = {
  id: string;
  status: SessionStatus;
  preview: string;
  profile?: string;
  model?: string;
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
};

export type SessionInfo = {
  id: string;
  preview: string;
  profile: string | null;
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
};

export type ActiveSessionInfo = {
  id: string;
  status: string;
  profile: string | null;
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
  provider?: string;
  model?: string;
  maxTurns?: number;
  effort?: string;
  cwd?: string;
  tools?: string[];
  disallowedTools?: string[];
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

export type UserProfileState = {
  sidebarGroupMode?: "time" | "project";
  sidebarCollapsedGroups?: string[];
  sidebarConfigExpanded?: boolean;
  lastAgentProfile?: string;
  lastCwd?: string;
};

export type UserProfile = {
  name: string;
  displayName: string;
  templateVars?: Record<string, string>;
  projects: string[];
  agentProfiles?: string[];
  provider?: string;
  memoryFilter?: string;
  /** Show project paths from ALL user profiles in the CWD picker */
  showAllProjectPaths?: boolean;
};

export type MemoryItem = {
  id: string;
  type: string;
  tags: string[];
  confidence: string;
  created: string;
  profile: string | null;
  priority: number;
  body: string;
};

export type ActionTrigger =
  | { type: "interval"; every: string; from?: "completion" | "start"; activeHours?: { start: string; end: string } }
  | { type: "webhook"; token?: string }
  | { type: "manual" }
  | { type: "action"; source: string; condition: "any" | "done" | "error" };

export type ActionInfo = {
  name: string;
  description: string;
  agentProfile: string;
  trigger: ActionTrigger;
  cycleInterval?: string;
  enabled: boolean;
  maxTurns?: number;
  maxRuns?: number;
  maxCycles?: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  running: boolean;
  cycleNumber: number;
  cycleRunCount: number;
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
