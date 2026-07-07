/**
 * Session Manager — decouples agent lifecycle from HTTP connections.
 *
 * Orchestrates session creation, persistence, SSE broadcasting, and message routing.
 * Provider-specific execution logic lives in providers/ — session-manager delegates
 * to whichever provider the profile specifies.
 *
 * Session-manager owns:
 * - DB row creation (always upfront, before provider starts)
 * - Event persistence + SSE broadcasting
 * - Session ID lifecycle (generate temp, optional rekey by provider)
 * - Subscriber management
 *
 * Session-manager does NOT:
 * - Emit init events (user/prompt, system/init) — that's the provider's job
 * - Know which provider is running — all paths are provider-agnostic
 */

import {
  upsertSession, updateSessionStatus, addEvent, renameSession, getSession,
  getStoredSessionConfig, getSessionsByTag,
  copyEventsToSession, findAssistantUuid, clearBranchFields,
  addSessionTag, parseTags, getMaxSeq, insertSessionArtifact, insertMessage,
} from "./db";
import type { SessionOutcome } from "./action-types";
import { logActivity } from "./activity";
import { canSpawnSession } from "./memory-guard";
import { resolve as resolvePath, dirname as pathDirname, join as pathJoin } from "path";
import { appendFileSync, mkdirSync } from "fs";

// ── SSE flow log ──
// Append-only diagnostic log of every subscriber lifecycle event and broadcast.
// Gitignored, no secrets (only ID prefixes, event types, sizes, counts).
// Tail with: Get-Content harness/.modus/sse-flow.log -Wait
const SSE_LOG = pathJoin(import.meta.dir, ".modus", "sse-flow.log");
try { mkdirSync(pathDirname(SSE_LOG), { recursive: true }); } catch {}
function sseLog(event: string, sid: string | undefined, detail: string): void {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 });
  const sidShort = sid ? sid.slice(0, 12) : "------------";
  const line = `${ts} [${sidShort}] ${event}: ${detail}\n`;
  try { appendFileSync(SSE_LOG, line); } catch { /* ignore */ }
}

// Lazy imports to avoid circular deps
let _onSessionEvent: typeof import("./action-runner").onSessionEvent | null = null;
function getOnSessionEvent() {
  if (!_onSessionEvent) {
    _onSessionEvent = require("./action-runner").onSessionEvent;
  }
  return _onSessionEvent!;
}

let _handleWorkerDeath: typeof import("./mission-runner").handleWorkerDeath | null = null;
function getHandleWorkerDeath() {
  if (!_handleWorkerDeath) {
    _handleWorkerDeath = require("./mission-runner").handleWorkerDeath;
  }
  return _handleWorkerDeath!;
}

let _gatherAmbientContext: typeof import("./move-runner").gatherAmbientContext | null = null;
function getGatherAmbientContext() {
  if (!_gatherAmbientContext) {
    _gatherAmbientContext = require("./move-runner").gatherAmbientContext;
  }
  return _gatherAmbientContext!;
}

let _onWakeSessionEvent: typeof import("./wake-scheduler").onWakeSessionEvent | null = null;
function getOnWakeSessionEvent() {
  if (!_onWakeSessionEvent) {
    _onWakeSessionEvent = require("./wake-scheduler").onWakeSessionEvent;
  }
  return _onWakeSessionEvent!;
}

let _activateMoveBindings: typeof import("./move-runner").activateMoveBindings | null = null;
function getActivateMoveBindings() {
  if (!_activateMoveBindings) {
    _activateMoveBindings = require("./move-runner").activateMoveBindings;
  }
  return _activateMoveBindings!;
}

let _rekeyMoveByToken: typeof import("./move-runner").rekeyMoveByToken | null = null;
function getRekeyMoveByToken() {
  if (!_rekeyMoveByToken) {
    _rekeyMoveByToken = require("./move-runner").rekeyMoveByToken;
  }
  return _rekeyMoveByToken!;
}
import { getProfile, getUserData, getUserProfile } from "./profiles";
import { getProvider } from "./providers/registry";
import type { SessionProvider, TurnContext } from "./providers/types";

// ── Types ──

export type SessionStatus = "starting" | "running" | "interrupting" | "idle" | "paused" | "done" | "error";

export type ExchangePayload = {
  sessionId: string;
  exchangeCount: number;
  status: SessionStatus;
  lastResponse: string | undefined;
  costUsd: number;
  seq: number;
};

type SessionTerminalWatcher = {
  kind: "terminal";
  resolve: (outcome: SessionOutcome) => void;
};

type SessionExchangeWatcher = {
  kind: "exchange";
  onExchange: (payload: ExchangePayload) => void;
};

type SessionWatcher = SessionTerminalWatcher | SessionExchangeWatcher;

export type SSEWriter = {
  write(event: string, data: string, id: string): Promise<void>;
  close(): void;
};

export type ImageAttachment = {
  type: "image";
  mediaType: string;
  data: string;
  name?: string;
};

export type SessionArtifactRef = {
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

/** Content can be a plain string or structured content blocks (for images) */
export type MessageContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
>;

export type DispatchMode = "next_turn" | "steer" | "interrupt_then_send";
export type DispatchState = "idle" | "dispatching_followup";

export type PendingDispatchItem = {
  id: string;
  content: MessageContent;
  mode: DispatchMode;
  createdAt: number;
  status: "pending" | "dispatching";
  source: "user" | "sdk" | "action";
};

type LiveStreamSnapshot = {
  text: string;
  thinking: string;
  feed: string;
  seq: number;
};

type SemanticToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
};

type PendingAssistantTurn = {
  seq: number;
  text: string;
  thinking: string;
  toolCalls: Map<string, SemanticToolCall>;
  uuid?: string;
  timestamp: number;
};

export type ActiveSession = {
  sessionId: string;
  tempId: string;
  status: SessionStatus;
  profile: string | undefined;
  provider: string;
  model: string | undefined;
  seq: number;
  startedAt: number;
  lastEventAt: number;
  costUsd: number;
  numTurns: number;
  /** Count of complete user↔assistant exchanges (1 per result event). Used for session trigger round matching. */
  exchangeCount: number;
  error: string | null;
  preview: string;
  lastAssistantText: string;
  liveStream: LiveStreamSnapshot;
  pendingAssistantTurn: PendingAssistantTurn | null;
  initialPrompt: string;
  initialContent: MessageContent;
  subscribers: Set<SSEWriter>;
  abortController: AbortController;
  dispatchState: DispatchState;
  pendingDispatch: PendingDispatchItem[];
  turnStartedAt: number;
  cwd?: string;
  /** The project root where .modus/ lives — before profile CWD override is applied.
   *  Used for profile/config lookups that must find .modus/ at the project root. */
  projectRoot?: string;
  additionalDirectories: string[];
  actionName?: string;
  userProfile?: string;
  pauseRequested: boolean;
  pauseResolver: (() => void) | null;
  pendingPermissions: Map<string, {
    resolve: (result: { behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }) => void;
    toolName: string;
    input: Record<string, unknown>;
    requestedAt: number;
  }>;
  sessionApprovals: Set<string>;
  watchers: Set<SessionWatcher>;
  /** Every OS PID this session has ever spawned via its provider that we
   *  have not yet confirmed dead. Providers MUST add to this set on every
   *  spawn (cold start, resume, restart-after-error) and MUST NOT remove
   *  entries except via a real kill. The process registry reads this so the
   *  UI can show — and force-kill — every underlying child, including
   *  ghosts left behind by past turns of the same session. */
  osPids: Set<number>;
  /** Provider implementation for this session */
  _provider: SessionProvider;
  /** Provider-specific state (opaque to session-manager) */
  _providerState: unknown;
  /** Live config overrides set by the user via ConfigBar */
  _configOverrides: {
    provider?: string;
    effort?: string;
    maxTurns?: number;
    tools?: string[];
    disallowedTools?: string[];
    toolStates?: Record<string, string>;
    providerControls?: Record<string, unknown>;
    loadProjectSettings?: boolean;
    additionalDirectories?: string[];
  };
};

