/**
 * Event Reducer — pure function that processes SDK events into view-model state.
 *
 * Given the same sequence of events, produces the same output.
 * Enables deterministic state reconstruction on reconnect.
 */

import type { Message, ToolCall, SubTask, SessionStatus } from "./types";

export type ReducerState = {
  sessionId: string;
  status: SessionStatus;
  model: string;
  messages: Message[];
  totalCost: number;
  numTurns: number;
  lastSeq: number;
  activeToolName?: string;
  activeToolElapsed?: number;
  // Internal accumulators (not displayed directly)
  _streamingText: string;
  _streamingThinking: string;
  _pendingToolCalls: Map<string, ToolCall>;
  _subTasks: Map<string, SubTask>;
};

export function createInitialState(sessionId = ""): ReducerState {
  return {
    sessionId,
    status: "starting",
    model: "",
    messages: [],
    totalCost: 0,
    numTurns: 0,
    lastSeq: 0,
    _streamingText: "",
    _streamingThinking: "",
    _pendingToolCalls: new Map(),
    _subTasks: new Map(),
  };
}

/** Process a single SDK event and return updated state (immutable messages array). */
export function reduceEvent(state: ReducerState, event: any, seq: number): ReducerState {
  const s = { ...state, lastSeq: Math.max(state.lastSeq, seq) };
  const m = typeof event === "string" ? JSON.parse(event) : event;

  switch (m.type) {
    case "system":
      return reduceSystem(s, m);
    case "assistant":
      return reduceAssistant(s, m);
    case "user":
      return reduceUser(s, m);
    case "stream_event":
      return reduceStreamEvent(s, m);
    case "tool_progress":
      return reduceToolProgress(s, m);
    case "tool_use_summary":
      return reduceToolUseSummary(s, m);
    case "result":
      return reduceResult(s, m);
    case "rate_limit_event":
      return s; // could display warning, skip for now
    default:
      return s;
  }
}

// ── System Events ──

function reduceSystem(s: ReducerState, m: any): ReducerState {
  if (m.subtype === "init") {
    return {
      ...s,
      sessionId: m.session_id ?? s.sessionId,
      model: m.model ?? s.model,
      status: "running",
    };
  }
  if (m.subtype === "task_started") {
    const tasks = new Map(s._subTasks);
    tasks.set(m.task_id, {
      taskId: m.task_id,
      description: m.description ?? "",
      status: "running",
      lastToolName: undefined,
    });
    return { ...s, _subTasks: tasks };
  }
  if (m.subtype === "task_progress") {
    const tasks = new Map(s._subTasks);
    const existing = tasks.get(m.task_id);
    if (existing) {
      tasks.set(m.task_id, {
        ...existing,
        lastToolName: m.last_tool_name ?? existing.lastToolName,
        usage: m.usage ?? existing.usage,
      });
    }
    return { ...s, _subTasks: tasks };
  }
  if (m.subtype === "task_notification") {
    const tasks = new Map(s._subTasks);
    const existing = tasks.get(m.task_id);
    if (existing) {
      tasks.set(m.task_id, {
        ...existing,
        status: m.status ?? "completed",
        usage: m.usage ?? existing.usage,
      });
    }
    return { ...s, _subTasks: tasks };
  }
  return s;
}

// ── Assistant Messages ──
// Contains text, thinking, and tool_use content blocks

function reduceAssistant(s: ReducerState, m: any): ReducerState {
  const content = m.message?.content;
  if (!content || !Array.isArray(content)) return s;

  let text = "";
  let thinking = "";
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text) {
      text += block.text;
    }
    if (block.type === "thinking" && block.thinking) {
      thinking = block.thinking;
    }
    if (block.type === "tool_use") {
      const tc: ToolCall = {
        id: block.id,
        name: block.name,
        input: block.input ?? {},
        inputStr: JSON.stringify(block.input ?? {}, null, 2),
        status: "running",
        startedAt: Date.now(),
      };
      toolCalls.push(tc);
      // Track in pending map for result matching
      s._pendingToolCalls.set(block.id, tc);
    }
  }

  // If this assistant message has text content, it's a real response
  // (not just tool invocations). Create or update the message.
  const msgs = [...s.messages];

  if (text || thinking) {
    // Check if last message is an in-progress assistant message
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant" && !last.meta) {
      // Update in-progress message
      msgs[msgs.length - 1] = {
        ...last,
        content: text || last.content,
        thinking: thinking || last.thinking,
        toolCalls: [...(last.toolCalls ?? []), ...toolCalls],
      };
    } else {
      // New assistant message
      msgs.push({
        role: "assistant",
        content: text,
        thinking: thinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    }
  } else if (toolCalls.length > 0) {
    // Tool-only message — attach to last assistant or create new
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant" && !last.meta) {
      msgs[msgs.length - 1] = {
        ...last,
        toolCalls: [...(last.toolCalls ?? []), ...toolCalls],
      };
    } else {
      msgs.push({
        role: "assistant",
        content: "",
        toolCalls,
      });
    }
  }

  // Reset streaming accumulators since we got the full message
  return {
    ...s,
    status: "running",
    messages: msgs,
    _streamingText: "",
    _streamingThinking: "",
  };
}

