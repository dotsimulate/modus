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
