/**
 * Event Reducer — pure function that processes SDK events into view-model state.
 *
 * Given the same sequence of events, produces the same output.
 * Enables deterministic state reconstruction on reconnect.
 */

import type { Message, ToolCall, SubTask, SessionStatus, Attachment } from "./types";
import { nextMsgId } from "./types";

export type ReducerState = {
  sessionId: string;
  status: SessionStatus;
  model: string;
  messages: Message[];
  totalCost: number;
  lastSeq: number;
  createdAt: number;
  activeToolName?: string;
  activeToolElapsed?: number;
  // Internal accumulators (not displayed directly)
  _streamingText: string;
  _streamingThinking: string;
  _pendingToolCalls: Map<string, ToolCall>;
  _subTasks: Map<string, SubTask>;
  /** Currently active sub-agent task ID */
  _activeSubTaskId?: string;
  /** tool_use_id of the Agent tool call that owns the active sub-agent */
  _activeAgentToolId?: string;
};

export function createInitialState(sessionId = ""): ReducerState {
  return {
    sessionId,
    status: "starting",
    model: "",
    messages: [],
    totalCost: 0,
    lastSeq: 0,
    createdAt: Date.now(),
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

// ── Helpers for sub-agent message nesting ──

/** Append a sub-message to the Agent tool call's subMessages */
function appendSubMessage(msgs: Message[], agentToolId: string, subMsg: Message): Message[] {
  const result = [...msgs];
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.toolCalls?.some((tc) => tc.id === agentToolId)) {
      result[i] = {
        ...msg,
        toolCalls: msg.toolCalls!.map((tc) =>
          tc.id === agentToolId
            ? { ...tc, subMessages: [...(tc.subMessages ?? []), subMsg] }
            : tc
        ),
      };
      return result;
    }
  }
  // Fallback: couldn't find the Agent tool call, add as top-level
  result.push(subMsg);
  return result;
}

/** Update the last sub-message in the Agent tool call's subMessages */
function updateLastSubMessage(
  msgs: Message[],
  agentToolId: string,
  updater: (m: Message) => Message,
): Message[] {
  const result = [...msgs];
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    const agentTc = msg.toolCalls?.find((tc) => tc.id === agentToolId);
    if (agentTc?.subMessages?.length) {
      const subs = [...agentTc.subMessages];
      subs[subs.length - 1] = updater(subs[subs.length - 1]);
      result[i] = {
        ...msg,
        toolCalls: msg.toolCalls!.map((tc) =>
          tc.id === agentToolId ? { ...tc, subMessages: subs } : tc
        ),
      };
      return result;
    }
  }
  return result;
}

