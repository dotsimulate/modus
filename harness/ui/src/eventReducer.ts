/**
 * Event Reducer — pure function that processes SDK events into view-model state.
 *
 * Given the same sequence of events, produces the same output.
 * Enables deterministic state reconstruction on reconnect.
 */

import type {
  AgentConfigState, Message, ToolCall, SubTask, SessionStatus,
  Attachment, PendingPermission, SessionArtifact,
} from "./api";
import { nextMsgId } from "./api";

export type ReducerState = {
  sessionId: string;
  status: SessionStatus;
  model: string;
  agentConfig: AgentConfigState;
  cwd: string;
  additionalDirectories: string[];
  loadProjectSettings: boolean;
  messages: Message[];
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastSeq: number;
  createdAt: number;
  activeToolName?: string;
  activeToolElapsed?: number;
  /** All tools reported by SDK init (built-in + MCP) */
  availableTools: string[];
  // Internal accumulators (not displayed directly)
  _streamingText: string;
  _streamingThinking: string;
  _pendingToolCalls: Map<string, ToolCall>;
  _subTasks: Map<string, SubTask>;
  /** Currently active sub-agent task ID */
  _activeSubTaskId?: string;
  /** tool_use_id of the Agent tool call that owns the active sub-agent */
  _activeAgentToolId?: string;
  /** Timestamp when thinking started streaming */
  _thinkingStartedAt?: number;
  /** Pending permission requests awaiting user response */
  pendingPermissions: PendingPermission[];
  /** Rolling feed of recent stream content (text, thinking, tool inputs) for noise display */
  streamFeed: string;
};

export function createInitialState(sessionId = ""): ReducerState {
  return {
    sessionId,
    status: "starting",
    model: "",
    agentConfig: { toolStates: {}, model: "", provider: "", effort: "", maxTurns: "", providerControls: {} },
    cwd: "",
    additionalDirectories: [],
    loadProjectSettings: true,
    messages: [],
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    lastSeq: 0,
    createdAt: Date.now(),
    availableTools: [],
    _streamingText: "",
    _streamingThinking: "",
    _pendingToolCalls: new Map(),
    _subTasks: new Map(),
    pendingPermissions: [],
    streamFeed: "",
  };
}

