// ── ModusClient SDK Types ──

export type ModusClientOptions = {
  url: string;
  token?: string;
  pin?: string;
  /** If provided, used instead of PIN-based auth. For browser usage with localStorage tokens. */
  getToken?: () => string | undefined;
};

// ── Interact ──

export type MoveBinding = {
  name: string;
  inputs?: Record<string, unknown>;
};

export type InteractOptions = {
  sessionId?: string;
  prompt: string;
  profile?: string;
  userProfile?: string;
  provider?: string;
  model?: string;
  effort?: "off" | "low" | "medium" | "high" | "max";
  maxTurns?: number;
  moves?: MoveBinding[];
  cwd?: string;
  additionalDirectories?: string[];
  tools?: string[];
  disallowedTools?: string[];
  toolStates?: Record<string, "inherit" | "on" | "off">;
  providerControls?: Record<string, unknown>;
  loadProjectSettings?: boolean;
  permissionMode?: "bypass" | "interactive";
  subscribe?: boolean;
  createIfMissing?: boolean;
  attachments?: Attachment[];
};

export type Attachment = {
  type: "image";
  mediaType: string;
  data: string;
  name?: string;
};

export type InteractResult = {
  sessionId: string;
  status: string;
};

// ── Tool Calls ──

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result?: string;
  startedAt: number;
  duration?: number;
  taskId?: string;
  subMessages?: Message[];
  subSummary?: string;
};

export type SubTask = {
  taskId: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  lastToolName?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
};

// ── Attachments (API wire format) ──

export type ApiAttachment = {
  type: "image";
  mediaType: string;
  data: string;
  name?: string;
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
  seq?: number;
  timestamp?: number;
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
  turnCopy?: { text: string; thinking?: string; toolCalls?: ToolCall[] };
};

// ── Permission Requests ──

export type PendingPermission = {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseID?: string;
  interactive: boolean;
  decisionReason?: string;
  requestedAt: number;
};

export type PermissionResponse = {
  requestId: string;
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
  scope?: "once" | "session";
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
  totalInputTokens: number;
  totalOutputTokens: number;
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
  activeToolName?: string;
  activeToolElapsed?: number;
  availableTools?: string[];
  pendingPermissions?: PendingPermission[];
  streamFeed?: string;
};

// ── Sessions ──

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

export type SendMessageOpts = {
  prompt: string;
  profile?: string;
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  moves?: MoveBinding[];
  cwd?: string;
  tools?: string[];
  disallowedTools?: string[];
  attachments?: Attachment[];
};

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

// ── Events ──

export type SSEEvent = {
  event: string;
  data: Record<string, unknown>;
  seq: number;
};

export type EventStreamHandle = {
  events: AsyncIterable<SSEEvent>;
  abort: () => void;
};

export type EventStreamCallbacks = {
  onEvent: (event: any, seq: number) => void;
  onDone: () => void;
  onDisconnect?: () => void;
  onError: (error: string) => void;
};

// ── Session Stats ──

export type SessionStats = {
  totals: { sessions: number; cost: number; messages: number; firstSession: number | null; lastSession: number | null };
  byProject: { project: string; sessions: number; cost: number; messages: number }[];
  byProfile: { profile: string; sessions: number; cost: number; messages: number }[];
  byModel: { model: string; sessions: number; cost: number }[];
  daily: { day: string; sessions: number; cost: number }[];
  topSessions: { id: string; preview: string; cost: number; messages: number; profile: string | null; cwd: string | null }[];
};

// ── Account ──

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
  cwd?: string;
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  tools?: string[] | "all";
  disallowedTools?: string[];
  loadProjectSettings?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  ui?: ProfileUi;
  cwdSuggestions?: string[];
};

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

export type ProviderToolGroup = {
  label: string;
  tools: string[];
};