// ── User Messages (including synthetic tool_result) ──

function reduceUser(s: ReducerState, m: any): ReducerState {
  // Detect synthetic tool_result messages — either flagged or contains tool_result blocks
  const content = m.message?.content;
  const hasToolResults = Array.isArray(content) && content.some((b: any) => b.type === "tool_result");
  if (m.isSynthetic || hasToolResults) {
    if (Array.isArray(content)) {
      const pending = new Map(s._pendingToolCalls);
      const msgs = [...s.messages];

      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const tc = pending.get(block.tool_use_id);
          if (tc) {
            const result = typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "");
            pending.set(block.tool_use_id, {
              ...tc,
              status: block.is_error ? "error" : "completed",
              result: result.slice(0, 2000), // truncate for display
              duration: Date.now() - tc.startedAt,
            });

            // Update the tool call in the message that contains it
            for (let i = msgs.length - 1; i >= 0; i--) {
              const msg = msgs[i];
              if (msg.toolCalls?.some((t) => t.id === block.tool_use_id)) {
                msgs[i] = {
                  ...msg,
                  toolCalls: msg.toolCalls!.map((t) =>
                    t.id === block.tool_use_id ? pending.get(block.tool_use_id)! : t
                  ),
                };
                break;
              }
            }
          }
        }
      }
      return { ...s, messages: msgs, _pendingToolCalls: pending, activeToolName: undefined, activeToolElapsed: undefined };
    }
    return s;
  }

  // Real user message (replayed from session history or new)
  if (m.isReplay) return s; // skip replays — we load from DB

  const text = typeof m.message?.content === "string"
    ? m.message.content
    : JSON.stringify(m.message?.content ?? "");

  // Don't add if it's the same as the last user message (dedup)
  const last = s.messages[s.messages.length - 1];
  if (last?.role === "user" && last.content === text) return s;

  return {
    ...s,
    messages: [...s.messages, { role: "user", content: text }],
  };
}

// ── Stream Events (partial deltas) ──

function reduceStreamEvent(s: ReducerState, m: any): ReducerState {
  const evt = m.event;
  if (!evt) return s;

  if (evt.type === "content_block_delta" && evt.delta) {
    if (evt.delta.type === "text_delta" && evt.delta.text) {
      const newText = s._streamingText + evt.delta.text;
      // Update last assistant message content in-place
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant" && !last.meta) {
        msgs[msgs.length - 1] = { ...last, content: newText };
      } else {
        msgs.push({ role: "assistant", content: newText });
      }
      return { ...s, messages: msgs, _streamingText: newText };
    }
    if (evt.delta.type === "thinking_delta" && evt.delta.thinking) {
      const newThinking = s._streamingThinking + evt.delta.thinking;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant" && !last.meta) {
        msgs[msgs.length - 1] = { ...last, thinking: newThinking };
      } else {
        msgs.push({ role: "assistant", content: "", thinking: newThinking });
      }
      return { ...s, messages: msgs, _streamingThinking: newThinking };
    }
  }

  return s;
}

// ── Tool Progress ──

function reduceToolProgress(s: ReducerState, m: any): ReducerState {
  return {
    ...s,
    activeToolName: m.tool_name,
    activeToolElapsed: m.elapsed_time_seconds,
  };
}

// ── Tool Use Summary ──

function reduceToolUseSummary(s: ReducerState, _m: any): ReducerState {
  return { ...s, activeToolName: undefined, activeToolElapsed: undefined };
}

// ── Result ──

function reduceResult(s: ReducerState, m: any): ReducerState {
  const msgs = [...s.messages];
  const last = msgs[msgs.length - 1];

  // Finalize the last assistant message with metadata
  if (last?.role === "assistant" && !last.meta) {
    const modelName = m.modelUsage ? Object.keys(m.modelUsage)[0] : s.model;
    msgs[msgs.length - 1] = {
      ...last,
      // Attach sub-tasks to the message
      subTasks: s._subTasks.size > 0
        ? Array.from(s._subTasks.values())
        : undefined,
      meta: {
        cost: m.total_cost_usd,
        duration: m.duration_ms,
        model: modelName,
        turns: m.num_turns,
      },
    };
  }

  return {
    ...s,
    status: m.subtype === "success" ? "idle" : "error",
    messages: msgs,
    totalCost: s.totalCost + (m.total_cost_usd ?? 0),
    numTurns: s.numTurns + (m.num_turns ?? 0),
    _streamingText: "",
    _streamingThinking: "",
    _pendingToolCalls: new Map(),
    _subTasks: new Map(),
    activeToolName: undefined,
    activeToolElapsed: undefined,
  };
}