/** Process a single SDK event and return updated state (immutable messages array). */
export function reduceEvent(state: ReducerState, event: any, seq: number): ReducerState {
  const s = { ...state, lastSeq: Math.max(state.lastSeq, seq) };
  const m = typeof event === "string" ? JSON.parse(event) : event;
  const ts: number = m._ts ?? Date.now();

  switch (m.type) {
    case "system":
      return reduceSystem(s, m, ts);
    case "assistant":
      return reduceAssistant(s, m, ts);
    case "user":
      return reduceUser(s, m, ts);
    case "stream_event":
      return reduceStreamEvent(s, m, ts);
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

/** Append to streamFeed, keeping a rolling tail of ~500 chars */
function appendFeed(current: string, text: string): string {
  return (current + " " + text).slice(-500);
}

function attachArtifactToMessage(
  messages: Message[],
  targetSeq: number | undefined,
  targetMessageUuid: string | undefined,
  artifact: SessionArtifact,
): Message[] {
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i--) {
    const msg = next[i];
    if (msg.role !== "assistant") continue;
    const matchesUuid = !!targetMessageUuid && msg.uuid === targetMessageUuid;
    const matchesSeq = targetSeq != null && msg.seq === targetSeq;
    if (!matchesUuid && !matchesSeq) continue;
    const existing = msg.artifacts ?? [];
    if (existing.some((item) => item.id === artifact.id)) return messages;
    next[i] = { ...msg, artifacts: [...existing, artifact] };
    return next;
  }
  return messages;
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

function reduceSystem(s: ReducerState, m: any, ts: number): ReducerState {
  if (m.subtype === "provider_message") {
    const content = typeof m.content === "string"
      ? m.content.trim()
      : typeof m.message === "string"
        ? m.message.trim()
        : "";
    if (!content) return s;
    const last = s.messages[s.messages.length - 1];
    if (last?.role === "system" && last.content === content) return s;
    return {
      ...s,
      messages: [...s.messages, {
        id: nextMsgId(),
        role: "system",
        content,
        timestamp: ts,
      }],
    };
  }
  if (m.subtype === "init") {
    const nextConfig = readAgentConfig(m.config);
    return {
      ...s,
      sessionId: m.session_id ?? s.sessionId,
      model: m.model ?? s.model,
      agentConfig: nextConfig ?? s.agentConfig,
      cwd: m.cwd ?? s.cwd,
      additionalDirectories: Array.isArray(m.additionalDirectories) ? m.additionalDirectories : s.additionalDirectories,
      loadProjectSettings: m.loadProjectSettings ?? s.loadProjectSettings,
      status: "running",
      availableTools: Array.isArray(m.tools) ? m.tools : s.availableTools,
    };
  }
  if (m.subtype === "config_updated") {
    const nextConfig = readAgentConfig(m.config);
    return {
      ...s,
      model: m.model ?? s.model,
      agentConfig: nextConfig ?? s.agentConfig,
      cwd: m.cwd ?? s.cwd,
      additionalDirectories: Array.isArray(m.additionalDirectories) ? m.additionalDirectories : s.additionalDirectories,
      loadProjectSettings: m.loadProjectSettings ?? s.loadProjectSettings,
    };
  }
  if (m.subtype === "interrupted") {
    return {
      ...s,
      status: "idle",
      messages: [...s.messages, { id: nextMsgId(), role: "system", content: "interrupted" }],
      _streamingText: "",
      _streamingThinking: "",
      _activeAgentToolId: undefined,
      _activeSubTaskId: undefined,
      activeToolName: undefined,
      activeToolElapsed: undefined,
    };
  }
  if (m.subtype === "switch") {
    return {
      ...s,
      model: m.model ?? s.model,
      messages: [...s.messages, {
        id: nextMsgId(),
        role: "system",
        content: `switched to ${m.toProfile}`,
      }],
    };
  }
  if (m.subtype === "permission_request") {
    const perm: PendingPermission = {
      requestId: m.requestId,
      toolName: m.toolName,
      toolInput: m.toolInput ?? {},
      toolUseID: m.toolUseID,
      interactive: !!m.interactive,
      decisionReason: m.decisionReason,
      requestedAt: ts,
    };
    return { ...s, pendingPermissions: [...s.pendingPermissions, perm] };
  }
  if (m.subtype === "permission_resolved") {
    return {
      ...s,
      pendingPermissions: s.pendingPermissions.filter((p) => p.requestId !== m.requestId),
    };
  }
  if (m.subtype === "artifact_attached" && m.artifact) {
    return {
      ...s,
      messages: attachArtifactToMessage(
        s.messages,
        typeof m.targetSeq === "number" ? m.targetSeq : undefined,
        typeof m.targetMessageUuid === "string" ? m.targetMessageUuid : undefined,
        m.artifact as SessionArtifact,
      ),
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
    // Store taskId on the Agent ToolCall so the UI can call stopTask
    const toolId = m.tool_use_id ?? s._activeAgentToolId;
    let msgs = s.messages;
    if (toolId) {
      msgs = [...msgs];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].toolCalls?.some((tc) => tc.id === toolId)) {
          msgs[i] = {
            ...msgs[i],
            toolCalls: msgs[i].toolCalls!.map((tc) =>
              tc.id === toolId ? { ...tc, taskId: m.task_id } : tc
            ),
          };
          break;
        }
      }
    }
    return {
      ...s,
      messages: msgs,
      _subTasks: tasks,
      _activeSubTaskId: m.task_id,
      _activeAgentToolId: toolId,
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
  if (m.subtype === "compacting") {
    return {
      ...s,
      messages: [...s.messages, {
        id: nextMsgId(),
        role: "system",
        content: "summarizing context...",
      }],
    };
  }
  if (m.subtype === "compact_complete") {
    // Replace the "summarizing context..." message with completion
    const msgs = [...s.messages];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "system" && msgs[i].content === "summarizing context...") {
        const detail = m.pre_tokens ? ` (${Math.round(m.pre_tokens / 1000)}k tokens)` : "";
        msgs[i] = { ...msgs[i], content: `context compacted${detail}` };
        return { ...s, messages: msgs };
      }
    }
    // No pending message found — append
    return {
      ...s,
      messages: [...s.messages, {
        id: nextMsgId(),
        role: "system",
        content: "context compacted",
      }],
    };
  }
  if (m.subtype === "compact_error") {
    const msgs = [...s.messages];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "system" && msgs[i].content === "summarizing context...") {
        msgs[i] = { ...msgs[i], content: `compaction failed: ${m.error}` };
        return { ...s, messages: msgs };
      }
    }
    return {
      ...s,
      messages: [...s.messages, {
        id: nextMsgId(),
        role: "system",
        content: `compaction failed: ${m.error}`,
      }],
    };
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