/** Get the last sub-message for the active Agent tool */
function getLastSubMessage(msgs: Message[], agentToolId: string): Message | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const tc = msgs[i].toolCalls?.find((t) => t.id === agentToolId);
    if (tc?.subMessages?.length) {
      return tc.subMessages[tc.subMessages.length - 1];
    }
  }
  return undefined;
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
  if (m.subtype === "interrupted") {
    return {
      ...s,
      status: "idle",
      messages: [...s.messages, { id: nextMsgId(), role: "system", content: "interrupted" }],
      _streamingText: "",
      _streamingThinking: "",
      activeToolName: undefined,
      activeToolElapsed: undefined,
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
    return {
      ...s,
      _subTasks: tasks,
      _activeSubTaskId: m.task_id,
      _activeAgentToolId: m.tool_use_id ?? s._activeAgentToolId,
    };
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
    // Store summary on the Agent tool call
    let msgs = s.messages;
    const toolId = m.tool_use_id ?? s._activeAgentToolId;
    if (toolId && m.summary) {
      msgs = [...msgs];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].toolCalls?.some((tc) => tc.id === toolId)) {
          msgs[i] = {
            ...msgs[i],
            toolCalls: msgs[i].toolCalls!.map((tc) =>
              tc.id === toolId ? { ...tc, subSummary: m.summary } : tc
            ),
          };
          break;
        }
      }
    }
    // Clear active sub-task if this one is finishing
    const clearing = s._activeSubTaskId === m.task_id;
    return {
      ...s,
      messages: msgs,
      _subTasks: tasks,
      _activeSubTaskId: clearing ? undefined : s._activeSubTaskId,
      _activeAgentToolId: clearing ? undefined : s._activeAgentToolId,
    };
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
        status: "running",
        startedAt: Date.now(),
      };
      toolCalls.push(tc);
      // Track in pending map for result matching (immutable copy)
      s._pendingToolCalls = new Map(s._pendingToolCalls);
      s._pendingToolCalls.set(block.id, tc);
    }
  }

  // ── Sub-agent mode: nest inside Agent tool call ──
  if (s._activeAgentToolId) {
    const subMsg: Message = {
      id: nextMsgId(),
      role: "assistant",
      content: text,
      thinking: thinking || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    const lastSub = getLastSubMessage(s.messages, s._activeAgentToolId);
    const canMergeSub = lastSub?.role === "assistant" && !lastSub.meta
      && !lastSub.toolCalls?.some((tc) => tc.status !== "running");
    let msgs: Message[];

    if (canMergeSub) {
      msgs = updateLastSubMessage(s.messages, s._activeAgentToolId, (prev) => ({
        ...prev,
        content: text || prev.content,
        thinking: thinking || prev.thinking,
        toolCalls: [...(prev.toolCalls ?? []), ...toolCalls],
      }));
    } else {
      msgs = appendSubMessage(s.messages, s._activeAgentToolId, subMsg);
    }

    return { ...s, status: "running", messages: msgs, _streamingText: "", _streamingThinking: "" };
  }

  // ── Normal mode: top-level messages ──
  const msgs = [...s.messages];
  const last = msgs[msgs.length - 1];

  // A message with completed/errored tool calls is a finished turn — don't merge into it
  const canMerge = last?.role === "assistant" && !last.meta
    && !last.toolCalls?.some((tc) => tc.status !== "running");

  if (text || thinking || toolCalls.length > 0) {
    if (canMerge) {
      msgs[msgs.length - 1] = {
        ...last,
        content: text || last.content,
        thinking: thinking || last.thinking,
        toolCalls: [...(last.toolCalls ?? []), ...toolCalls],
      };
    } else {
      msgs.push({
        id: nextMsgId(),
        role: "assistant",
        content: text,
        thinking: thinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    }
  }

  return { ...s, status: "running", messages: msgs, _streamingText: "", _streamingThinking: "" };
}

// ── User Messages (including synthetic tool_result) ──

function reduceUser(s: ReducerState, m: any): ReducerState {
  // Detect synthetic tool_result messages — either flagged or contains tool_result blocks
  const content = m.message?.content;
  const hasToolResults = Array.isArray(content) && content.some((b: any) => b.type === "tool_result");
  if (m.isSynthetic || hasToolResults) {
    if (Array.isArray(content)) {
      const pending = new Map(s._pendingToolCalls);
      let msgs = [...s.messages];

      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const tc = pending.get(block.tool_use_id);
          if (tc) {
            const result = typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "");
            // Build update fields — merged onto the CURRENT tool call, not the stale pending copy
            const updateFields = {
              status: (block.is_error ? "error" : "completed") as ToolCall["status"],
              result: result.slice(0, 2000),
              duration: Date.now() - tc.startedAt,
            };
            pending.set(block.tool_use_id, { ...tc, ...updateFields });

            // Update the tool call in messages — merge onto current (preserves subMessages etc.)
            let found = false;
            for (let i = msgs.length - 1; i >= 0; i--) {
              const msg = msgs[i];
              if (msg.toolCalls?.some((t) => t.id === block.tool_use_id)) {
                msgs[i] = {
                  ...msg,
                  toolCalls: msg.toolCalls!.map((t) =>
                    t.id === block.tool_use_id ? { ...t, ...updateFields } : t
                  ),
                };
                found = true;
                break;
              }
              // Also check inside Agent tool subMessages
              for (const parentTc of msg.toolCalls ?? []) {
                if (parentTc.subMessages) {
                  for (let j = 0; j < parentTc.subMessages.length; j++) {
                    const subMsg = parentTc.subMessages[j];
                    if (subMsg.toolCalls?.some((t) => t.id === block.tool_use_id)) {
                      const newSubs = [...parentTc.subMessages];
                      newSubs[j] = {
                        ...subMsg,
                        toolCalls: subMsg.toolCalls!.map((t) =>
                          t.id === block.tool_use_id ? { ...t, ...updateFields } : t
                        ),
                      };
                      msgs[i] = {
                        ...msg,
                        toolCalls: msg.toolCalls!.map((t) =>
                          t.id === parentTc.id ? { ...t, subMessages: newSubs } : t
                        ),
                      };
                      found = true;
                      break;
                    }
                  }
                  if (found) break;
                }
              }
              if (found) break;
            }
          }
        }
      }
      // If the Agent tool_result arrived, clear sub-agent mode so subsequent
      // assistant events go to top-level instead of nesting inside the Agent block
      let activeAgentToolId = s._activeAgentToolId;
      let activeSubTaskId = s._activeSubTaskId;
      if (activeAgentToolId) {
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id === activeAgentToolId) {
            activeAgentToolId = undefined;
            activeSubTaskId = undefined;
            break;
          }
        }
      }

      return { ...s, messages: msgs, _pendingToolCalls: pending, _streamingText: "", _streamingThinking: "", _activeAgentToolId: activeAgentToolId, _activeSubTaskId: activeSubTaskId, activeToolName: undefined, activeToolElapsed: undefined };
    }
    return s;
  }

  // User prompt events (subtype: "prompt") — real user input, always display
  if (m.subtype === "prompt") {
    const rawContent = m.message?.content;
    let text = "";
    let attachments: Attachment[] | undefined;

    if (typeof rawContent === "string") {
      text = rawContent;
    } else if (Array.isArray(rawContent)) {
      // Content blocks — extract text and images
      const imgs: Attachment[] = [];
      for (const block of rawContent) {
        if (block.type === "text" && block.text) {
          text += block.text;
        } else if (block.type === "image" && block.source?.type === "base64") {
          imgs.push({
            type: "image",
            mediaType: block.source.media_type,
            data: block.source.data,
          });
        }
      }
      if (imgs.length > 0) attachments = imgs;
    }

    if (!text && !attachments?.length) return s;

    // Dedup: don't add if any recent user message has identical text
    // (optimistic insert from handleSend may not be the last message anymore)
    for (let i = s.messages.length - 1; i >= 0 && i >= s.messages.length - 4; i--) {
      const prev = s.messages[i];
      if (prev.role === "user" && prev.content === text) {
        // If existing msg has no attachments but event does, update it
        if (attachments && !prev.attachments) {
          const msgs = [...s.messages];
          msgs[i] = { ...prev, attachments };
          return { ...s, messages: msgs };
        }
        return s;
      }
    }

    return {
      ...s,
      messages: [...s.messages, { id: nextMsgId(), role: "user", content: text, attachments }],
    };
  }

  // All other user events (SDK-originated, e.g. sub-agent prompt echoes) — skip display
  return s;
}

