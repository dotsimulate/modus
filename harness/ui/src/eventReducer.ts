/**
 * Event Reducer — pure function that processes SDK events into view-model state.
 *
 * Given the same sequence of events, produces the same output.
 * Enables deterministic state reconstruction on reconnect.
 */

import type {
  AgentConfigState, Message, ToolCall, SubTask, SessionStatus,
  Attachment, PendingPermission, SessionArtifact, MessageContentBlock,
} from "../../sdk/index";
import { nextMsgId } from "../../sdk/index";
import { turnMetaFromResultEvent } from "../../turn-meta";
import { providerErrorDisplayText } from "../../provider-error";
import { userAuthoredMessageText } from "./move-context";
import { copyTextFromBlocks } from "./message-copy";
import { isClientTempSessionId } from "./session-id";

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
      return reduceResult(s, m, ts);
    case "rate_limit_event":
      return reduceProviderWait(s, "Claude is retrying after a rate limit.", ts);
    case "error":
      return reduceErrorEvent(s, m, ts);
    default:
      return s;
  }
}

/**
 * A provider that fails before its first event (binary missing, unsupported
 * flag, spawn refusal) broadcasts a bare error event. Dropping it renders a
 * dead send — the message vanishes and the session sits idle with no
 * explanation — so it must land in the transcript like any other outcome.
 */
function reduceErrorEvent(s: ReducerState, m: any, ts: number): ReducerState {
  // Shared with the persistence and reload paths, so all three read the two
  // event shapes ({error} from providers, {message} from the session manager)
  // identically. The reducer used to read only `error`, so a delivery failure
  // rendered the generic fallback and lost the real reason.
  const content = providerErrorDisplayText(m);
  return {
    ...s,
    status: "error",
    messages: [...s.messages, { id: nextMsgId(), role: "system", content, timestamp: ts }],
    streamFeed: appendFeed(s.streamFeed, content),
  };
}

/** Append to streamFeed, keeping a rolling tail of ~500 chars */
function appendFeed(current: string, text: string): string {
  return (current + " " + text).slice(-500);
}

