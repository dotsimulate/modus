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

export type Message = {
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
