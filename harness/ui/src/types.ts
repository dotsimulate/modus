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
};