function reduceProviderWait(s: ReducerState, content: string, ts: number): ReducerState {
  const trimmed = content.trim();
  if (!trimmed) return s;
  const msgs = [...s.messages];
  const last = msgs[msgs.length - 1];
  if (last?.role === "system" && (
    last.content.startsWith("Claude is retrying")
    || last.content.startsWith("Codex is reconnecting")
  )) {
    msgs[msgs.length - 1] = { ...last, content: trimmed, timestamp: ts };
  } else {
    msgs.push({ id: nextMsgId(), role: "system", content: trimmed, timestamp: ts });
  }
  return { ...s, status: "running", messages: msgs, streamFeed: appendFeed(s.streamFeed, trimmed) };
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
  if (m.subtype === "live_snapshot") {
    const text = typeof m.text === "string" ? m.text : "";
    const thinking = typeof m.thinking === "string" ? m.thinking : "";
    const feed = typeof m.feed === "string" ? m.feed : s.streamFeed;
    if (!text && !thinking) {
      return { ...s, streamFeed: feed };
    }
    const msgs = [...s.messages];
    const last = msgs[msgs.length - 1];
    const canMerge = last?.role === "assistant" && !last.meta
      && !last.toolCalls?.some((tc) => tc.status !== "running");
    if (canMerge) {
      msgs[msgs.length - 1] = {
        ...last,
        content: text || last.content,
        thinking: thinking || last.thinking,
      };
    } else {
      msgs.push({
        id: nextMsgId(),
        role: "assistant",
        content: text,
        thinking: thinking || undefined,
        timestamp: ts,
      });
    }
    return {
      ...s,
      status: s.status === "starting" ? "running" : s.status,
      messages: msgs,
      _streamingText: text,
      _streamingThinking: thinking,
      streamFeed: feed,
    };
  }
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
  if (m.subtype === "api_retry") {
    const delay = typeof m.delay_ms === "number"
      ? ` Retrying in ${(m.delay_ms / 1000).toFixed(1)}s.`
      : "";
    return reduceProviderWait(s, `Claude is retrying after an API limit or transient error.${delay}`, ts);
  }
  if (m.subtype === "provider_reconnecting" && m.provider === "codex") {
    const attempt = typeof m.attempt === "number" ? m.attempt : "?";
    const maxAttempts = typeof m.maxAttempts === "number" ? m.maxAttempts : "?";
    return reduceProviderWait(s, `Codex is reconnecting (${attempt}/${maxAttempts}). The turn is still running.`, ts);
  }
  if (m.subtype === "init") {
    const nextConfig = readAgentConfig(m.config);
    const nextId = typeof m.session_id === "string" ? m.session_id : "";
    return {
      ...s,
      sessionId: !isClientTempSessionId(s.sessionId) ? s.sessionId : (nextId || s.sessionId),
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
      status: "interrupting",
      messages: [...s.messages, { id: nextMsgId(), role: "system", content: "interrupted" }],
    };
  }
  if (m.subtype === "reclaimed") {
    // The provider process is gone, so the turn cannot resume. Settle the
    // status rather than leaving the transcript on a state that will never
    // change again.
    const content = typeof m.message === "string" && m.message.trim()
      ? m.message.trim()
      : "Session process reclaimed.";
    return {
      ...s,
      status: "done",
      messages: [...s.messages, { id: nextMsgId(), role: "system", content, timestamp: ts }],
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
    permissionPolicy: readPermissionPolicy(config.permissionPolicy),
    providerControls: readProviderControls(config.providerControls),
  };
}

function readPermissionPolicy(policy: any): AgentConfigState["permissionPolicy"] {
  if (policy === "bypass" || policy === "auto-edit" || policy === "ask") return policy;
  if (policy && typeof policy === "object" && (policy.default === "approve" || policy.default === "ask")) {
    return {
      default: policy.default,
      ...(Array.isArray(policy.autoApprove) ? { autoApprove: policy.autoApprove.filter((v: unknown) => typeof v === "string") } : {}),
      ...(Array.isArray(policy.requireApproval) ? { requireApproval: policy.requireApproval.filter((v: unknown) => typeof v === "string") } : {}),
    };
  }
  return undefined;
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
    if (codex.serviceTier === "standard" || codex.serviceTier === "fast" || codex.serviceTier === "priority") {
      next.codex.serviceTier = codex.serviceTier;
    }
  }
  const rawClaude = (providerControls as Record<string, unknown>).claude;
  if (rawClaude && typeof rawClaude === "object") {
    const claude = rawClaude as Record<string, unknown>;
    next.claude = {};
    if (
      claude.permissionMode === "default"
      || claude.permissionMode === "acceptEdits"
      || claude.permissionMode === "bypassPermissions"
      || claude.permissionMode === "plan"
      || claude.permissionMode === "dontAsk"
      || claude.permissionMode === "auto"
    ) {
      next.claude.permissionMode = claude.permissionMode;
    }
  }
  const rawAntigravity = (providerControls as Record<string, unknown>).antigravity;
  if (rawAntigravity && typeof rawAntigravity === "object") {
    const antigravity = rawAntigravity as Record<string, unknown>;
    next.antigravity = {};
    if (antigravity.mode === "accept-edits" || antigravity.mode === "plan") {
      next.antigravity.mode = antigravity.mode;
    }
    if (typeof antigravity.sandbox === "boolean") next.antigravity.sandbox = antigravity.sandbox;
    if (typeof antigravity.printTimeout === "string" && antigravity.printTimeout.trim()) {
      next.antigravity.printTimeout = antigravity.printTimeout;
    }
  }
  const rawGrokBuild = (providerControls as Record<string, unknown>).grokBuild;
  if (rawGrokBuild && typeof rawGrokBuild === "object") {
    const grokBuild = rawGrokBuild as Record<string, unknown>;
    next.grokBuild = {};
    if (grokBuild.mode === "default" || grokBuild.mode === "auto" || grokBuild.mode === "plan" || grokBuild.mode === "always-approve") {
      next.grokBuild.mode = grokBuild.mode;
    }
    if (typeof grokBuild.sandbox === "string" && grokBuild.sandbox.trim()) next.grokBuild.sandbox = grokBuild.sandbox;
    if (typeof grokBuild.noMemory === "boolean") next.grokBuild.noMemory = grokBuild.noMemory;
    if (typeof grokBuild.noSubagents === "boolean") next.grokBuild.noSubagents = grokBuild.noSubagents;
    if (typeof grokBuild.disableWebSearch === "boolean") next.grokBuild.disableWebSearch = grokBuild.disableWebSearch;
  }
  return next;
}