function readAgentConfig(config: any): AgentConfigState | null {
  if (!config || typeof config !== "object") return null;
  return {
    toolStates: readToolStates(config.toolStates),
    model: typeof config.model === "string" ? config.model : "",
    provider: typeof config.provider === "string" ? config.provider : "",
    effort: typeof config.effort === "string" ? config.effort : "",
    maxTurns: config.maxTurns != null ? String(config.maxTurns) : "",
    providerControls: readProviderControls(config.providerControls),
  };
}

function readToolStates(toolStates: any): AgentConfigState["toolStates"] {
  if (!toolStates || typeof toolStates !== "object") return {};
  const next: AgentConfigState["toolStates"] = {};
  for (const [tool, state] of Object.entries(toolStates)) {
    if (state === "inherit" || state === "on" || state === "off") next[tool] = state;
  }
  return next;
}

function readProviderControls(providerControls: any): AgentConfigState["providerControls"] {
  if (!providerControls || typeof providerControls !== "object") return {};
  const next: NonNullable<AgentConfigState["providerControls"]> = {};
  const rawCodex = (providerControls as Record<string, unknown>).codex;
  if (rawCodex && typeof rawCodex === "object") {
    const codex = rawCodex as Record<string, unknown>;
    next.codex = {};
    if (
      codex.sandboxMode === "read-only"
      || codex.sandboxMode === "workspace-write"
      || codex.sandboxMode === "danger-full-access"
    ) {
      next.codex.sandboxMode = codex.sandboxMode;
    }
    if (codex.webSearchMode === "disabled" || codex.webSearchMode === "cached" || codex.webSearchMode === "live") {
      next.codex.webSearchMode = codex.webSearchMode;
    }
  }
  const rawClaude = (providerControls as Record<string, unknown>).claude;
  if (rawClaude && typeof rawClaude === "object") {
    const claude = rawClaude as Record<string, unknown>;
    next.claude = {};
    if (
      claude.permissionMode === "default"
      || claude.permissionMode === "acceptEdits"
      || claude.permissionMode === "plan"
      || claude.permissionMode === "dontAsk"
    ) {
      next.claude.permissionMode = claude.permissionMode;
    }
  }
  return next;
}

// ── Assistant Messages ──
// Contains text, thinking, and tool_use content blocks