// ── Stream Events (partial deltas) ──

function reduceStreamEvent(s: ReducerState, m: any): ReducerState {
  const evt = m.event;
  if (!evt) return s;

  if (evt.type === "content_block_delta" && evt.delta) {
    // ── Sub-agent mode: stream into Agent tool call's subMessages ──
    if (s._activeAgentToolId) {
      if (evt.delta.type === "text_delta" && evt.delta.text) {
        const newText = s._streamingText + evt.delta.text;
        const lastSub = getLastSubMessage(s.messages, s._activeAgentToolId);
        const canMerge = lastSub?.role === "assistant" && !lastSub.meta
          && !lastSub.toolCalls?.some((tc) => tc.status !== "running");
        let msgs: Message[];
        if (canMerge) {
          msgs = updateLastSubMessage(s.messages, s._activeAgentToolId, (prev) => ({
            ...prev,
            content: newText,
          }));
        } else {
          msgs = appendSubMessage(s.messages, s._activeAgentToolId, {
            id: nextMsgId(),
            role: "assistant",
            content: newText,
          });
        }
        return { ...s, messages: msgs, _streamingText: newText };
      }
      if (evt.delta.type === "thinking_delta" && evt.delta.thinking) {
        const newThinking = s._streamingThinking + evt.delta.thinking;
        const lastSub = getLastSubMessage(s.messages, s._activeAgentToolId);
        const canMerge = lastSub?.role === "assistant" && !lastSub.meta
          && !lastSub.toolCalls?.some((tc) => tc.status !== "running");
        let msgs: Message[];
        if (canMerge) {
          msgs = updateLastSubMessage(s.messages, s._activeAgentToolId, (prev) => ({
            ...prev,
            thinking: newThinking,
          }));
        } else {
          msgs = appendSubMessage(s.messages, s._activeAgentToolId, {
            id: nextMsgId(),
            role: "assistant",
            content: "",
            thinking: newThinking,
          });
        }
        return { ...s, messages: msgs, _streamingThinking: newThinking };
      }
      return s;
    }

    // ── Normal mode ──
    if (evt.delta.type === "text_delta" && evt.delta.text) {
      const newText = s._streamingText + evt.delta.text;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      const canMerge = last?.role === "assistant" && !last.meta
        && !last.toolCalls?.some((tc) => tc.status !== "running");
      if (canMerge) {
        msgs[msgs.length - 1] = { ...last, content: newText };
      } else {
        msgs.push({ id: nextMsgId(), role: "assistant", content: newText });
      }
      return { ...s, messages: msgs, _streamingText: newText };
    }
    if (evt.delta.type === "thinking_delta" && evt.delta.thinking) {
      const newThinking = s._streamingThinking + evt.delta.thinking;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      const canMerge = last?.role === "assistant" && !last.meta
        && !last.toolCalls?.some((tc) => tc.status !== "running");
      if (canMerge) {
        msgs[msgs.length - 1] = { ...last, thinking: newThinking };
      } else {
        msgs.push({ id: nextMsgId(), role: "assistant", content: "", thinking: newThinking });
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
      meta: {
        cost: m.total_cost_usd,
        duration: m.harness_duration_ms,
        model: modelName,
        turns: m.num_turns,
        inputTokens: m.input_tokens,
        outputTokens: m.output_tokens,
      },
    };
  }

  return {
    ...s,
    status: m.subtype === "success" ? "idle" : "error",
    messages: msgs,
    totalCost: s.totalCost + (m.total_cost_usd ?? 0),
    _streamingText: "",
    _streamingThinking: "",
    _pendingToolCalls: new Map(),
    _subTasks: new Map(),
    activeToolName: undefined,
    activeToolElapsed: undefined,
  };
}
