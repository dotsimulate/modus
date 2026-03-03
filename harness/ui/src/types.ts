// ── Tool Calls ──

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputStr: string;
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

// ── Messages ──

let _msgId = 0;
export function nextMsgId(): string { return `m${++_msgId}`; }

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  subTasks?: SubTask[];
  meta?: {
    cost?: number;
    duration?: number;
    model?: string;
    turns?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
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
};