// ── Assistant Messages ──
// Contains text, thinking, and tool_use content blocks

/**
 * Can this assistant event join the previous bubble?
 *
 * One turn is one bubble. The only thing that closes a bubble is the turn
 * ending — `meta` is written by the result event — or something else being
 * appended after it, which is handled by the role check.
 *
 * This deliberately does NOT break on a completed tool call. It used to, and
 * that made a sequential agent loop render as one bubble per tool: every result
 * arrives before the next call, so every call started a new message. History
 * reconstruction has always accumulated the whole turn into one turn, so the
 * same conversation had a completely different shape live and after a reload.
 * See the pipeline-parity test in ui/turnShapeParity.test.ts.
 */
function canMergeIntoTurn(last: Message | undefined): boolean {
  return last?.role === "assistant" && !last.meta;
}

/** Concatenate finalized text blocks, matching how `reconstructSessionTurns`
 *  builds `TurnContent.text` — no separator, provider text carries its own. */
function textFromBlocks(blocks: MessageContentBlock[] | undefined): string {
  if (!blocks) return "";
  let out = "";
  for (const block of blocks) if (block.type === "text") out += block.text;
  return out;
}

/** Same contract as textFromBlocks, for thinking. */
function thinkingFromBlocks(blocks: MessageContentBlock[] | undefined): string {
  if (!blocks) return "";
  let out = "";
  for (const block of blocks) if (block.type === "thinking") out += block.thinking;
  return out;
}

function reduceAssistant(s: ReducerState, m: any, ts: number): ReducerState {
  const content = m.message?.content;
  if (!content || !Array.isArray(content)) return s;
  const messageUuid = typeof m.uuid === "string" ? m.uuid : undefined;

  let text = "";
  let thinking = "";
  const toolCalls: ToolCall[] = [];
  const contentBlocks: MessageContentBlock[] = [];
  const feedParts: string[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text) {
      text += block.text;
      contentBlocks.push({ type: "text", text: block.text });
      feedParts.push(block.text);
    }
    if (block.type === "thinking" && block.thinking) {
      thinking = block.thinking;
      contentBlocks.push({ type: "thinking", thinking: block.thinking });
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
      contentBlocks.push({ type: "tool_call", toolCall: tc });
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
      contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
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
        contentBlocks: [...(prev.contentBlocks ?? []), ...contentBlocks],
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

  const canMerge = canMergeIntoTurn(last);

  // Finalize thinking duration if thinking phase just ended
  const thinkingDuration = s._thinkingStartedAt ? ts - s._thinkingStartedAt : undefined;

  if (text || thinking || toolCalls.length > 0) {
    if (canMerge) {
      // Derive the flat text/thinking from the merged blocks rather than
      // overwriting with this round's. `content: text || last.content` was safe
      // only while each bubble held one round — merging a whole turn into one
      // bubble made a later round erase every earlier one.
      const mergedBlocks = [...(last.contentBlocks ?? []), ...contentBlocks];
      msgs[msgs.length - 1] = {
        ...last,
        content: textFromBlocks(mergedBlocks) || last.content,
        thinking: thinkingFromBlocks(mergedBlocks) || last.thinking,
        toolCalls: [...(last.toolCalls ?? []), ...toolCalls],
        contentBlocks: mergedBlocks,
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
        contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
        ...(thinkingDuration != null && { thinkingDuration }),
      });
    }
  }

  const feed = feedParts.length > 0 ? feedParts.reduce((f, p) => appendFeed(f, p), s.streamFeed) : s.streamFeed;
  return { ...s, status: "running", messages: msgs, _streamingText: "", _streamingThinking: "", _thinkingStartedAt: undefined, streamFeed: feed };
}

/**
 * Upper bound on stored tool output, per call.
 *
 * This is a memory guard, not a display choice — the view truncates separately
 * and offers to expand. It was previously 2000 and applied at store time with
 * no marker, so a `Read` of any ordinary source file was silently cut in a way
 * nothing in the UI acknowledged. Nothing downstream depends on the value.
 */
export const TOOL_RESULT_STORE_LIMIT = 100_000;