export type ProviderCapabilities = {
  name: string;
  label: string;
  family: "claude-code" | "codex" | "cursor" | "gemini-cli" | "pi-agent";
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

export type ProviderHealthCheck = {
  type: "cli" | "env" | "local" | "auth";
  label: string;
  passed: boolean;
  detail?: string;
};

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

export type UserProfileUiConfig = {
  dashboard?: {
    widgets?: Array<{ type: string; [key: string]: unknown }>;
    pages?: Array<{
      id: string;
      title: string;
      blocks: Array<
        | { kind: "widget"; widget: { type: string; [key: string]: unknown } }
        | { kind: "module"; module: "actions" | "git"; [key: string]: unknown }
        | { kind: "text"; markdown: string; [key: string]: unknown }
      >;
    }>;
  };
  leftPanel?: {
    widgets?: string[];
  };
  computer?: string;
  editor?: string;
  clientExtensions?: {
    paths?: string[];
    enabled?: string[];
    disabled?: string[];
    settings?: Record<string, Record<string, unknown>>;
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
  showAllProjectPaths?: boolean;
  dashboard?: {
    widgets?: Array<{ type: string; [key: string]: unknown }>;
    pages?: Array<{
      id: string;
      title: string;
      blocks: Array<
        | { kind: "widget"; widget: { type: string; [key: string]: unknown } }
        | { kind: "module"; module: "actions" | "git"; [key: string]: unknown }
        | { kind: "text"; markdown: string; [key: string]: unknown }
      >;
    }>;
  };
  leftPanel?: {
    widgets?: string[];
  };
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

export type PermissionResponseOpts = {
  requestId: string;
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

export type BranchResult = {
  sessionId: string;
};

// ── Actions ──

export type ActionTrigger =
  | { type: "interval"; every: string; from?: "completion" | "start"; activeHours?: { start: string; end: string } }
  | { type: "webhook"; token?: string }
  | { type: "manual" }
  | { type: "action"; source: string; condition: "any" | "done" | "error" };

export type ActionSummary = ActionInfo;

export type ActionDetail = ActionInfo;

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
  concurrency?: number;
  notify?: Array<{ channel: string; on: string | string[] }>;
  artifacts?: Array<{ name: string; mime: string; required?: boolean }>;
  tags?: string[];
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  running: boolean;
  activeSessions: number;
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

export type ActionExecution = {
  id?: number;
  action_name?: string;
  status?: string;
  started_at?: number;
  [key: string]: unknown;
};

// ── Moves ──

export type MoveInput = {
  name: string;
  label?: string;
  type: "text" | "textarea" | "select" | "toggle" | "number";
  options?: string[] | string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
};

export type MovePageInfo = {
  id: string;
  title: string;
  icon?: string;
  nav?: boolean;
};

export type MoveListItem = {
  name: string;
  label: string;
  description: string;
  origin?: "harness" | "project";
  icon?: string;
  mode?: "inline" | "branch" | "background";
  persistent?: boolean;
  inputs?: MoveInput[];
  tags?: string[];
  widget?: { mountOnAttach?: boolean };
  page?: MovePageInfo;
};

export type MoveWidgetInfo = {
  label: string;
  icon?: string;
  autoOpen?: boolean;
  mountOnAttach?: boolean;
  moduleUrl: string;
  moveName: string;
  cache?: "instance" | "module" | "none";
};

export type ActivateMoveResult = {
  token: string;
  mode: "inline" | "branch" | "background" | "persistent";
  persistent?: boolean;
  spawnedSessionId?: string;
  prompt?: string;
  moveRunId: number;
  apiToken?: string;
  instanceId?: string;
  widget?: MoveWidgetInfo;
};

export type MoveDetail = MoveListItem & {
  widget?: { component?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export type AttachMoveResult = {
  apiToken: string;
  instanceId: string;
  widget: MoveWidgetInfo;
};

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
export type MissionTransferKind = "delegation" | "report" | "review" | "escalation";

export type MissionSummary = MissionListItem;

export type MissionListItem = {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  stepCount: number;
  roles: string[];
  tags: string[];
};

export type MissionDetail = MissionSummary & {
  steps?: unknown[];
  [key: string]: unknown;
};

export type MissionRunSummary = {
  id: number;
  missionName: string;
  status: MissionRunStatus;
  currentStepIndex: number;
  haltKind: string | null;
  haltMessage: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type MissionStepSummary = MissionStepRunSummary;

export type MissionStepRunSummary = {
  id: number;
  stepId: string;
  stepOrder: number;
  role: string;
  title: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
};

export type MissionTransferSummary = {
  id: number;
  stepId: string;
  fromSessionId: string | null;
  toSessionId: string | null;
  kind: MissionTransferKind;
  summary: string | null;
  createdAt: number;
};

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

export type GitShowResult = GitCommitDetail;

// ── Files ──

export type BrowseResult = {
  path: string;
  parent: string | null;
  dirs: string[];
  files?: string[];
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

export type PromptInput = {
  name: string;
  type?: "text" | "toggle" | "select";
  placeholder?: string;
  required?: boolean;
  default?: string;
  options?: string[];
};

export type PromptListItem = {
  name: string;
  label: string;
  description?: string;
  icon?: string;
  profile?: string;
  inputs?: PromptInput[];
  settings?: {
    provider?: string;
    model?: string;
    effort?: string;
    cwd?: string;
  };
  tags?: string[];
  source: string;
};

export type RenderResult = {
  rendered: string;
  config: {
    label: string;
    profile?: string;
    settings?: PromptListItem["settings"];
  };
};

// ── Activity / Analytics ──

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

export type ProviderUsageAnalytics = {
  windowDays: number;
  totals: UsageBucket;
  providers: ProviderUsageTotal[];
  models: ModelUsageTotal[];
  daily: ProviderUsageDaily[];
};

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

export type DeepAnalyticsBucket = {
  start: number;
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
  touches: number;
};

export type DeepAnalyticsHourRow = {
  hour: number;
  userMessages: number;
  assistantTurns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

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
  touches: number;
};

export type DeepAnalytics = {
  range: {
    start: number;
    end: number;
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

export type ExtensionSettingSchema = {
  type: "string" | "number" | "boolean" | "select";
  label: string;
  description?: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
};

export type ExtensionMeta = {
  name?: string;
  description?: string;
  settings?: Record<string, ExtensionSettingSchema>;
};

export type ClientExtensionManifestItem = {
  id: string;
  fileName: string;
  source: "project" | "global";
  enabled: boolean;
  moduleUrl: string;
  meta: ExtensionMeta;
  settingsValues: Record<string, unknown>;
};

// ── Memory ──

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

// ── Projects / Init ──

export type InitStatus = {
  initialized: boolean;
  projectId: string | null;
  registered: boolean;
  meta: { id: string; name?: string; created?: string } | null;
  pathMatch: boolean;
};

export type InitResult = {
  ok: true;
  projectId: string;
  created: string[];
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

export type TouchRecord = {
  sessionId: string;
  seq: number;
  timestamp: number;
  provider: string | null;
  cwd: string | null;
  filePath: string;
  fileKind: "code" | "docs";
  op: "read" | "write" | "edit" | "grep" | "glob" | "ls" | "command" | "mention";
  confidence: "explicit" | "derived" | "heuristic";
  toolName: string;
};

export type TouchSummary = {
  total: number;
  byOp: Record<string, number>;
  byConfidence: Record<string, number>;
  byProvider: Record<string, number>;
  byFileKind: Record<string, number>;
  uniqueFiles: number;
  uniqueSessions: number;
};

export type TouchesResponse = {
  touches: TouchRecord[];
  summary: TouchSummary;
};

export type TouchQuery = {
  limit?: number;
  userProfile?: string;
  cwd?: string;
  from?: number;
  to?: number;
  ops?: string[];
  confidence?: string[];
  sessionId?: string;
};

// ── Terminals ──

export type TerminalInfo = {
  id: string;
  shell: string;
  cwd: string | null;
  cols: number;
  rows: number;
  sessionId: string | null;
  createdAt: number;
  clients?: number;
  status?: string;
};

export type CreateTerminalOpts = {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  sessionId?: string;
};

// ── Web Positions ──

export type WebPosition = {
  nodeId: string;
  x: number;
  y: number;
  pinned: boolean;
};

// ── Filesystem Events ──

export type FsChangeEvent = {
  dir: string;
  kind: "add" | "remove" | "modify" | "unknown";
  entry: string | null;
};