export function createPendingDispatchItem(
  content: MessageContent,
  mode: DispatchMode = "next_turn",
  source: PendingDispatchItem["source"] = "user",
  status: PendingDispatchItem["status"] = "pending",
): PendingDispatchItem {
  return {
    id: `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content,
    mode,
    createdAt: Date.now(),
    status,
    source,
  };
}

// ── Helpers ──

export function buildContent(prompt: string, attachments?: ImageAttachment[]): MessageContent {
  if (!attachments?.length) return prompt;
  const blocks: MessageContent = [];
  for (const att of attachments) {
    (blocks as any[]).push({
      type: "image",
      source: { type: "base64", media_type: att.mediaType, data: att.data },
    });
  }
  if (prompt) (blocks as any[]).push({ type: "text", text: prompt });
  return blocks;
}

export function contentPreview(content: MessageContent, maxLen = 80): string {
  if (typeof content === "string") return content.slice(0, maxLen);
  const textBlock = (content as any[]).find((b: any) => b.type === "text");
  const text = textBlock?.text ?? "";
  const imgCount = (content as any[]).filter((b: any) => b.type === "image").length;
  const prefix = imgCount > 0 ? `[${imgCount} image${imgCount > 1 ? "s" : ""}] ` : "";
  return (prefix + text).slice(0, maxLen);
}

// ── Active Sessions Map ──

const activeSessions = new Map<string, ActiveSession>();

export function getActiveSession(id: string): ActiveSession | undefined {
  return activeSessions.get(id);
}

export function getAllActiveSessions(): ActiveSession[] {
  return Array.from(activeSessions.values());
}

// ── Session Watchers ──

function fireWatchers(session: ActiveSession, payload: ExchangePayload): void {
  const toRemove: SessionWatcher[] = [];

  for (const watcher of session.watchers) {
    if (watcher.kind === "terminal") {
      watcher.resolve({
        sessionStatus: payload.status === "error" ? "error" : "done",
        response: payload.lastResponse ?? null,
        summary: payload.lastResponse?.slice(0, 500) ?? null,
        costUsd: payload.costUsd,
        error: payload.status === "error" ? (session.error ?? "unknown error") : null,
      });
      toRemove.push(watcher);
    } else {
      watcher.onExchange(payload);
    }
  }

  for (const w of toRemove) session.watchers.delete(w);
}

/** One-shot: resolves when the session reaches idle/done/error. */
export function watchSession(sessionId: string): Promise<SessionOutcome> {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return Promise.resolve({
      sessionStatus: "error" as const,
      response: null, summary: null, costUsd: 0,
      error: "session not found",
    });
  }

  if (session.status === "idle" || session.status === "done" || session.status === "error") {
    return Promise.resolve({
      sessionStatus: session.status === "error" ? "error" as const : "done" as const,
      response: session.lastAssistantText ?? null,
      summary: session.lastAssistantText?.slice(0, 500) ?? null,
      costUsd: session.costUsd,
      error: session.error,
    });
  }

  return new Promise<SessionOutcome>((resolve) => {
    session.watchers.add({ kind: "terminal", resolve });
  });
}

/** Persistent: fires on every assistant round end. Returns an unregister function. */
export function watchSessionExchanges(
  sessionId: string,
  onExchange: (payload: ExchangePayload) => void,
): () => void {
  const session = activeSessions.get(sessionId);
  if (!session) return () => {};
  const watcher: SessionExchangeWatcher = { kind: "exchange", onExchange };
  session.watchers.add(watcher);
  return () => { session.watchers.delete(watcher); };
}

// ── TurnContext Factory ──
// Creates the context object that providers use to interact with session-manager.

function createTurnContext(session: ActiveSession, opts: StartSessionOpts): TurnContext {
  // Profile lookup must use the project root (where .modus/ lives), not the resolved
  // session CWD — which may be a profile-scoped subfolder (e.g. td_navigator/).
  const profileLookupCwd = session.projectRoot ?? opts.cwd ?? session.cwd;
  const profile = opts.profile ? getProfile(opts.profile, profileLookupCwd) : undefined;

  return {
    session,
    opts,
    profile,

    emitEvent(event: any) {
      persistAndBroadcastEvent(session, event);
    },

    broadcastEvent(event: any) {
      const data = JSON.stringify(event);
      const seqStr = String(session.seq);
      for (const sub of session.subscribers) {
        try {
          const result = sub.write(event.type, data, seqStr);
          if (result && typeof result.catch === "function") {
            result.catch(() => { session.subscribers.delete(sub); });
          }
        } catch { session.subscribers.delete(sub); }
      }
    },

    notifyConfigChange(patch: Record<string, unknown>) {
      updateSessionConfig(session.sessionId, patch);
    },

    rekeySession(newId: string) {
      const oldId = session.sessionId;
      activeSessions.delete(oldId);
      session.sessionId = newId;
      activeSessions.set(newId, session);
      if (oldId !== newId) {
        renameSession(oldId, newId);
      }
      sseLog("REKEY", newId,
        `from=${oldId.slice(0, 12)} to=${newId.slice(0, 12)} subsRetained=${session.subscribers.size} status=${session.status}`);
    },

    updateSessionDb(updates) {
      const completing = updates.status === "idle" || updates.status === "done";
      const terminal = completing || updates.status === "error";
      const persistedMessageCount = updates.messageCount ?? (
        completing
          ? (session.exchangeCount + 1) * 2
          : session.exchangeCount * 2
      );
      const completedExchange = completing && persistedMessageCount > session.exchangeCount * 2;
      upsertSession({
        id: session.sessionId,
        preview: session.preview,
        profile: session.profile,
        provider: updates.provider ?? session.provider,
        model: session.model,
        status: updates.status ?? session.status,
        messageCount: persistedMessageCount,
        costUsd: updates.costUsd ?? session.costUsd,
        lastPrompt: updates.lastPrompt ?? session.preview,
        lastResponse: updates.lastResponse,
        cwd: session.cwd,
        actionName: session.actionName,
      });

      // Emit session trigger: assistant round end (on successful turn completion)
      if (completedExchange) {
        // exchangeCount tracks user↔assistant rounds (1 per result), not SDK agentic turns
        session.exchangeCount++;
        const dbRow = getSession(session.sessionId);
        const tags = dbRow ? parseTags(dbRow.tags) : [];
        console.log(`[session-trigger] emission: status=${updates.status} exchange=${session.exchangeCount} session=${session.sessionId.slice(0, 12)}…`);
        const assistantEvent = { role: "assistant", round: session.exchangeCount, at: "end" } as const;
        const assistantSessionInfo = {
          id: session.sessionId, userProfile: session.userProfile, tags,
          preview: session.preview, title: dbRow?.title,
          messageCount: persistedMessageCount,
          lastResponse: updates.lastResponse,
          assistantSeq: session.seq,
          assistantMessageUuid: findAssistantUuid(session.sessionId, session.seq) ?? undefined,
        };
        try {
          getOnSessionEvent()(assistantEvent, assistantSessionInfo);
        } catch (err) {
          console.error(`[session-trigger] onSessionEvent failed:`, err);
        }
        try {
          getOnWakeSessionEvent()(assistantEvent, assistantSessionInfo);
        } catch (err) {
          console.error(`[wake] onWakeSessionEvent failed:`, err);
        }
      }

      // Fire session watchers on any terminal status (idle, done, or error)
      if (terminal) {
        fireWatchers(session, {
          sessionId: session.sessionId,
          exchangeCount: session.exchangeCount,
          status: updates.status as SessionStatus,
          lastResponse: updates.lastResponse,
          costUsd: updates.costUsd ?? session.costUsd,
          seq: session.seq,
        });

        // Dead worker recovery: fail any active mission assignments for this session
        try { getHandleWorkerDeath()(session.sessionId); } catch { /* best effort */ }
      }

      // Notify global subscribers (SessionWeb real-time updates)
      if (updates.status) {
        emitGlobalSessionEvent({
          type: "session:status",
          sessionId: session.sessionId,
          status: updates.status as SessionStatus,
          costUsd: updates.costUsd ?? session.costUsd,
          preview: session.preview,
        });
      }
    },
  };
}

// ── Start Session ──

export type StartSessionOpts = {
  prompt: string | MessageContent;
  attachments?: ImageAttachment[];
  profile?: string;
  userProfile?: string;
  provider?: string;
  model?: string;
  toolStates?: Record<string, string>;
  maxTurns?: number;
  effort?: string;
  cwd?: string;
  additionalDirectories?: string[];
  tools?: string[];
  disallowedTools?: string[];
  providerControls?: Record<string, unknown>;
  loadProjectSettings?: boolean;
  sessionId?: string;
  actionName?: string;
  /** Tags to apply to the session on creation (e.g. "move:council", "role:advocate") */
  tags?: string[];
  /** For branched sessions: parent session ID to fork from (SDK resume source) */
  branchParentId?: string;
  /** For branched sessions: SDK message UUID to resume at */
  branchMessageUUID?: string;
  /** Per-session permission policy override — takes precedence over profile permissionPolicy */
  permissionPolicy?: "bypass" | "ask" | { default: "approve" | "ask"; autoApprove?: string[]; requireApproval?: string[] };
  /** Per-request moves to activate on the first message (merged with profile moves) */
  moves?: { name: string; inputs?: Record<string, unknown> }[];
  /** Session-level MCP servers — merged with (and override) profile MCP servers at session creation */
  mcpServers?: Record<string, unknown>;
};

export type InteractSessionOpts = {
  prompt: string;
  sessionId?: string;
  attachments?: ImageAttachment[];
  moves?: QueueMessageMoveBinding[];
  createIfMissing?: boolean;
  cwd?: string;
  additionalDirectories?: string[];
  profile?: string;
  userProfile?: string;
  provider?: string;
  model?: string;
  toolStates?: Record<string, string>;
  maxTurns?: number;
  effort?: string;
  tools?: string[];
  disallowedTools?: string[];
  providerControls?: Record<string, unknown>;
  loadProjectSettings?: boolean;
  permissionPolicy?: StartSessionOpts["permissionPolicy"];
  mcpServers?: Record<string, unknown>;
};

export type InteractSessionResult = {
  sessionId: string;
  status: SessionStatus;
  queued: boolean;
  dispatchId?: string;
};

function resolveSessionCwd(cwd?: string): string {
  return cwd ?? process.env.AGENT_CWD ?? process.cwd();
}

function normalizeAdditionalDirectories(
  baseCwd: string,
  directories?: string[],
): string[] | undefined {
  if (!directories) return undefined;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const dir of directories) {
    if (typeof dir !== "string" || !dir.trim()) continue;
    const resolved = resolvePath(baseCwd, dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

function configEventPayload(config: {
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number | null;
  toolStates?: Record<string, string>;
  providerControls?: Record<string, unknown>;
  cwd?: string;
  loadProjectSettings?: boolean;
}) {
  return {
    provider: config.provider ?? "",
    model: config.model ?? "",
    effort: config.effort ?? "",
    maxTurns: config.maxTurns,
    toolStates: config.toolStates ?? {},
    providerControls: config.providerControls ?? {},
  };
}

function appendLiveFeed(current: string, text: string): string {
  return (current + " " + text).slice(-500);
}

function extractPlainText(content: MessageContent | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
      text += (block as any).text;
    }
  }
  return text;
}

function getOrCreatePendingAssistantTurn(session: ActiveSession): PendingAssistantTurn {
  if (!session.pendingAssistantTurn) {
    session.pendingAssistantTurn = {
      seq: session.seq,
      text: "",
      thinking: "",
      toolCalls: new Map(),
      timestamp: Date.now(),
    };
  }
  return session.pendingAssistantTurn;
}

function persistSemanticMessage(session: ActiveSession, event: any) {
  if (event.type === "user" && (event.subtype === "prompt" || event.message?.role === "user")) {
    const text = extractPlainText(event.message?.content);
    if (!text) return;
    session.pendingAssistantTurn = null;
    insertMessage({
      sessionId: session.sessionId,
      seq: session.seq,
      role: "user",
      content: text,
      createdAt: Date.now(),
    });
    return;
  }

  if (event.type === "assistant") {
    const turn = getOrCreatePendingAssistantTurn(session);
    turn.seq = session.seq;
    if (!turn.uuid && typeof event.uuid === "string") turn.uuid = event.uuid;
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if ((block as any).type === "text" && typeof (block as any).text === "string") {
        turn.text += (block as any).text;
      } else if ((block as any).type === "thinking" && typeof (block as any).thinking === "string") {
        turn.thinking += (block as any).thinking;
      } else if ((block as any).type === "tool_use" && typeof (block as any).id === "string" && typeof (block as any).name === "string") {
        turn.toolCalls.set((block as any).id, {
          id: (block as any).id,
          name: (block as any).name,
          input: (block as any).input && typeof (block as any).input === "object" ? (block as any).input : {},
        });
      }
    }
    return;
  }

  if (event.type === "user" && event.subtype === "tool_result" && session.pendingAssistantTurn) {
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object" || (block as any).type !== "tool_result" || typeof (block as any).tool_use_id !== "string") continue;
      const toolCall = session.pendingAssistantTurn.toolCalls.get((block as any).tool_use_id);
      if (!toolCall) continue;
      toolCall.result = typeof (block as any).content === "string"
        ? (block as any).content
        : JSON.stringify((block as any).content ?? "");
    }
    return;
  }

  if (event.type === "result") {
    const turn = session.pendingAssistantTurn;
    if (!turn) return;
    const content = turn.text || (typeof event.result === "string" ? event.result : "");
    if (!content && !turn.thinking && turn.toolCalls.size === 0) {
      session.pendingAssistantTurn = null;
      return;
    }
    insertMessage({
      sessionId: session.sessionId,
      seq: session.seq,
      role: "assistant",
      content,
      uuid: turn.uuid,
      thinking: turn.thinking || undefined,
      toolCalls: turn.toolCalls.size > 0 ? [...turn.toolCalls.values()] : undefined,
      costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
      durationMs: typeof event.harness_duration_ms === "number" ? event.harness_duration_ms : undefined,
      model: session.model,
      turns: typeof event.num_turns === "number" ? event.num_turns : undefined,
      createdAt: Date.now(),
    });
    session.pendingAssistantTurn = null;
  }
}

function updateLiveStreamSnapshot(session: ActiveSession, event: any) {
  if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta) {
    const delta = event.event.delta;
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      const nextText = typeof event.fullText === "string"
        ? event.fullText
        : session.liveStream.text + delta.text;
      const nextFeed = typeof event.fullText === "string" && nextText.startsWith(session.liveStream.text)
        ? nextText.slice(session.liveStream.text.length)
        : delta.text;
      session.liveStream.text = nextText;
      session.liveStream.feed = appendLiveFeed(session.liveStream.feed, nextFeed);
      session.liveStream.seq = session.seq;
    } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
      session.liveStream.thinking += delta.thinking;
      session.liveStream.feed = appendLiveFeed(session.liveStream.feed, delta.thinking);
      session.liveStream.seq = session.seq;
    }
    return;
  }

  if (event.type !== "stream_event") {
    session.liveStream.text = "";
    session.liveStream.thinking = "";
    session.liveStream.feed = "";
    session.liveStream.seq = session.seq;
  }
}

function persistAndBroadcastEvent(session: ActiveSession, event: any) {
  const _pbt0 = performance.now();
  session.seq++;
  updateLiveStreamSnapshot(session, event);
  persistSemanticMessage(session, event);
  if (event.type === "stream_event") {
    sseLog("LIVE-ONLY", session.sessionId,
      `seq=${session.seq} type=${event.type}${event.subtype ? "/" + event.subtype : ""} subs=${session.subscribers.size}`);
    broadcastEventToSession(session, event, session.seq);
    return;
  }
  addEvent(
    session.sessionId,
    session.seq,
    event.type,
    event.subtype ?? null,
    JSON.stringify(event),
  );
  sseLog("PERSIST", session.sessionId,
    `seq=${session.seq} type=${event.type}${event.subtype ? "/" + event.subtype : ""} subs=${session.subscribers.size}`);
  broadcastEventToSession(session, event, session.seq);
  const _pbMs = performance.now() - _pbt0;
  if (_pbMs > 5) console.log(`[TIMING] persistAndBroadcast ${event.type}/${event.subtype} ${_pbMs.toFixed(1)}ms session=${session.sessionId.slice(0,8)}`);
}

function broadcastEventToSession(session: ActiveSession, event: any, seq = session.seq) {
  const data = JSON.stringify(event);
  const seqStr = String(seq);
  const subsBefore = session.subscribers.size;
  if (subsBefore === 0) {
    sseLog("BROADCAST-NOSUBS", session.sessionId,
      `seq=${seq} type=${event.type}${event.subtype ? "/" + event.subtype : ""} bytes=${data.length} — DROPPED, no subscribers`);
    return;
  }
  let okCount = 0;
  let failCount = 0;
  for (const sub of session.subscribers) {
    try {
      const result = sub.write(event.type, data, seqStr);
      okCount++;
      if (result && typeof result.catch === "function") {
        result.catch((err) => {
          session.subscribers.delete(sub);
          sseLog("SUB-DROP-ASYNC", session.sessionId,
            `subs ${session.subscribers.size + 1}→${session.subscribers.size} reason=${String(err).slice(0, 120)}`);
        });
      }
    } catch (err) {
      failCount++;
      session.subscribers.delete(sub);
      sseLog("SUB-DROP-SYNC", session.sessionId,
        `subs ${session.subscribers.size + 1}→${session.subscribers.size} reason=${String(err).slice(0, 120)}`);
    }
  }
  sseLog("BROADCAST", session.sessionId,
    `seq=${seq} type=${event.type}${event.subtype ? "/" + event.subtype : ""} bytes=${data.length} subs=${subsBefore} ok=${okCount} fail=${failCount}`);
}

/**
 * Broadcast a UI command event to a session's SSE subscribers.
 * These are ephemeral (not persisted to DB) — they trigger frontend actions.
 */
export function broadcastUiEvent(sessionId: string, event: { type: "ui"; action: string; [key: string]: unknown }) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  broadcastEventToSession(session, event);
}

export function attachArtifactToSession(opts: {
  sessionId: string;
  seq: number;
  targetMessageUuid?: string;
  path: string;
  name: string;
  mime: string;
  actionName?: string;
  actionRunId?: number;
  previewText?: string;
  metadata?: Record<string, unknown>;
}): SessionArtifactRef {
  const createdAt = Date.now();
  const artifactId = insertSessionArtifact({
    sessionId: opts.sessionId,
    seq: opts.seq,
    targetMessageUuid: opts.targetMessageUuid,
    actionName: opts.actionName,
    actionRunId: opts.actionRunId,
    name: opts.name,
    mime: opts.mime,
    path: opts.path,
    createdAt,
    previewText: opts.previewText,
    metadata: opts.metadata,
  });

  const artifact: SessionArtifactRef = {
    id: artifactId,
    sessionId: opts.sessionId,
    seq: opts.seq,
    ...(opts.targetMessageUuid ? { targetMessageUuid: opts.targetMessageUuid } : {}),
    name: opts.name,
    mime: opts.mime,
    url: `/api/sessions/${encodeURIComponent(opts.sessionId)}/artifacts/${artifactId}`,
    ...(opts.actionName ? { sourceAction: opts.actionName } : {}),
    createdAt,
    ...(opts.previewText ? { previewText: opts.previewText } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };

  const event = {
    type: "system",
    subtype: "artifact_attached",
    targetSeq: opts.seq,
    ...(opts.targetMessageUuid ? { targetMessageUuid: opts.targetMessageUuid } : {}),
    artifact,
  };

  const nextSeq = getMaxSeq(opts.sessionId) + 1;
  addEvent(opts.sessionId, nextSeq, "system", "artifact_attached", JSON.stringify(event));

  const active = activeSessions.get(opts.sessionId);
  if (active) {
    active.seq = Math.max(active.seq, nextSeq);
    active.lastEventAt = createdAt;
    broadcastEventToSession(active, event, nextSeq);
  }

  return artifact;
}

export function startSession(opts: StartSessionOpts): ActiveSession {
  // Memory guard: block spawn if too many sessions or system memory pressure is high.
  // Count only live sessions — those have CLI processes consuming memory.
  // Idle/error/done sessions are just metadata waiting for reaper cleanup.
  const liveCount = Array.from(activeSessions.values())
    .filter(s => s.status === "running" || s.status === "starting" || s.status === "interrupting").length;
  const guard = canSpawnSession(liveCount);
  if (!guard.ok) {
    throw new Error(`[memory-guard] ${guard.reason}`);
  }

  const baseCwd = resolveSessionCwd(opts.cwd);
  const profileDef = opts.profile ? getProfile(opts.profile, baseCwd) : undefined;
  // Profile CWD override: absolute paths used as-is, relative resolved against baseCwd.
  // This lets agent profiles force a subfolder (e.g. "td-nav") so the SDK auto-discovers
  // skills from <profileCwd>/.claude/skills/ — scoping skills to this agent only.
  const resolvedCwd = profileDef?.cwd
    ? resolvePath(baseCwd, profileDef.cwd)
    : baseCwd;
  const userProf = opts.userProfile ? getUserProfile(opts.userProfile) : undefined;
  // Cascade: session override > agent profile > user profile > default
  const providerName = opts.provider ?? profileDef?.provider ?? userProf?.provider ?? "claude-code";
  const resolvedEffort = opts.effort ?? profileDef?.effort ?? userProf?.effort;
  const resolvedProviderControls = opts.providerControls ?? profileDef?.providerControls;
  const provider = getProvider(providerName);

  // Resolve system prompt template vars
  let systemPrompt = profileDef?.prompt;
  if (systemPrompt) {
    const userData = getUserData();
    systemPrompt = systemPrompt.replace(/\{\{(\w+)\}\}/g, (_, key) => userData[key] ?? `{{${key}}}`);
  }

  const initialContent = typeof opts.prompt === "string"
    ? buildContent(opts.prompt, opts.attachments)
    : opts.prompt; // already MessageContent (content blocks from actions)

  // Session ID: use provided ID (for resume), otherwise generate a stable UUID.
  // Providers may still call rekeySession() but a UUID default eliminates the
  // ses-* temp-ID class of bugs (stale lookups, sidebar invisibility, race conditions).
  const tempId = opts.sessionId ?? crypto.randomUUID();
  const isResume = !!opts.sessionId && !!getSession(opts.sessionId);

  // Branch detection: if resuming a session that has parent_session_id,
  // pass fork opts to the provider and clear the fields so it only forks once.
  if (isResume && !opts.branchParentId) {
    const dbRow = getSession(opts.sessionId!);
    if (dbRow?.parent_session_id && dbRow.branch_message_uuid) {
      opts.branchParentId = dbRow.parent_session_id;
      opts.branchMessageUUID = dbRow.branch_message_uuid;
      // Clear branch fields so next resume is a normal resume, not another fork
      clearBranchFields(opts.sessionId!);
      console.log(`[branch-detect] Will fork ${opts.sessionId} from parent=${opts.branchParentId} at message=${opts.branchMessageUUID}`);
    }
  }

  const resolvedAdditionalDirectories = normalizeAdditionalDirectories(
    resolvedCwd,
    opts.additionalDirectories !== undefined
      ? opts.additionalDirectories
      : profileDef?.additionalDirectories,
  ) ?? [];

  const session: ActiveSession = {
    sessionId: tempId,
    tempId,
    status: "starting",
    profile: opts.profile,
    provider: providerName,
    model: opts.model ?? profileDef?.model ?? userProf?.model,
    seq: 0,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    costUsd: 0,
    numTurns: 0,
    exchangeCount: 0,
    error: null,
    preview: contentPreview(initialContent),
    lastAssistantText: "",
    liveStream: { text: "", thinking: "", feed: "", seq: 0 },
    pendingAssistantTurn: null,
    initialPrompt: typeof opts.prompt === "string" ? opts.prompt : contentPreview(opts.prompt),
    initialContent,
    subscribers: new Set(),
    abortController: new AbortController(),
    dispatchState: "idle",
    pendingDispatch: [],
    turnStartedAt: Date.now(),
    cwd: resolvedCwd,
    projectRoot: baseCwd,
    additionalDirectories: resolvedAdditionalDirectories,
    actionName: opts.actionName,
    userProfile: opts.userProfile,
    pauseRequested: false,
    pauseResolver: null,
    pendingPermissions: new Map(),
    sessionApprovals: new Set(),
    osPids: new Set(),
    watchers: new Set(),
    _provider: provider,
    _providerState: null,
    _configOverrides: {
      provider: opts.provider,
      effort: opts.effort ?? (profileDef?.effort === undefined ? userProf?.effort : undefined),
      maxTurns: opts.maxTurns,
      tools: opts.tools,
      disallowedTools: opts.disallowedTools,
      toolStates: opts.toolStates,
      providerControls: opts.providerControls,
      loadProjectSettings: opts.loadProjectSettings,
      additionalDirectories: opts.additionalDirectories !== undefined
        ? (normalizeAdditionalDirectories(resolvedCwd, opts.additionalDirectories) ?? [])
        : undefined,
    },
  };

  activeSessions.set(tempId, session);
  sseLog("SESSION-REGISTERED", tempId,
    `provider=${session.provider} profile=${session.profile ?? "-"} resume=${isResume} totalActive=${activeSessions.size}`);

  // DB row: always exists before provider starts.
  // Resume: update status on existing row (preserves cost, message count, etc.)
  // New: create fresh row.
  if (isResume) {
    updateSessionStatus(tempId, "starting");
    // Seed exchangeCount from persisted message_count so session triggers
    // don't re-fire (e.g. round:1 won't match an established session after restart)
    const resumeRow = getSession(tempId);
    if (resumeRow?.message_count) {
      session.exchangeCount = Math.ceil(resumeRow.message_count / 2);
    }
  } else {
    upsertSession({
      id: tempId,
      preview: session.preview,
      profile: session.profile,
      provider: session.provider,
      model: session.model,
      status: "starting",
      messageCount: 0,
      costUsd: 0,
      lastPrompt: session.preview,
      cwd: session.cwd,
      actionName: session.actionName,
      userProfile: session.userProfile,
    });
    // Auto-tag action-spawned sessions as internal (prevents cascade triggers)
    if (session.actionName) {
      addSessionTag(tempId, "internal");
    }
    // Apply caller-provided tags (e.g. move-spawned sessions)
    if (opts.tags?.length) {
      for (const tag of opts.tags) {
        addSessionTag(tempId, tag);
      }
    }
  }

  // Notify global subscribers (SessionWeb real-time updates)
  emitGlobalSessionEvent({
    type: "session:created",
    sessionId: tempId,
    status: session.status,
    profile: session.profile,
    userProfile: session.userProfile,
    preview: session.preview,
  });

  // Delegate to provider — provider handles init events (user/prompt, system/init)
  const ctx = createTurnContext(session, {
    ...opts,
    cwd: resolvedCwd,
    provider: providerName,
    model: session.model ?? undefined,
    effort: resolvedEffort,
    providerControls: resolvedProviderControls,
    additionalDirectories: session.additionalDirectories,
  });
  provider.startTurn(ctx);

  logActivity({
    userProfile: session.userProfile,
    eventType: "session_start",
    sessionId: session.sessionId,
    agentProfile: session.profile,
    summary: `Session started: ${session.preview.slice(0, 100)}`,
    metadata: { provider: providerName, model: session.model, cwd: session.cwd, isResume },
  });

  // Emit session trigger: user round 1 start (for new sessions only)
  if (!isResume) {
    const dbRow = getSession(tempId);
    const tags = dbRow ? parseTags(dbRow.tags) : [];
    getOnSessionEvent()(
      { role: "user", round: 1, at: "start" },
      { id: tempId, userProfile: session.userProfile, tags, preview: session.preview, title: null, messageCount: 0 },
    );
  }

  return session;
}

async function waitForProviderInit(session: ActiveSession, timeoutMs = 15_000): Promise<void> {
  // Provider init is where some backends rekey from Modus' provisional UUID to
  // their real session/thread ID. API callers need the post-init ID when possible.
  const start = Date.now();
  while (session.status === "starting" && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 200));
  }
}

/**
 * Start a session with auto-activated profile moves.
 * Handles the two-phase move binding lifecycle:
 *   Phase 1 (pre-spawn): gather inline moves, prepend to prompt
 *   Phase 2 (post-spawn): activate persistent moves on the real session ID
 *
 * Returns the ActiveSession (same as startSession) after all moves are wired up.
 */
export async function startSessionWithMoves(opts: StartSessionOpts): Promise<ActiveSession> {
  const _t0 = performance.now();
  const _timing = (step: string) => console.log(`[session-timing] step=${step} dt=${(performance.now() - _t0).toFixed(0)}ms`);
  _timing("enter");
  const baseCwd = resolveSessionCwd(opts.cwd);
  const profileDef = opts.profile ? getProfile(opts.profile, baseCwd) : undefined;
  const profileMoves = profileDef?.moves ?? [];
  const requestMoves = opts.moves ?? [];
  const allMoves = [...profileMoves, ...requestMoves];

  // No moves declared → fast path, just start normally
  if (!allMoves.length) {
    const session = startSession(opts);
    await waitForProviderInit(session);
    return session;
  }

  const resolvedCwd = profileDef?.cwd
    ? resolvePath(baseCwd, profileDef.cwd)
    : baseCwd;

  // Phase 1: gather inline (non-persistent) moves before session starts
  const activateMoveBindings = getActivateMoveBindings();
  const logPrefix = requestMoves.length
    ? `profile:${opts.profile ?? "none"}+request`
    : `profile:${opts.profile}`;
  const phase1 = await activateMoveBindings(
    allMoves,
    "", // no session ID yet
    resolvedCwd,
    opts.userProfile,
    { persistentOnly: false, logPrefix },
  );

  // Prepend inline move context to the prompt
  let prompt = opts.prompt;
  if (phase1.inlineContext) {
    if (typeof prompt === "string") {
      prompt = `${phase1.inlineContext}\n\n${prompt}`;
    } else {
      // MessageContent array — prepend as text block
      prompt = [{ type: "text" as const, text: phase1.inlineContext }, ...(prompt as any[])];
    }
  }

  _timing("pre-startSession");
  // Start the session with the augmented prompt
  const session = startSession({ ...opts, prompt });

  _timing("post-startSession");
  // Wait for provider init (rekey happens during init — session.sessionId becomes the
  // backend-assigned ID).  Condition: status leaves "starting" once the provider fires
  // its first init event.  Timeout prevents blocking forever on provider failure.
  await waitForProviderInit(session);

  // Rekey inline API move registrations to the real session ID
  const rekeyMoveByToken = getRekeyMoveByToken();
  for (const token of phase1.apiTokens) {
    rekeyMoveByToken(token, session.sessionId);
  }

  // Phase 2: activate persistent moves on the real session
  await activateMoveBindings(
    allMoves,
    session.sessionId,
    resolvedCwd,
    opts.userProfile,
    { persistentOnly: true, logPrefix },
  );

  return session;
}

export async function interactWithSession(opts: InteractSessionOpts): Promise<InteractSessionResult> {
  const {
    prompt,
    sessionId,
    attachments,
    moves,
    createIfMissing = true,
    cwd,
    additionalDirectories,
    profile,
    userProfile,
    provider,
    model,
    toolStates,
    maxTurns,
    effort,
    tools,
    disallowedTools,
    providerControls,
    loadProjectSettings,
    permissionPolicy,
    mcpServers,
  } = opts;

  const resolvedCwd = cwd ?? resolveSessionCwd(undefined);

  if (sessionId) {
    const active = getActiveSession(sessionId);
    if (active) {
      const queued = queueMessage(sessionId, prompt, attachments, moves);
      return {
        sessionId,
        status: active.status,
        queued: queued.queued,
        dispatchId: queued.dispatchId,
      };
    }

    const existing = getSession(sessionId);
    if (!existing && !createIfMissing) {
      throw new Error(`session not found: ${sessionId}`);
    }

    const storedConfig = existing ? getStoredSessionConfig(sessionId) : undefined;
    const session = await startSessionWithMoves({
      prompt,
      attachments,
      moves,
      sessionId,
      cwd: cwd ?? storedConfig?.cwd ?? existing?.cwd ?? resolvedCwd,
      additionalDirectories: additionalDirectories ?? storedConfig?.additionalDirectories,
      profile: profile ?? existing?.profile ?? undefined,
      userProfile,
      provider: provider ?? storedConfig?.provider,
      model: model ?? storedConfig?.model ?? existing?.model ?? undefined,
      toolStates: toolStates ?? storedConfig?.toolStates,
      maxTurns: maxTurns ?? storedConfig?.maxTurns,
      effort: effort ?? storedConfig?.effort,
      tools: tools ?? storedConfig?.tools,
      disallowedTools: disallowedTools ?? storedConfig?.disallowedTools,
      providerControls: providerControls ?? storedConfig?.providerControls,
      loadProjectSettings: loadProjectSettings ?? storedConfig?.loadProjectSettings,
      permissionPolicy,
      mcpServers,
    });

    return {
      sessionId: session.sessionId,
      status: session.status,
      queued: true,
    };
  }

  if (!createIfMissing) {
    throw new Error("sessionId required when createIfMissing is false");
  }

  const session = await startSessionWithMoves({
    prompt,
    attachments,
    moves,
    profile,
    userProfile,
    provider,
    model,
    toolStates,
    maxTurns,
    effort,
    cwd: resolvedCwd,
    additionalDirectories,
    tools,
    disallowedTools,
    providerControls,
    loadProjectSettings,
    permissionPolicy,
    mcpServers,
  });

  return {
    sessionId: session.sessionId,
    status: session.status,
    queued: true,
  };
}

export type DeliverResult = { delivered: string[]; missed: boolean };

/**
 * Deliver a message to one or more existing sessions identified by `target`,
 * which is either a session id or a tag. A session id (live or persisted)
 * delivers to that one session; otherwise `target` is treated as a tag and the
 * message fans out to every non-archived session carrying it. Idle targets
 * start a turn (= wake); running targets queue (drained at the turn's end).
 *
 * Never throws — missing targets are logged and reported via `missed`. Shared by
 * webhook session routing (action-runner) and ctx.sessions.wake (harness-context).
 */
export async function deliverToSession(target: string, content: string): Promise<DeliverResult> {
  const ids: string[] = [];
  if (getActiveSession(target) || getSession(target)) {
    ids.push(target);
  } else {
    for (const row of getSessionsByTag(target)) ids.push(row.id);
  }

  if (ids.length === 0) {
    console.warn(`[deliver] no session matched target "${target}" — skipping delivery`);
    return { delivered: [], missed: true };
  }

  const delivered: string[] = [];
  for (const id of ids) {
    try {
      await interactWithSession({ sessionId: id, prompt: content, createIfMissing: false });
      delivered.push(id);
    } catch (err) {
      console.error(`[deliver] failed to deliver to session ${id}:`, err);
    }
  }
  return { delivered, missed: delivered.length === 0 };
}

// ── Session Control ──

export type QueueMessageMoveBinding = { name: string; inputs?: Record<string, unknown> };

function beginFollowupDispatch(session: ActiveSession): void {
  session.dispatchState = "dispatching_followup";
}

function endFollowupDispatch(session: ActiveSession): void {
  session.dispatchState = "idle";
}

function removePendingDispatch(session: ActiveSession, dispatchId: string): PendingDispatchItem | null {
  const idx = session.pendingDispatch.findIndex((item) => item.id === dispatchId);
  if (idx < 0) return null;
  const [removed] = session.pendingDispatch.splice(idx, 1);
  return removed ?? null;
}

export function cancelQueuedDispatch(sessionId: string, dispatchId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  const item = session.pendingDispatch.find((entry) => entry.id === dispatchId);
  if (!item || item.status !== "pending") return false;
  removePendingDispatch(session, dispatchId);
  return true;
}

export function queueMessage(
  sessionId: string,
  prompt: string,
  attachments?: ImageAttachment[],
  moves?: QueueMessageMoveBinding[],
): { queued: boolean; dispatchId?: string } {
  const session = activeSessions.get(sessionId);
  if (!session) return { queued: false };

  beginFollowupDispatch(session);

  // Gather ambient move context (async, fire-and-forget wrapper)
  // We need to do this before sending so context is included in the user message.
  const pendingId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  void _queueMessageAsync(session, sessionId, pendingId, prompt, attachments, moves).catch((err) => {
    console.error(`[session-manager] _queueMessageAsync failed for ${sessionId}:`, err);
    endFollowupDispatch(session);
    removePendingDispatch(session, pendingId);
    persistAndBroadcastEvent(session, { type: "error", message: `Message delivery failed: ${err?.message ?? err}` });
    persistAndBroadcastEvent(session, { type: "done" });
  });
  return { queued: true, dispatchId: pendingId };
}

async function _queueMessageAsync(
  session: ActiveSession,
  sessionId: string,
  dispatchId: string,
  prompt: string,
  attachments?: ImageAttachment[],
  moves?: QueueMessageMoveBinding[],
): Promise<void> {
  // Run ambient gathers before building content
  let augmentedPrompt = prompt;
  try {
    const ambientContext = await getGatherAmbientContext()(sessionId);
    if (ambientContext) {
      augmentedPrompt = `${ambientContext}\n\n${prompt}`;
    }
  } catch (err) {
    console.error(`[session-manager] ambient gather failed for ${sessionId}:`, err);
  }

  // Activate inline moves requested with this message
  if (moves && moves.length > 0) {
    try {
      const cwd = session.projectRoot ?? session.cwd ?? process.cwd();
      console.log(`[session-manager] activating ${moves.length} message moves for ${sessionId} (cwd=${cwd}):`, moves.map(m => m.name).join(", "));
      // Phase 1: gather inline (non-persistent) moves
      const bindingResult = await getActivateMoveBindings()(
        moves, sessionId, cwd, session.userProfile,
        { persistentOnly: false, logPrefix: "message-moves" },
      );
      // Phase 2: activate persistent moves (ambient gathers)
      await getActivateMoveBindings()(
        moves, sessionId, cwd, session.userProfile,
        { persistentOnly: true, logPrefix: "message-moves" },
      );
      if (bindingResult.inlineContext) {
        console.log(`[session-manager] inline context generated (${bindingResult.inlineContext.length} chars) for moves: ${moves.map(m => m.name).join(", ")}`);
        augmentedPrompt = `${bindingResult.inlineContext}\n\n${augmentedPrompt}`;
      } else {
        console.warn(`[session-manager] NO inline context from moves: ${moves.map(m => m.name).join(", ")} — gather may have returned null`);
      }
    } catch (err) {
      console.error(`[session-manager] message move activation failed for ${sessionId}:`, err);
    }
  }

  const content = buildContent(augmentedPrompt, attachments);

  // Persist user event for catch-up replay
  session.seq++;
  addEvent(sessionId, session.seq, "user", "prompt", JSON.stringify({
    type: "user",
    subtype: "prompt",
    message: { role: "user", content },
  }));

  const isActiveTurn = session.status === "running" || session.status === "starting" || session.status === "interrupting";
  const pendingItem = createPendingDispatchItem(
    content,
    "next_turn",
    "user",
    isActiveTurn || session.status === "paused" ? "pending" : "dispatching",
  );
  pendingItem.id = dispatchId;
  session.pendingDispatch.push(pendingItem);

  // If paused, queue the message — it will be flushed on resume
  if (session.status === "paused") {
    endFollowupDispatch(session);
    return;
  }

  if (isActiveTurn) {
    endFollowupDispatch(session);
    return;
  }

  // Emit session trigger: user round start (exchangeCount is 0-based before this exchange completes)
  const userRound = session.exchangeCount + 1;
  const dbRow = getSession(sessionId);
  const tags = dbRow ? parseTags(dbRow.tags) : [];
  const userEvent = { role: "user", round: userRound, at: "start" } as const;
  const userSessionInfo = { id: sessionId, userProfile: session.userProfile, tags, preview: session.preview, title: dbRow?.title, messageCount: session.exchangeCount * 2 };
  getOnSessionEvent()(userEvent, userSessionInfo);
  try {
    getOnWakeSessionEvent()(userEvent, userSessionInfo);
  } catch (err) {
    console.error(`[wake] onWakeSessionEvent failed:`, err);
  }

  // Delegate to provider (provider sets status to "running" internally)
  // Include stored config overrides so provider init events reflect current state
  const ctx = createTurnContext(session, {
    prompt: augmentedPrompt,
    attachments,
    profile: session.profile,
    sessionId,
    model: session.model,
    ...session._configOverrides,
    cwd: session.cwd,
    additionalDirectories: session.additionalDirectories,
  });
  try {
    session._provider.sendMessage(ctx, content);
    removePendingDispatch(session, dispatchId);
    endFollowupDispatch(session);
  } catch (err) {
    endFollowupDispatch(session);
    throw err;
  }
}

/**
 * Inject a message at the next tool boundary (steer mode).
 * Falls back to queue if the provider doesn't support mid-run injection.
 * Returns false if the session doesn't exist.
 */
export function steerMessage(sessionId: string, prompt: string, attachments?: ImageAttachment[]): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  const content = buildContent(prompt, attachments);
  const ctx = createTurnContext(session, {
    prompt,
    attachments,
    profile: session.profile,
    sessionId,
    model: session.model,
    ...session._configOverrides,
    cwd: session.cwd,
    additionalDirectories: session.additionalDirectories,
  });

  const steered = session._provider.steerMessage?.(ctx, content) ?? false;
  if (steered) {
    // Persist the event so it shows in the transcript
    session.seq++;
    addEvent(sessionId, session.seq, "user", "prompt", JSON.stringify({
      type: "user",
      subtype: "prompt",
      message: { role: "user", content },
    }));
    return true;
  }

  // Provider doesn't support steering — fall back to queue
  return queueMessage(sessionId, prompt, attachments).queued;
}

export function stopSession(sessionId: string): boolean {
  const t0 = performance.now();
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  // Resolve pending pause before aborting
  if (session.pauseResolver) {
    session.pauseResolver();
    session.pauseResolver = null;
  }
  session.pauseRequested = false;

  // Resolve any pending permission promises before aborting
  for (const [id, pending] of session.pendingPermissions) {
    pending.resolve({ behavior: "deny", message: "Session interrupted" });
    session.pendingPermissions.delete(id);
  }

  // Interrupting a session should also discard queued next-turn messages.
  session.pendingDispatch = [];
  endFollowupDispatch(session);

  // Do NOT force idle here. Escape means "stop requested", not "stopped".
  // Keep the turn visibly active until the provider proves teardown completed.
  session.status = "interrupting";
  updateSessionStatus(session.sessionId, "interrupting");
  emitGlobalSessionEvent({
    type: "session:status",
    sessionId: session.sessionId,
    status: "interrupting",
    costUsd: session.costUsd,
    preview: session.preview,
  });

  const interruptData = JSON.stringify({ type: "system", subtype: "interrupted" });
  session.seq++;
  addEvent(session.sessionId, session.seq, "system", "interrupted", interruptData);
  for (const sub of session.subscribers) {
    try { const r = sub.write("system", interruptData, String(session.seq)); r?.catch?.(() => { session.subscribers.delete(sub); }); } catch { session.subscribers.delete(sub); }
  }

  // Delegate to provider for cleanup
  session._provider.abort(session);

  setTimeout(() => {
    const current = activeSessions.get(sessionId);
    if (!current || current.status !== "interrupting") return;
    forceClearActiveSession(sessionId, "idle", "interrupt timed out");
  }, INTERRUPT_FORCE_IDLE_AFTER_MS);

  logActivity({
    userProfile: session.userProfile,
    eventType: "agent_interrupted",
    sessionId: session.sessionId,
    agentProfile: session.profile,
    summary: "Session interrupted by user",
  });

  console.log(`[TIMING] stopSession ${sessionId.slice(0,8)} took ${(performance.now() - t0).toFixed(1)}ms`);
  return true;
}

export function stopTask(sessionId: string, taskId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  return session._provider.stopTask?.(session, taskId) ?? false;
}

// ── Pause / Resume ──

export function pauseSession(sessionId: string): { ok: boolean; status?: SessionStatus } {
  const session = activeSessions.get(sessionId);
  if (!session) return { ok: false };
  if (session.status === "paused") return { ok: true, status: "paused" };

  if (session.status === "running" || session.status === "starting") {
    // Agent is mid-turn — flag it so the provider pauses at next tool boundary
    session.pauseRequested = true;
    const eventData = JSON.stringify({ type: "system", subtype: "pause_requested" });
    session.seq++;
    addEvent(session.sessionId, session.seq, "system", "pause_requested", eventData);
    for (const sub of session.subscribers) {
      try { const r = sub.write("system", eventData, String(session.seq)); r?.catch?.(() => { session.subscribers.delete(sub); }); } catch { session.subscribers.delete(sub); }
    }
    return { ok: true, status: session.status };
  }

  if (session.status === "idle") {
    // Not running — pause immediately
    session.status = "paused";
    updateSessionStatus(session.sessionId, "paused");
    const eventData = JSON.stringify({ type: "system", subtype: "paused" });
    session.seq++;
    addEvent(session.sessionId, session.seq, "system", "paused", eventData);
    for (const sub of session.subscribers) {
      try { const r = sub.write("system", eventData, String(session.seq)); r?.catch?.(() => { session.subscribers.delete(sub); }); } catch { session.subscribers.delete(sub); }
    }
    return { ok: true, status: "paused" };
  }

  return { ok: false };
}

export function resumeSession(sessionId: string): { ok: boolean; status?: SessionStatus } {
  const session = activeSessions.get(sessionId);
  if (!session) return { ok: false };

  // Clear pending pause flag if it hasn't been consumed yet
  if (session.pauseRequested) {
    session.pauseRequested = false;
  }

  if (session.status !== "paused") return { ok: true, status: session.status };

  // Emit resumed event
  const eventData = JSON.stringify({ type: "system", subtype: "resumed" });
  session.seq++;
  addEvent(session.sessionId, session.seq, "system", "resumed", eventData);
  for (const sub of session.subscribers) {
    try { const r = sub.write("system", eventData, String(session.seq)); r?.catch?.(() => { session.subscribers.delete(sub); }); } catch { session.subscribers.delete(sub); }
  }

  if (session.pauseResolver) {
    // Was paused at a tool boundary — resolve the held promise to continue
    session.status = "running";
    updateSessionStatus(session.sessionId, "running");
    session.pauseResolver();
    session.pauseResolver = null;
  } else if (session.pendingDispatch.length > 0) {
    // Was paused while idle with queued messages — flush them
    const next = session.pendingDispatch.shift()!;
    const ctx = createTurnContext(session, {
      prompt: typeof next.content === "string" ? next.content : "",
      profile: session.profile,
      sessionId,
      model: session.model,
      ...session._configOverrides,
      cwd: session.cwd,
      additionalDirectories: session.additionalDirectories,
    });
    session.status = "starting";
    updateSessionStatus(session.sessionId, "starting");
    session._provider.sendMessage(ctx, next.content);
  } else {
    // Was paused while idle, no pending messages
    session.status = "idle";
    updateSessionStatus(session.sessionId, "idle");
  }

  return { ok: true, status: session.status };
}

export function updateSessionConfig(
  sessionId: string,
  config: {
    provider?: string;
    model?: string;
    effort?: string;
    maxTurns?: number | null;
    tools?: string[];
    disallowedTools?: string[];
    toolStates?: Record<string, string>;
    providerControls?: Record<string, unknown>;
    cwd?: string;
    loadProjectSettings?: boolean;
    additionalDirectories?: string[];
  },
): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  const nextCwd = config.cwd !== undefined ? resolveSessionCwd(config.cwd) : resolveSessionCwd(session.cwd);
  const profileDef = getProfile(session.profile ?? "", nextCwd);
  const profileProvider = profileDef?.provider ?? "claude-code";
  const compatibleProfileModel = profileProvider === session.provider
    ? profileDef?.model
    : undefined;
  if (config.provider !== undefined) {
    const requestedProvider = config.provider || profileProvider || session.provider;
    if (requestedProvider !== session.provider) {
      console.warn(
        `[session-config] Rejecting provider change for active session ${sessionId}: ` +
        `${session.provider} -> ${requestedProvider}. Provider switching requires a new session.`,
      );
      return false;
    }
  }
  if (config.model !== undefined) {
    session.model = config.model || compatibleProfileModel || session.model;
  }
  if (config.cwd !== undefined) {
    session.cwd = nextCwd;
  }
  if (config.additionalDirectories !== undefined) {
    const normalizedAdditionalDirectories = normalizeAdditionalDirectories(nextCwd, config.additionalDirectories) ?? [];
    session.additionalDirectories = normalizedAdditionalDirectories;
    session._configOverrides.additionalDirectories = normalizedAdditionalDirectories;
  } else if (config.cwd !== undefined && session._configOverrides.additionalDirectories === undefined) {
    session.additionalDirectories = normalizeAdditionalDirectories(nextCwd, profileDef?.additionalDirectories) ?? [];
  }
  const normalizedTools = config.tools && config.tools.length > 0 ? config.tools : undefined;
  const normalizedDisallowedTools = config.disallowedTools && config.disallowedTools.length > 0
    ? config.disallowedTools
    : undefined;
  const normalizedProviderControls = config.providerControls && Object.keys(config.providerControls).length > 0
    ? config.providerControls
    : undefined;
  // Persist config overrides so follow-up turns include them
  if (config.provider !== undefined) session._configOverrides.provider = undefined;
  if (config.effort !== undefined) session._configOverrides.effort = config.effort || undefined;
  if (config.maxTurns !== undefined) session._configOverrides.maxTurns = config.maxTurns || undefined;
  if (config.tools !== undefined) session._configOverrides.tools = normalizedTools;
  if (config.disallowedTools !== undefined) session._configOverrides.disallowedTools = normalizedDisallowedTools;
  if (config.toolStates !== undefined) session._configOverrides.toolStates = config.toolStates;
  if (config.providerControls !== undefined) session._configOverrides.providerControls = normalizedProviderControls;
  if (config.loadProjectSettings !== undefined) session._configOverrides.loadProjectSettings = config.loadProjectSettings;
  if (session.status === "idle") {
    session._provider.updateConfig?.(session, {
      ...config,
      tools: config.tools !== undefined ? config.tools : undefined,
      disallowedTools: config.disallowedTools !== undefined ? config.disallowedTools : undefined,
    });
  }
  session.seq++;
  addEvent(session.sessionId, session.seq, "system", "config_updated", JSON.stringify({
    type: "system",
    subtype: "config_updated",
    model: session.model,
    config: configEventPayload(config),
    cwd: session.cwd,
    additionalDirectories: session.additionalDirectories,
    loadProjectSettings: config.loadProjectSettings,
  }));
  return true;
}

// ── Profile Switch ──

export type SwitchProfileOpts = {
  contextMode?: "full" | "summary" | "lastResponse";
};

export async function switchProfile(
  sessionId: string,
  newProfileName: string,
  opts?: SwitchProfileOpts,
): Promise<boolean> {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  const newProfile = getProfile(newProfileName, session.cwd);
  if (!newProfile) return false;

  const contextMode = opts?.contextMode ?? "full";
  const oldProfileName = session.profile;
  const oldProfile = oldProfileName ? getProfile(oldProfileName, session.cwd) : undefined;
  const oldProvider = session._provider;
  const oldProviderName = session.provider || oldProfile?.provider || "claude-code";
  const requestedProviderName = newProfile.provider ?? "claude-code";
  const providerLocked = true;
  const providerMismatch = providerLocked && requestedProviderName !== oldProviderName;
  const effectiveProviderName = providerMismatch ? oldProviderName : requestedProviderName;
  const sameProvider = effectiveProviderName === oldProviderName;
  const currentTools = session._configOverrides.tools ?? oldProfile?.tools;
  const currentDisallowedTools = session._configOverrides.disallowedTools ?? oldProfile?.disallowedTools;

  // Step 1: Abort current turn if running/paused — wait for settle
  if (session.pauseResolver) {
    session.pauseResolver();
    session.pauseResolver = null;
  }
  session.pauseRequested = false;

  if (session.status === "running" || session.status === "starting" || session.status === "paused") {
    // Resolve any pending permission promises
    for (const [id, pending] of session.pendingPermissions) {
      pending.resolve({ behavior: "deny", message: "Profile switch" });
      session.pendingPermissions.delete(id);
    }
    session.status = "idle";
    updateSessionStatus(session.sessionId, "idle");
    oldProvider.abort(session);
    // Brief settle timeout for provider drain to complete
    await new Promise((r) => setTimeout(r, 200));
  }

  // Step 2: Resolve system prompt template vars
  let systemPrompt = newProfile.prompt;
  if (systemPrompt) {
    const userData = getUserData();
    systemPrompt = systemPrompt.replace(/\{\{(\w+)\}\}/g, (_, key) => userData[key] ?? `{{${key}}}`);
  }

  // Step 3–5: Provider swap
  const nextAdditionalDirectories = session._configOverrides.additionalDirectories
    ?? normalizeAdditionalDirectories(session.cwd ?? resolveSessionCwd(undefined), newProfile.additionalDirectories)
    ?? [];
  const ctx = createTurnContext(session, {
    prompt: "",
    profile: newProfileName,
    provider: effectiveProviderName,
    model: providerMismatch ? session.model : newProfile.model,
    effort: newProfile.effort,
    maxTurns: newProfile.maxTurns,
    tools: providerMismatch ? currentTools : newProfile.tools,
    disallowedTools: providerMismatch ? currentDisallowedTools : newProfile.disallowedTools,
    cwd: session.cwd,
    loadProjectSettings: newProfile.loadProjectSettings,
    additionalDirectories: nextAdditionalDirectories,
  });

  if (sameProvider && oldProvider.switchProfile) {
    // In-place swap: let provider handle internals
    oldProvider.switchProfile(session, ctx, contextMode);
  } else if (!sameProvider) {
    // Cross-provider switch: tear down old, dispose resources (MCP, AgentSession)
    oldProvider.abort(session);
    await oldProvider.dispose?.(session);
    const newProvider = getProvider(effectiveProviderName);
    session._provider = newProvider;
    session._providerState = null;
    // New provider will be started on next message send
  } else {
    // Same provider, no switchProfile method — update config directly
    oldProvider.updateConfig?.(session, {
      model: newProfile.model,
      effort: newProfile.effort,
      maxTurns: newProfile.maxTurns,
      tools: newProfile.tools,
      disallowedTools: newProfile.disallowedTools,
    });
  }

  // Step 6: Update ActiveSession fields
  session.profile = newProfileName;
  session.provider = effectiveProviderName;
  session.model = providerMismatch ? session.model : (newProfile.model ?? session.model);
  session._configOverrides.provider = undefined;
  session._configOverrides.effort = undefined;
  session._configOverrides.maxTurns = undefined;
  session._configOverrides.tools = undefined;
  session._configOverrides.disallowedTools = undefined;
  session._configOverrides.toolStates = undefined;
  session._configOverrides.providerControls = undefined;
  session.additionalDirectories = nextAdditionalDirectories;
  session.abortController = new AbortController();
  session.pendingDispatch = [];

  // Step 7: Emit system/switch event + update DB
  session.seq++;
  const switchEvent = {
    type: "system",
    subtype: "switch",
    fromProfile: oldProfileName ?? null,
    toProfile: newProfileName,
    contextMode,
    model: session.model,
    provider: effectiveProviderName,
  };
  addEvent(session.sessionId, session.seq, "system", "switch", JSON.stringify(switchEvent));
  for (const sub of session.subscribers) {
    try { const r = sub.write("system", JSON.stringify(switchEvent), String(session.seq)); r?.catch?.(() => { session.subscribers.delete(sub); }); } catch { session.subscribers.delete(sub); }
  }

  // Update DB row with new profile
  upsertSession({
    id: session.sessionId,
    preview: session.preview,
    profile: newProfileName,
    provider: effectiveProviderName,
    model: session.model,
    status: session.status,
    messageCount: session.numTurns * 2,
    costUsd: session.costUsd,
    lastPrompt: session.preview,
    cwd: session.cwd,
    actionName: session.actionName,
  });

  return true;
}

// ── Permission Response ──

export function resolvePermission(
  sessionId: string,
  requestId: string,
  response: { behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string; scope?: "once" | "session" },
): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  const pending = session.pendingPermissions.get(requestId);
  if (!pending) return false;
  if (response.behavior === "allow" && response.scope === "session") {
    session.sessionApprovals.add(pending.toolName);
  }
  pending.resolve(response);
  return true;
}

// ── Subscriber Management ──

export function subscribe(sessionId: string, writer: SSEWriter): () => void {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.subscribers.add(writer);
    sseLog("SUBSCRIBE-OK", sessionId,
      `subs ${session.subscribers.size - 1}→${session.subscribers.size} status=${session.status}`);
    return () => {
      session.subscribers.delete(writer);
      sseLog("UNSUBSCRIBE", sessionId,
        `subs ${session.subscribers.size + 1}→${session.subscribers.size}`);
    };
  }
  // Lookup miss — UI subscribed by an ID the harness has no record of.
  // Most common cause: rekey happened between session create and subscribe,
  // and the UI is still holding the temp/old ID.
  const knownIds = Array.from(activeSessions.keys()).map((k) => k.slice(0, 12)).join(",");
  sseLog("SUBSCRIBE-MISS", sessionId,
    `no active session for this id — silent no-op subscribe. activeIds=[${knownIds}]`);
  return () => {};
}

// ── Global Session Event Bus ──
// Broadcasts lifecycle events (created, status-changed, archived) to all
// subscribers. SessionWeb uses this for real-time updates without polling.

export type GlobalSessionEvent =
  | { type: "session:created"; sessionId: string; status: SessionStatus; profile?: string; userProfile?: string; preview?: string }
  | { type: "session:status"; sessionId: string; status: SessionStatus; costUsd?: number; preview?: string }
  | { type: "session:archived"; sessionId: string };

type GlobalSSEWriter = {
  write(data: string): Promise<void>;
  close(): void;
};

const globalSubscribers = new Set<GlobalSSEWriter>();

export function subscribeGlobal(writer: GlobalSSEWriter): () => void {
  globalSubscribers.add(writer);
  return () => { globalSubscribers.delete(writer); };
}

export function emitGlobalSessionEvent(event: GlobalSessionEvent) {
  const data = JSON.stringify(event);
  for (const sub of globalSubscribers) {
    try { sub.write(data); } catch { globalSubscribers.delete(sub); }
  }
}

// ── Session Reaper ──
// Removes finished sessions from the in-memory activeSessions map so they
// don't accumulate forever between harness restarts. DB rows are unaffected.

const REAP_INTERVAL_MS = 60_000;          // check every 60s
const REAP_TERMINAL_AFTER_MS = 60_000;    // done/error: reap after 1 min
const REAP_IDLE_AFTER_MS = 10 * 60_000;   // idle: reap after 10 min (regardless of subscribers)
const REAP_STARTING_AFTER_MS = 3 * 60_000; // starting: reap after 3 min (stuck spawn)
const REAP_INTERRUPTING_AFTER_MS = 5 * 60_000; // interrupting: provider teardown got stuck
const INTERRUPT_FORCE_IDLE_AFTER_MS = 30_000; // stop button: give provider teardown a short grace window

export function forceClearActiveSession(
  sessionId: string,
  status: Extract<SessionStatus, "idle" | "done" | "error"> = "idle",
  reason = "force clear",
): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  try {
    if (session.pauseResolver) {
      session.pauseResolver();
      session.pauseResolver = null;
    }
    session.pauseRequested = false;

    for (const [, pending] of session.pendingPermissions) {
      pending.resolve({ behavior: "deny", message: reason });
    }
    session.pendingPermissions.clear();
    session.pendingDispatch = [];
    endFollowupDispatch(session);

    for (const watcher of session.watchers) {
      if (watcher.kind === "terminal") {
        watcher.resolve({
          sessionStatus: status,
          response: null,
          summary: null,
          costUsd: session.costUsd,
          error: reason,
        });
      }
    }
    session.watchers.clear();

    session.status = status;
    updateSessionStatus(session.sessionId, status);
    emitGlobalSessionEvent({
      type: "session:status",
      sessionId: session.sessionId,
      status,
      costUsd: session.costUsd,
      preview: session.preview,
    });

    try { session._provider.abort(session); } catch { /* best effort */ }
    try { session._provider.dispose?.(session)?.catch(() => {}); } catch { /* best effort */ }
  } finally {
    activeSessions.delete(sessionId);
    sseLog("SESSION-FORCE-CLEARED", sessionId, `${reason} status=${status}`);
  }

  return true;
}

function reapStaleSessions(): void {
  const now = Date.now();
  const toReap: string[] = [];

  for (const [id, session] of activeSessions) {
    const age = now - session.lastEventAt;

    if (session.status === "done" || session.status === "error") {
      if (age >= REAP_TERMINAL_AFTER_MS && session.subscribers.size === 0) {
        toReap.push(id);
      }
    } else if (session.status === "idle") {
      // Reap idle sessions regardless of subscribers. Claude Code CLI leaks memory
      // at ~100 MB/min even when idle (upstream bug: anthropics/claude-code#33494).
      // SSE subscribers will get a close event and the UI can handle reconnection.
      // Keeping idle sessions alive just to preserve an SSE pipe is not worth the
      // risk of another OOM system crash.
      if (age >= REAP_IDLE_AFTER_MS) {
        toReap.push(id);
      }
    } else if (session.status === "starting") {
      // Stuck in starting state — provider failed to spawn or connect.
      // These zombies hold a slot in activeSessions but do nothing.
      if (age >= REAP_STARTING_AFTER_MS) {
        toReap.push(id);
      }
    } else if (session.status === "interrupting") {
      if (age >= REAP_INTERRUPTING_AFTER_MS) {
        session.status = "done";
        updateSessionStatus(session.sessionId, "done");
        emitGlobalSessionEvent({
          type: "session:status",
          sessionId: session.sessionId,
          status: "done",
          costUsd: session.costUsd,
          preview: session.preview,
        });
        toReap.push(id);
      }
    }
  }

  for (const id of toReap) {
    const session = activeSessions.get(id);
    if (!session) continue;
    try { session._provider.dispose?.(session)?.catch(() => {}); } catch { /* best effort */ }
    sseLog("SESSION-REAPED", id,
      `status=${session.status} age=${Math.round((now - session.lastEventAt) / 1000)}s totalActive=${activeSessions.size - 1}`);
    activeSessions.delete(id);
  }

  if (toReap.length > 0) {
    console.log(`[session-reaper] reaped ${toReap.length} stale session(s), ${activeSessions.size} remain`);
  }
}

let reapTimer: ReturnType<typeof setInterval> | null = null;

export function startSessionReaper(): void {
  if (reapTimer) return;
  reapTimer = setInterval(reapStaleSessions, REAP_INTERVAL_MS);
}

export function stopSessionReaper(): void {
  if (reapTimer) { clearInterval(reapTimer); reapTimer = null; }
}

// ── Cleanup ──

export function shutdownAll() {
  stopSessionReaper();
  for (const [id, session] of activeSessions) {
    try {
      if (session.pauseResolver) {
        session.pauseResolver();
        session.pauseResolver = null;
      }
      // Resolve pending terminal watchers so monitorSession() doesn't hang
      for (const watcher of session.watchers) {
        if (watcher.kind === "terminal") {
          watcher.resolve({
            sessionStatus: "error",
            response: null, summary: null, costUsd: 0,
            error: "session shutdown",
          });
        }
      }
      session.watchers.clear();
      session._provider.abort(session);
      session._provider.dispose?.(session).catch(() => {});
    } catch { /* best effort */ }
    sseLog("SESSION-UNREGISTERED", id, `subsAtRemoval=${session.subscribers.size} totalActive=${activeSessions.size - 1}`);
    activeSessions.delete(id);
  }
}

// ── Branching ──

export function branchSession(
  sourceId: string,
  branchSeq: number,
): { sessionId: string } | { error: string } {
  const source = getSession(sourceId);
  if (!source) return { error: "source session not found" };

  // Find the SDK assistant message UUID for resumeSessionAt
  const messageUuid = findAssistantUuid(sourceId, branchSeq);

  // Create new session — just a copy with a fresh ID
  const newId = crypto.randomUUID();

  // Create DB row first (events FK references sessions)
  upsertSession({
    id: newId,
    preview: source.preview,
    profile: source.profile ?? undefined,
    model: source.model ?? undefined,
    status: "idle",
    messageCount: 0,
    costUsd: 0,
    lastPrompt: source.last_prompt ?? undefined,
    cwd: source.cwd ?? undefined,
    parentSessionId: sourceId,
    branchMessageUuid: messageUuid ?? undefined,
  });

  // Copy events from source up to branchSeq
  const copied = copyEventsToSession(sourceId, newId, branchSeq);
  if (copied === 0) return { error: "no events to copy at that seq" };

  return { sessionId: newId };
}