/**
 * Split a tool result into displayable text and renderable images.
 *
 * Tool results are either a plain string or an array of content blocks, and
 * that array can carry images — a screenshot, a chart, a generated picture.
 * Stringifying the array inlined the base64 into the text, so the user got a
 * truncated wall of characters where the image should have been. Images come
 * out here as attachments; everything else is flattened to text.
 */
export function splitToolResultContent(content: unknown): { text: string; images: Attachment[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) {
    return { text: content == null ? "" : JSON.stringify(content), images: [] };
  }

  const images: Attachment[] = [];
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "image" && block.source?.type === "base64" && block.source.data) {
      images.push({
        type: "image",
        mediaType: block.source.media_type ?? "image/png",
        data: block.source.data,
      });
    } else if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block != null) {
      // Unknown block kinds still have to be visible rather than dropped —
      // silently losing tool output is the failure mode this whole change is about.
      parts.push(JSON.stringify(block));
    }
  }
  return { text: parts.join("\n"), images };
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
            const { text, images } = splitToolResultContent(block.content);
            // Build update fields — merged onto the CURRENT tool call, not the stale pending copy
            const updateFields = {
              status: (block.is_error ? "error" : "completed") as ToolCall["status"],
              result: text.slice(0, TOOL_RESULT_STORE_LIMIT),
              // Record the true size when the store limit bites, so the view can
              // say output was dropped instead of just ending mid-sentence.
              ...(text.length > TOOL_RESULT_STORE_LIMIT ? { resultFullLength: text.length } : {}),
              ...(images.length > 0 ? { images } : {}),
              duration: ts - tc.startedAt,
            };
            pending.set(block.tool_use_id, { ...tc, ...updateFields });

            // Update the tool call in messages — merge onto current (preserves subMessages etc.)
            let found = false;
            for (let i = msgs.length - 1; i >= 0; i--) {
              const msg = msgs[i];
              if (msg.toolCalls?.some((t) => t.id === block.tool_use_id)) {
                const nextToolCalls = msg.toolCalls!.map((t) =>
                  t.id === block.tool_use_id ? { ...t, ...updateFields } : t
                );
                msgs[i] = {
                  ...msg,
                  toolCalls: nextToolCalls,
                  contentBlocks: msg.contentBlocks?.map((contentBlock) =>
                    contentBlock.type === "tool_call" && contentBlock.toolCall.id === block.tool_use_id
                      ? { ...contentBlock, toolCall: { ...contentBlock.toolCall, ...updateFields } }
                      : contentBlock
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

    // Dedup: don't add if any recent user message has the same user-authored
    // text (optimistic insert from handleSend may not be the last message
    // anymore). Compare the authored portion, not the raw string: when a move
    // is attached the harness prepends its gathered context to the turn, so the
    // echoed event never equals what the composer optimistically inserted. An
    // exact-match check appended a second bubble carrying the move context —
    // the same message twice, with the move disclosure only on the copy.
    const authoredText = userAuthoredMessageText(text);
    for (let i = s.messages.length - 1; i >= 0 && i >= s.messages.length - 4; i--) {
      const prev = s.messages[i];
      if (prev.role !== "user") continue;
      if (prev.content !== text && userAuthoredMessageText(prev.content) !== authoredText) continue;

      // The echo carries injected context the optimistic copy lacks — adopt it
      // so the move disclosure renders on the message the user already sees.
      const gainsMoveContext = prev.content !== text;
      if (gainsMoveContext || (attachments && !prev.attachments) || !prev.seq) {
        const msgs = [...s.messages];
        msgs[i] = {
          ...prev,
          ...(gainsMoveContext && { content: text }),
          seq: s.lastSeq,
          timestamp: prev.timestamp ?? ts,
          ...(attachments && !prev.attachments && { attachments }),
        };
        return { ...s, messages: msgs };
      }
      return s;
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
    const fullText = typeof m.fullText === "string" ? m.fullText : undefined;
    const nextText = (incoming: string) => fullText ?? (s._streamingText + incoming);
    const nextFeedText = (incoming: string) => {
      if (!fullText) return incoming;
      if (fullText.startsWith(s._streamingText)) return fullText.slice(s._streamingText.length);
      return incoming;
    };

    // ── Sub-agent mode: stream into Agent tool call's subMessages ──
    if (s._activeAgentToolId) {
      if (evt.delta.type === "text_delta" && evt.delta.text) {
        const newText = nextText(evt.delta.text);
        const feedText = nextFeedText(evt.delta.text);
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
        return { ...s, messages: msgs, _streamingText: newText, streamFeed: appendFeed(s.streamFeed, feedText) };
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
    // `_streamingText` holds only the round currently streaming; the rounds
    // already finalized live in the bubble's contentBlocks. Now that a whole
    // turn shares one bubble, the two have to be joined or each new round would
    // visibly wipe the ones above it mid-turn.
    if (evt.delta.type === "text_delta" && evt.delta.text) {
      const newText = nextText(evt.delta.text);
      const feedText = nextFeedText(evt.delta.text);
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      const canMerge = canMergeIntoTurn(last);
      // Finalize thinking duration when text starts
      const thinkingDuration = s._thinkingStartedAt && !last?.thinkingDuration
        ? ts - s._thinkingStartedAt : undefined;
      if (canMerge) {
        msgs[msgs.length - 1] = {
          ...last,
          content: textFromBlocks(last.contentBlocks) + newText,
          ...(thinkingDuration != null && { thinkingDuration }),
        };
      } else {
        msgs.push({ id: nextMsgId(), role: "assistant", content: newText, timestamp: ts });
      }
      return { ...s, messages: msgs, _streamingText: newText, _thinkingStartedAt: undefined, streamFeed: appendFeed(s.streamFeed, feedText) };
    }
    if (evt.delta.type === "thinking_delta" && evt.delta.thinking) {
      const newThinking = s._streamingThinking + evt.delta.thinking;
      const startedAt = s._thinkingStartedAt ?? ts;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      const canMerge = canMergeIntoTurn(last);
      if (canMerge) {
        msgs[msgs.length - 1] = { ...last, thinking: thinkingFromBlocks(last.contentBlocks) + newThinking };
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

/**
 * The assistant message this result closes.
 *
 * A turn does not always end on its own message: interrupting appends a
 * `system` divider, and so do profile switches, compaction notices, and
 * provider messages. Requiring the result to land on the literal last message
 * silently dropped the stats for every one of those turns.
 */
function resultTargetIndex(msgs: Message[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "system") continue;
    return msgs[i].role === "assistant" && !msgs[i].meta ? i : -1;
  }
  return -1;
}

function reduceResult(s: ReducerState, m: any, ts: number): ReducerState {
  const msgs = [...s.messages];
  const target = resultTargetIndex(msgs);

  // Finalize the assistant message this result closes with its metadata
  if (target >= 0) {
    const last = msgs[target];
    // Aggregate full-turn content: collect all assistant rounds since the last user message
    let turnText = "";
    let turnThinking = "";
    const turnToolCalls: ToolCall[] = [];
    for (let i = target; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role === "user") break;
      if (msg.role === "assistant" && !msg.meta) {
        const copyText = copyTextFromBlocks(msg.contentBlocks, "text") ?? msg.content;
        const copyThinking = copyTextFromBlocks(msg.contentBlocks, "thinking") ?? msg.thinking;
        if (copyText) turnText = copyText + (turnText ? "\n\n" + turnText : "");
        if (copyThinking) turnThinking = copyThinking + (turnThinking ? "\n\n" + turnThinking : "");
        if (msg.toolCalls?.length) turnToolCalls.unshift(...msg.toolCalls);
      }
    }
    const turnCopy: Message["turnCopy"] = { text: turnText };
    if (turnThinking) turnCopy.thinking = turnThinking;
    if (turnToolCalls.length > 0) turnCopy.toolCalls = turnToolCalls;

    msgs[target] = {
      ...last,
      // The settled metadata row says when the reply landed, not when its first
      // token appeared. Replayed events carry the result row's persisted _ts;
      // live events use the instant the browser received the result.
      timestamp: ts,
      seq: s.lastSeq, // result event seq — used as branch point
      // Persist backend-measured thinking duration (survives refresh)
      ...(m.thinking_duration_ms != null && { thinkingDuration: m.thinking_duration_ms }),
      turnCopy,
      meta: turnMetaFromResultEvent(m, s.model),
    };
  }

  // Surface error text in the chat
  if (m.subtype === "error" && m.error) {
    msgs.push({ id: nextMsgId(), role: "system", content: m.error });
  }

  return {
    ...s,
    status: m.subtype === "interrupted"
      ? "idle"
      : (m.subtype === "success" || m.subtype === "error_max_turns") ? "idle" : "error",
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