function reduceAssistant(s: ReducerState, m: any, ts: number): ReducerState {
  const content = m.message?.content;
  if (!content || !Array.isArray(content)) return s;
  const messageUuid = typeof m.uuid === "string" ? m.uuid : undefined;

  let text = "";
  let thinking = "";
  const toolCalls: ToolCall[] = [];
  const feedParts: string[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text) {
      text += block.text;
      feedParts.push(block.text);
    }
    if (block.type === "thinking" && block.thinking) {
      thinking = block.thinking;
      feedParts.push(block.thinking);
    }
    if (block.type === "tool_use") {
      const tc: ToolCall = {
        id: block.id,
        name: block.name,
        input: block.input ?? {},
        status: "running",
        startedAt: ts,
      };
      toolCalls.push(tc);
      // Track in pending map for result matching (immutable copy)
      s._pendingToolCalls = new Map(s._pendingToolCalls);
      s._pendingToolCalls.set(block.id, tc);
      // Feed tool inputs into streamFeed
      for (const v of Object.values(block.input ?? {})) {
        if (typeof v === "string" && v.length > 1) feedParts.push(v);
      }
    }
  }

  // ── Sub-agent mode: nest inside Agent tool call ──
  if (s._activeAgentToolId) {
    const subMsg: Message = {
      id: nextMsgId(),
      role: "assistant",
      content: text,
      timestamp: ts,
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

    const feed = feedParts.length > 0 ? feedParts.reduce((f, p) => appendFeed(f, p), s.streamFeed) : s.streamFeed;
    return { ...s, status: "running", messages: msgs, _streamingText: "", _streamingThinking: "", streamFeed: feed };
  }

  // ── Normal mode: top-level messages ──
  const msgs = [...s.messages];
  const last = msgs[msgs.length - 1];

  // A message with completed/errored tool calls is a finished turn — don't merge into it
  const canMerge = last?.role === "assistant" && !last.meta
    && !last.toolCalls?.some((tc) => tc.status !== "running");

  // Finalize thinking duration if thinking phase just ended
  const thinkingDuration = s._thinkingStartedAt ? ts - s._thinkingStartedAt : undefined;

  if (text || thinking || toolCalls.length > 0) {
    if (canMerge) {
      msgs[msgs.length - 1] = {
        ...last,
        content: text || last.content,
        thinking: thinking || last.thinking,
        toolCalls: [...(last.toolCalls ?? []), ...toolCalls],
        ...(messageUuid && !last.uuid ? { uuid: messageUuid } : {}),
        ...(thinkingDuration != null && !last.thinkingDuration && { thinkingDuration }),
      };
    } else {
      msgs.push({
        id: nextMsgId(),
        role: "assistant",
        content: text,
        ...(messageUuid ? { uuid: messageUuid } : {}),
        timestamp: ts,
        thinking: thinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        ...(thinkingDuration != null && { thinkingDuration }),
      });
    }
  }

  const feed = feedParts.length > 0 ? feedParts.reduce((f, p) => appendFeed(f, p), s.streamFeed) : s.streamFeed;
  return { ...s, status: "running", messages: msgs, _streamingText: "", _streamingThinking: "", _thinkingStartedAt: undefined, streamFeed: feed };
}

// ── User Messages (including synthetic tool_result) ──

function reduceUser(s: ReducerState, m: any, ts: number): ReducerState {
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
              duration: ts - tc.startedAt,
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
        // Also stamp seq if missing
        if ((attachments && !prev.attachments) || !prev.seq) {
          const msgs = [...s.messages];
          msgs[i] = { ...prev, seq: s.lastSeq, timestamp: prev.timestamp ?? ts, ...(attachments && !prev.attachments && { attachments }) };
          return { ...s, messages: msgs };
        }
        return s;
      }
    }

    return {
      ...s,
      messages: [...s.messages, { id: nextMsgId(), role: "user", content: text, seq: s.lastSeq, timestamp: ts, attachments }],
    };
  }

  // All other user events (SDK-originated, e.g. sub-agent prompt echoes) — skip display
  return s;
}

// ── Stream Events (partial deltas) ──

