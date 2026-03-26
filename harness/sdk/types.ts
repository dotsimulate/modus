// ── ModusClient SDK Types ──

export type ModusClientOptions = {
  url: string;
  token?: string;
  pin?: string;
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
};

export type CreateSessionOpts = {
  prompt: string;
  profile?: string;
  userProfile?: string;
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  cwd?: string;
  tools?: string[];
  disallowedTools?: string[];
  toolStates?: Record<string, "inherit" | "on" | "off">;
  providerControls?: Record<string, unknown>;
  loadProjectSettings?: boolean;
  sessionId?: string;
  attachments?: Attachment[];
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

// ── Profiles ──

export type Profile = {
  name: string;
  description: string;
  prompt: string;
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  tools?: string[] | "all";
  disallowedTools?: string[];
  cwd?: string;
};

// ── Permission Response ──

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

export type ActionSummary = {
  name: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  schedule?: string;
  tags?: string[];
  [key: string]: unknown;
};

export type ActionDetail = {
  name: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  schedule?: string;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  lastStatus?: string | null;
  running?: boolean;
  [key: string]: unknown;
};

export type ActionRun = {
  id?: number;
  action_name?: string;
  session_id?: string;
  status?: string;
  started_at?: number;
  finished_at?: number | null;
  [key: string]: unknown;
};

export type ActionExecution = {
  id?: number;
  action_name?: string;
  status?: string;
  started_at?: number;
  [key: string]: unknown;
};

export type ActionInfo = {
  contextSource: string;
  configSource: string;
};

// ── Moves ──

export type MoveListItem = {
  name: string;
  label: string;
  description: string;
  origin?: "harness" | "project";
  icon?: string;
  mode?: "inline" | "branch" | "background";
  persistent?: boolean;
  inputs?: { name: string; label?: string; type: string; required?: boolean; default?: unknown }[];
  tags?: string[];
};

export type ActivateMoveResult = {
  token: string;
  mode: "inline" | "branch" | "background" | "persistent";
  spawnedSessionId?: string;
  prompt?: string;
  moveRunId: number;
  apiToken?: string;
  instanceId?: string;
};

export type MoveDetail = MoveListItem & {
  widget?: { component?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export type AttachMoveResult = {
  apiToken: string;
  moveRunId: number;
  instanceId?: string;
  sessionId?: string;
  [key: string]: unknown;
};

export type AmbientMoveInfo = {
  moveName: string;
  activatedAt: number;
  inputs?: Record<string, unknown>;
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

export type MissionSummary = {
  name: string;
  label?: string;
  description?: string;
  [key: string]: unknown;
};

export type MissionDetail = MissionSummary & {
  steps?: unknown[];
  [key: string]: unknown;
};

export type MissionRunSummary = {
  id: number;
  mission_name?: string;
  status?: string;
  started_at?: number;
  finished_at?: number | null;
  [key: string]: unknown;
};

export type MissionStepSummary = {
  id?: number;
  step_name?: string;
  status?: string;
  [key: string]: unknown;
};

export type MissionTransferSummary = {
  id?: number;
  from_step?: string;
  to_step?: string;
  [key: string]: unknown;
};

export type MissionGateResultSummary = {
  id?: number;
  gate_name?: string;
  passed?: boolean;
  [key: string]: unknown;
};

// ── User Profiles ──

export type UserProfile = {
  name: string;
  label?: string;
  projects?: string[];
  agentProfiles?: string[];
  actions?: string[];
  [key: string]: unknown;
};

// ── Providers ──

export type ProviderInfo = {
  name: string;
  label?: string;
  [key: string]: unknown;
};

export type ProviderCapability = {
  name: string;
  [key: string]: unknown;
};

export type ProviderHealth = {
  name: string;
  healthy?: boolean;
  [key: string]: unknown;
};

// ── Git ──

export type GitStatusResult = {
  branch?: string;
  clean?: boolean;
  files?: { path: string; status: string }[];
  [key: string]: unknown;
};

export type GitLogEntry = {
  hash: string;
  message: string;
  author?: string;
  date?: string;
  [key: string]: unknown;
};

export type GitShowResult = {
  hash: string;
  message: string;
  author?: string;
  date?: string;
  diff?: string;
  files?: string[];
  [key: string]: unknown;
};

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

export type PromptListItem = {
  name: string;
  label?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
};

// ── Activity ──

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