function reduceStreamEvent(s: ReducerState, m: any, ts: number): ReducerState {
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
            timestamp: ts,
          });
        }
        return { ...s, messages: msgs, _streamingText: newText, streamFeed: appendFeed(s.streamFeed, evt.delta.text) };
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
            timestamp: ts,
          });
        }
        return { ...s, messages: msgs, _streamingThinking: newThinking, streamFeed: appendFeed(s.streamFeed, evt.delta.thinking) };
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
      // Finalize thinking duration when text starts
      const thinkingDuration = s._thinkingStartedAt && !last?.thinkingDuration
        ? ts - s._thinkingStartedAt : undefined;
      if (canMerge) {
        msgs[msgs.length - 1] = { ...last, content: newText, ...(thinkingDuration != null && { thinkingDuration }) };
      } else {
        msgs.push({ id: nextMsgId(), role: "assistant", content: newText, timestamp: ts });
      }
      return { ...s, messages: msgs, _streamingText: newText, _thinkingStartedAt: undefined, streamFeed: appendFeed(s.streamFeed, evt.delta.text) };
    }
    if (evt.delta.type === "thinking_delta" && evt.delta.thinking) {
      const newThinking = s._streamingThinking + evt.delta.thinking;
      const startedAt = s._thinkingStartedAt ?? ts;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      const canMerge = last?.role === "assistant" && !last.meta
        && !last.toolCalls?.some((tc) => tc.status !== "running");
      if (canMerge) {
        msgs[msgs.length - 1] = { ...last, thinking: newThinking };
      } else {
        msgs.push({ id: nextMsgId(), role: "assistant", content: "", thinking: newThinking, timestamp: ts });
      }
      return { ...s, messages: msgs, _streamingThinking: newThinking, _thinkingStartedAt: startedAt, streamFeed: appendFeed(s.streamFeed, evt.delta.thinking) };
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
    // Aggregate full-turn content: collect all assistant rounds since the last user message
    let turnText = "";
    let turnThinking = "";
    const turnToolCalls: ToolCall[] = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role === "user") break;
      if (msg.role === "assistant" && !msg.meta) {
        if (msg.content) turnText = msg.content + (turnText ? "\n\n" + turnText : "");
        if (msg.thinking) turnThinking = msg.thinking + (turnThinking ? "\n\n" + turnThinking : "");
        if (msg.toolCalls?.length) turnToolCalls.unshift(...msg.toolCalls);
      }
    }
    const turnCopy: Message["turnCopy"] = { text: turnText };
    if (turnThinking) turnCopy.thinking = turnThinking;
    if (turnToolCalls.length > 0) turnCopy.toolCalls = turnToolCalls;

    const modelName = m.modelUsage ? Object.keys(m.modelUsage)[0] : s.model;

    // Derive cache tokens from modelUsage (authoritative source, present in all Claude events)
    // Fall back to top-level fields for newer events that already have them computed.
    let cacheRead = m.cache_read_tokens ?? 0;
    let cacheWrite = m.cache_write_tokens ?? 0;
    let contextWindow = 0;
    if (m.modelUsage && typeof m.modelUsage === "object") {
      for (const model of Object.values(m.modelUsage) as any[]) {
        if (cacheRead === 0) cacheRead += model?.cacheReadInputTokens ?? 0;
        if (cacheWrite === 0) cacheWrite += model?.cacheCreationInputTokens ?? 0;
        if (!contextWindow) contextWindow = model?.contextWindow ?? 0;
      }
    }

    msgs[msgs.length - 1] = {
      ...last,
      seq: s.lastSeq, // result event seq — used as branch point
      // Persist backend-measured thinking duration (survives refresh)
      ...(m.thinking_duration_ms != null && { thinkingDuration: m.thinking_duration_ms }),
      turnCopy,
      meta: {
        cost: m.total_cost_usd,
        duration: m.harness_duration_ms,
        model: modelName,
        turns: m.num_turns,
        inputTokens: m.input_tokens,
        outputTokens: m.output_tokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        contextWindow,
      },
    };
  }

  // Surface error text in the chat
  if (m.subtype === "error" && m.error) {
    msgs.push({ id: nextMsgId(), role: "system", content: m.error });
  }

  return {
    ...s,
    status: (m.subtype === "success" || m.subtype === "error_max_turns") ? "idle" : "error",
    messages: msgs,
    totalCost: s.totalCost + (m.total_cost_usd ?? 0),
    totalInputTokens: s.totalInputTokens + (m.input_tokens ?? 0),
    totalOutputTokens: s.totalOutputTokens + (m.output_tokens ?? 0),
    _streamingText: "",
    _streamingThinking: "",
    _pendingToolCalls: new Map(),
    _subTasks: new Map(),
    _activeAgentToolId: undefined,
    _activeSubTaskId: undefined,
    activeToolName: undefined,
    activeToolElapsed: undefined,
    pendingPermissions: [],
    streamFeed: "",
  };
}
