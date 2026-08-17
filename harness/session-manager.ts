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
  upsertSession, updateSessionStatus, addEvent, renameSession, getSession, updateProviderSessionId,
  getStoredSessionConfig, getSessionsByTag,
  copyEventsToSession, copyMessagesToSession, findAssistantUuid, clearBranchFields,
  addSessionTag, parseTags, getMaxSeq, insertSessionArtifact, insertMessage, syncSessionMessageCount,
  insertFileObservation,
} from "./db";
import type { SessionOutcome } from "./action-types";
import { userMessagePreviewText } from "./message-context";
import { logActivity } from "./activity";
import { canSpawnSession, getMemoryStatus, isUnderMemoryPressure, resolveReapLimits } from "./memory-guard";
import { measureProcessTree, sampleProcessTable, type ProcessTable } from "./process-memory";
import {
  formatIdleSurvey,
  planIdleReaps,
  shouldAnnounceReclaim,
  type IdleSessionSample,
} from "./session-reap-policy";
import { providerCliName } from "./providers/provider-cli-names";
import {
  captureCheckpoint,
  checkpointById,
  checkpointForSeq,
  previewCheckpoint,
  restoreCheckpointById,
} from "./checkpoints";
import type { RewindPreview, RewindResult } from "./checkpoints";
import { resolve as resolvePath, dirname as pathDirname, join as pathJoin } from "path";
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "fs";
import { APP_PATHS } from "./app-paths";
import { providerErrorDisplayText } from "./provider-error";
import { isAlwaysDurableEvent, isLiveOnlyEvent } from "./event-persistence";
import { formatMoveActivationFailures, type MoveActivationFailure } from "./move-activation-failure";

// ── SSE flow log ──
// Append-only diagnostic log of every subscriber lifecycle event and broadcast.
// Gitignored, no secrets (only ID prefixes, event types, sizes, counts).
// Lives in the resolved logs directory, which differs between a source run and
// a packaged one — read APP_PATHS.logsDir rather than assuming a path.
const SSE_LOG = pathJoin(APP_PATHS.logsDir, "sse-flow.log");
const SSE_LOG_PREVIOUS = `${SSE_LOG}.1`;
/** Size at which the log rolls over. One previous generation is kept. */
const SSE_LOG_MAX_BYTES = 64 * 1024 * 1024;
/** Bytes written between size checks, so a stat does not ride every broadcast. */
const SSE_LOG_CHECK_BYTES = 4 * 1024 * 1024;
try { mkdirSync(pathDirname(SSE_LOG), { recursive: true }); } catch {}

// Start due for a check: an existing log may already be over the cap from a
// build that had no rotation at all.
let sseLogBytesSinceCheck = SSE_LOG_CHECK_BYTES;

function rollSseLogIfLarge(): void {
  sseLogBytesSinceCheck = 0;
  try {
    if (statSync(SSE_LOG).size < SSE_LOG_MAX_BYTES) return;
    // Windows refuses a rename onto an existing file, so clear the previous
    // generation first. Losing it is the intended cost of rolling over.
    rmSync(SSE_LOG_PREVIOUS, { force: true });
    renameSync(SSE_LOG, SSE_LOG_PREVIOUS);
  } catch { /* diagnostics must never break a broadcast */ }
}

function sseLog(event: string, sid: string | undefined, detail: string): void {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 });
  const sidShort = sid ? sid.slice(0, 12) : "------------";
  const line = `${ts} [${sidShort}] ${event}: ${detail}\n`;
  try {
    sseLogBytesSinceCheck += line.length;
    if (sseLogBytesSinceCheck >= SSE_LOG_CHECK_BYTES) rollSseLogIfLarge();
    appendFileSync(SSE_LOG, line);
  } catch { /* ignore */ }
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

let _getMoveSkillSources: typeof import("./move-runner").getMoveSkillSources | null = null;
function getMoveSkillSources() {
  if (!_getMoveSkillSources) {
    _getMoveSkillSources = require("./move-runner").getMoveSkillSources;
  }
  return _getMoveSkillSources!;
}
import { buildModusMcpServer, getProfile, getUserData, getUserProfile } from "./profiles";
import { bindSessionSkillScope, collectSkills, createSkillScope } from "./skill-attachment";
import {
  bindSessionMcpCredential,
  mintSessionMcpCredential,
  rekeySessionMcpCredentials,
  revokeSessionMcpCredential,
  revokeSessionMcpCredentials,
  validateSessionMcpCredential,
} from "./session-mcp-credential";
import { acceptsInjectedSkillPaths } from "./providers/provider-names";
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
  /** Execution backend's native conversation/thread identity. Never infer this from sessionId. */
  providerSessionId: string | null;
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
  const blocks = typeof content === "string" ? [] : (content as any[]);
  const text = typeof content === "string"
    ? content
    : (blocks.find((b: any) => b.type === "text")?.text ?? "");
  const imgCount = blocks.filter((b: any) => b.type === "image").length;
  const prefix = imgCount > 0 ? `[${imgCount} image${imgCount > 1 ? "s" : ""}] ` : "";
  return (prefix + userMessagePreviewText(text)).slice(0, maxLen);
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
      // Persistence is decided by event type, not by which method was called;
      // see event-persistence.ts for why `error` is promoted here rather than
      // at each of the provider call sites that emit it.
      if (isAlwaysDurableEvent(event)) {
        persistAndBroadcastEvent(session, event);
        return;
      }
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
        rekeySessionMcpCredentials(oldId, newId);
        renameSession(oldId, newId);
      }
      sseLog("REKEY", newId,
        `from=${oldId.slice(0, 12)} to=${newId.slice(0, 12)} subsRetained=${session.subscribers.size} status=${session.status}`);
    },

    setProviderSessionId(providerSessionId: string) {
      session.providerSessionId = providerSessionId;
      updateProviderSessionId(session.sessionId, providerSessionId);
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
        providerSessionId: session.providerSessionId ?? undefined,
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
  /**
   * Names of the agent profile's own move bindings to leave out of this start.
   * A profile's inline moves gather pre-spawn and are prepended to the first
   * message, so the composer shows them as pending attachments before the user
   * sends; removing one there sends its name here. Absent means "run them all",
   * so this changes nothing for any caller that does not set it.
   */
  skipProfileMoves?: string[];
  /** Session-level MCP servers — merged with (and override) profile MCP servers at session creation */
  mcpServers?: Record<string, unknown>;
  /** Set when skills are attached: identifies this session's skill scope to the
   *  Modus MCP endpoint and to providers that can load skills natively. */
  skillScopeKey?: string;
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

function configuredSessionMcpCredential(opts: StartSessionOpts): string | null {
  const modus = opts.mcpServers?.modus as {
    url?: string;
    headers?: Record<string, string>;
  } | undefined;
  const authorization = modus?.headers?.Authorization;
  if (!authorization?.startsWith("Bearer ") || !modus?.url) return null;
  const token = authorization.slice(7);
  try {
    return validateSessionMcpCredential(token, new URL(modus.url).pathname) ? token : null;
  } catch {
    return null;
  }
}

function providerMcpScope(providerName: string, skillScopeKey?: string | null): string | undefined {
  return acceptsInjectedSkillPaths(providerName) ? undefined : (skillScopeKey ?? undefined);
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

/** Materialize whatever durable assistant content has arrived so abnormal
 * provider termination cannot leave a permanently user-only semantic history. */
function flushPendingAssistantTurn(session: ActiveSession, terminalEvent: any = {}): boolean {
  const turn = session.pendingAssistantTurn;
  if (!turn) return false;
  const content = turn.text || (typeof terminalEvent.result === "string" ? terminalEvent.result : "");
  if (!content && !turn.thinking && turn.toolCalls.size === 0) {
    session.pendingAssistantTurn = null;
    return false;
  }
  insertMessage({
    sessionId: session.sessionId,
    seq: session.seq,
    role: "assistant",
    content,
    uuid: turn.uuid,
    thinking: turn.thinking || undefined,
    toolCalls: turn.toolCalls.size > 0 ? [...turn.toolCalls.values()] : undefined,
    costUsd: typeof terminalEvent.total_cost_usd === "number" ? terminalEvent.total_cost_usd : undefined,
    durationMs: typeof terminalEvent.harness_duration_ms === "number" ? terminalEvent.harness_duration_ms : undefined,
    model: session.model,
    turns: typeof terminalEvent.num_turns === "number" ? terminalEvent.num_turns : undefined,
    // A provider can disappear long after its last partial assistant event.
    // Materializing that buffered content during reap must preserve when the
    // conversation actually moved instead of making reap time look like a reply.
    createdAt: turn.timestamp,
  });
  syncSessionMessageCount(session.sessionId, { activityAt: turn.timestamp });
  session.pendingAssistantTurn = null;
  return true;
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
      uuid: typeof event.uuid === "string" ? event.uuid : undefined,
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

  if (event.type === "result" || event.type === "error" || event.type === "done"
    || (event.type === "system" && event.subtype === "interrupted")) {
    flushPendingAssistantTurn(session, event);
  }

  // Persist the explanation alongside the status. A failure status is durable,
  // so an error delivered only to live subscribers leaves a reloaded session
  // showing a failed turn with no stated reason.
  if (event.type === "error") {
    const text = providerErrorDisplayText(event);
    insertMessage({
      sessionId: session.sessionId,
      seq: session.seq,
      role: "system",
      content: text,
      createdAt: Date.now(),
    });
    syncSessionMessageCount(session.sessionId);
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

type PendingLiveBroadcast = {
  timer: ReturnType<typeof setTimeout> | null;
  lastSentAt: number;
};

const pendingLiveBroadcasts = new WeakMap<ActiveSession, PendingLiveBroadcast>();
const lastGlobalActivityAt = new WeakMap<ActiveSession, number>();
const LIVE_BROADCAST_INTERVAL_MS = 40;
const GLOBAL_ACTIVITY_INTERVAL_MS = 250;

function liveSummaryText(session: ActiveSession): string | null {
  const text = session.liveStream.text || session.lastAssistantText;
  return text ? text.slice(-320) : null;
}

function emitGlobalSessionActivity(session: ActiveSession) {
  const now = Date.now();
  const last = lastGlobalActivityAt.get(session) ?? 0;
  if (now - last < GLOBAL_ACTIVITY_INTERVAL_MS) return;
  lastGlobalActivityAt.set(session, now);
  emitGlobalSessionEvent({
    type: "session:activity",
    sessionId: session.sessionId,
    status: session.status,
    seq: session.seq,
    lastText: liveSummaryText(session),
    lastEventAt: session.lastEventAt,
    costUsd: session.costUsd,
  });
}

function flushLiveBroadcast(session: ActiveSession) {
  const pending = pendingLiveBroadcasts.get(session);
  if (pending?.timer) clearTimeout(pending.timer);
  if (pending) {
    pending.timer = null;
    pending.lastSentAt = Date.now();
  }
  if (!session.liveStream.text && !session.liveStream.thinking && !session.liveStream.feed) return;
  broadcastEventToSession(session, {
    type: "system",
    subtype: "live_snapshot",
    text: session.liveStream.text,
    thinking: session.liveStream.thinking,
    feed: session.liveStream.feed,
  }, session.liveStream.seq || session.seq);
  emitGlobalSessionActivity(session);
}

function scheduleLiveBroadcast(session: ActiveSession) {
  const pending = pendingLiveBroadcasts.get(session) ?? { timer: null, lastSentAt: 0 };
  pendingLiveBroadcasts.set(session, pending);
  if (pending.timer) return;
  const delay = Math.max(0, LIVE_BROADCAST_INTERVAL_MS - (Date.now() - pending.lastSentAt));
  pending.timer = setTimeout(() => flushLiveBroadcast(session), delay);
}

function isCoalescibleLiveDelta(event: any): boolean {
  if (event?.type !== "stream_event" || event.event?.type !== "content_block_delta") return false;
  const type = event.event?.delta?.type;
  return type === "text_delta" || type === "thinking_delta";
}

function persistAndBroadcastEvent(session: ActiveSession, event: any) {
  const _pbt0 = performance.now();
  session.seq++;
  session.lastEventAt = Date.now();
  const liveOnly = isLiveOnlyEvent(event);
  // Flush any coalesced deltas first so a durable event cannot overtake the
  // stream it follows.
  if (!liveOnly) flushLiveBroadcast(session);
  updateLiveStreamSnapshot(session, event);
  persistSemanticMessage(session, event);
  if (liveOnly) {
    sseLog("LIVE-ONLY", session.sessionId,
      `seq=${session.seq} type=${event.type}${event.subtype ? "/" + event.subtype : ""} subs=${session.subscribers.size}`);
    if (isCoalescibleLiveDelta(event)) scheduleLiveBroadcast(session);
    else broadcastEventToSession(session, event, session.seq);
    return;
  }
  addEvent(
    session.sessionId,
    session.seq,
    event.type,
    event.subtype ?? null,
    JSON.stringify(event),
  );
  observeDeclaredFileTools(session, event);
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

  // Older internal callers still invoke startSession() directly. The two
  // primary orchestration paths prepare this credential before entering, but
  // keep a defensive fallback here so no provider session silently falls back
  // to the token-less built-in entry from getGlobalConfig().
  let internallyMintedMcpCredential: string | null = null;
  if (!configuredSessionMcpCredential(opts)) {
    const scopeKey = providerMcpScope(providerName, opts.skillScopeKey);
    internallyMintedMcpCredential = mintSessionMcpCredential(scopeKey);
    opts = {
      ...opts,
      mcpServers: {
        ...(opts.mcpServers ?? {}),
        modus: buildModusMcpServer(scopeKey, internallyMintedMcpCredential ?? undefined),
      },
    };
  }

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
  const existingRow = isResume ? getSession(tempId) : null;

  // Branch detection: if resuming a session that has parent_session_id,
  // pass fork opts to the provider and clear the fields so it only forks once.
  if (isResume && !opts.branchParentId) {
    const dbRow = getSession(opts.sessionId!);
    if (dbRow?.parent_session_id) {
      opts.branchParentId = dbRow.parent_session_id;
      opts.branchMessageUUID = dbRow.branch_message_uuid ?? undefined;
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

  // Resume (and any re-open of an existing id) must continue past the durable
  // high-water mark. Starting at 0 reuses seq numbers; event-history reconstruct
  // then interleaves whole turns (seen on grok-build after process/session restarts).
  const seqHighWater = isResume ? getMaxSeq(tempId) : 0;

  const session: ActiveSession = {
    sessionId: tempId,
    tempId,
    providerSessionId: existingRow?.provider_session_id ?? null,
    status: "starting",
    profile: opts.profile,
    provider: providerName,
    model: opts.model ?? profileDef?.model ?? userProf?.model,
    seq: seqHighWater,
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
  if (internallyMintedMcpCredential) {
    bindSessionMcpCredential(tempId, internallyMintedMcpCredential);
  }
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
      providerSessionId: session.providerSessionId ?? undefined,
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

  // Snapshot before the provider is allowed to run. Failure does not block the
  // turn, but capture must settle so this cannot race the provider's first edit.
  const checkpointSeq = isResume ? getMaxSeq(tempId) : 0;
  const checkpointReady = captureCheckpoint(resolvedCwd, tempId, checkpointSeq).then((r) => {
    if (!r.ok && r.reason !== "not a git repository") {
      console.warn(`[checkpoints] capture failed for ${tempId}: ${r.reason}`);
    }
  }).catch((err) => {
    console.warn(`[checkpoints] capture failed for ${tempId}:`, err?.message ?? err);
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
  void checkpointReady.finally(() => {
    if (!session.abortController.signal.aborted && activeSessions.get(session.sessionId) === session) {
      provider.startTurn(ctx);
    }
  });

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
  const declaredProfileMoves = profileDef?.moves ?? [];
  // Two reasons a profile binding does not run at session start:
  //   - `ask`: it waits for the user to fill its form in the composer.
  //   - `skipProfileMoves`: the user removed it from the composer's pending
  //     attachments before sending, having seen what it was about to inject.
  // Skills still resolve below for both: a provider is handed its skill scope
  // before it spawns and cannot be given one after, so deferring that too would
  // leave the move unrunnable all session.
  const skipped = new Set(opts.skipProfileMoves ?? []);
  const profileMoves = declaredProfileMoves.filter(
    (binding) => !binding.ask && !skipped.has(binding.name),
  );
  const requestMoves = opts.moves ?? [];
  const allMoves = [...profileMoves, ...requestMoves];
  const skillSourceMoves = [...declaredProfileMoves, ...requestMoves];
  const existingLogicalSession = opts.sessionId ? getSession(opts.sessionId) : null;
  // A pending branch is a new logical conversation even though its copied
  // history contains the parent's move markers.
  const existingLogicalSessionId = existingLogicalSession && !existingLogicalSession.parent_session_id
    ? existingLogicalSession.id
    : undefined;

  const resolvedCwd = profileDef?.cwd
    ? resolvePath(baseCwd, profileDef.cwd)
    : baseCwd;

  // Skills resolve before spawn: a provider is handed its MCP endpoint URL when
  // it starts and cannot be given a new one afterward, so the scope key has to
  // exist before startSession(). It is bound to the real session ID once the
  // provider assigns one, the same ordering the inline move API tokens use.
  const attached = collectSkills(resolvedCwd, {
    names: profileDef?.skills,
    moves: skillSourceMoves.length ? getMoveSkillSources()(skillSourceMoves, resolvedCwd) : [],
  });
  for (const miss of attached.missing) {
    console.warn(`[skills] ${miss.requestedBy} attached "${miss.name}", which resolves to nothing under ${resolvedCwd}`);
  }
  const skillScopeKey = createSkillScope(attached.skills);
  // PI is handed the attached SKILL.md files directly, so it loads them the way
  // it loads its own — registering the skill tools too would serve the same
  // text through a second path. Every other provider gets the scoped endpoint.
  const userProf = opts.userProfile ? getUserProfile(opts.userProfile) : undefined;
  const providerName = opts.provider ?? profileDef?.provider ?? userProf?.provider ?? "claude-code";
  const mcpScopeKey = providerMcpScope(providerName, skillScopeKey);
  const sessionMcpCredential = mintSessionMcpCredential(mcpScopeKey);
  const skillOpts: StartSessionOpts = {
    ...opts,
    ...(skillScopeKey ? { skillScopeKey } : {}),
    mcpServers: {
      ...(opts.mcpServers ?? {}),
      modus: buildModusMcpServer(mcpScopeKey, sessionMcpCredential ?? undefined),
    },
  };

  const startPreparedSession = (prepared: StartSessionOpts): ActiveSession => {
    try {
      return startSession(prepared);
    } catch (error) {
      if (sessionMcpCredential) revokeSessionMcpCredential(sessionMcpCredential);
      throw error;
    }
  };

  // No moves declared → fast path, just start normally
  if (!allMoves.length) {
    const session = startPreparedSession(skillOpts);
    await waitForProviderInit(session);
    if (sessionMcpCredential) bindSessionMcpCredential(session.sessionId, sessionMcpCredential);
    if (skillScopeKey) bindSessionSkillScope(session.sessionId, skillScopeKey);
    return session;
  }

  // Phase 1: gather inline (non-persistent) moves before session starts
  const activateMoveBindings = getActivateMoveBindings();
  let profilePhase1: Awaited<ReturnType<typeof activateMoveBindings>>;
  let requestPhase1: Awaited<ReturnType<typeof activateMoveBindings>>;
  try {
    profilePhase1 = profileMoves.length
      ? await activateMoveBindings(
          profileMoves,
          "", // no provider session ID yet
          resolvedCwd,
          opts.userProfile,
          {
            persistentOnly: false,
            logPrefix: `profile:${opts.profile}`,
            skipPreviouslyInjectedForSession: existingLogicalSessionId,
            persistInlineApiRegistrations: true,
            agentProfile: opts.profile,
          },
        )
      : { inlineContext: null, apiTokens: [], activatedPersistent: [], failures: [] };
    requestPhase1 = requestMoves.length
      ? await activateMoveBindings(
          requestMoves,
          "",
          resolvedCwd,
          opts.userProfile,
          { persistentOnly: false, logPrefix: "request", agentProfile: opts.profile },
        )
      : { inlineContext: null, apiTokens: [], activatedPersistent: [], failures: [] };
  } catch (error) {
    if (sessionMcpCredential) revokeSessionMcpCredential(sessionMcpCredential);
    throw error;
  }
  const phase1 = {
    inlineContext: [profilePhase1.inlineContext, requestPhase1.inlineContext]
      .filter((value): value is string => !!value)
      .join("\n\n") || null,
    apiTokens: [...profilePhase1.apiTokens, ...requestPhase1.apiTokens],
    failures: [...profilePhase1.failures, ...requestPhase1.failures],
  };

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
  const session = startPreparedSession({ ...skillOpts, prompt });

  _timing("post-startSession");
  // Wait for provider init (rekey happens during init — session.sessionId becomes the
  // backend-assigned ID).  Condition: status leaves "starting" once the provider fires
  // its first init event.  Timeout prevents blocking forever on provider failure.
  await waitForProviderInit(session);

  if (sessionMcpCredential) bindSessionMcpCredential(session.sessionId, sessionMcpCredential);
  if (skillScopeKey) bindSessionSkillScope(session.sessionId, skillScopeKey);

  // Rekey inline API move registrations to the real session ID
  const rekeyMoveByToken = getRekeyMoveByToken();
  for (const token of phase1.apiTokens) {
    rekeyMoveByToken(token, session.sessionId);
  }

  // Phase 2: activate persistent moves on the real session
  const phase2 = await activateMoveBindings(
    allMoves,
    session.sessionId,
    resolvedCwd,
    opts.userProfile,
    { persistentOnly: true, logPrefix: `profile:${opts.profile ?? "none"}+request`, agentProfile: opts.profile },
  );

  // A move that failed to load injected nothing, but its chip attached normally
  // and the agent starts the turn as if it had. Phase 1 runs before the session
  // exists, so both phases are reported here, once the transcript can hold it.
  reportMoveActivationFailures(session, [...phase1.failures, ...phase2.failures]);

  return session;
}

/**
 * Persist a system message naming the moves that produced nothing.
 *
 * Without this the failure is console-only, and a packaged build has no
 * devtools — so the user's entire signal is a move that attached and did
 * nothing. Emitted as `type: "error"` because that is the one event shape the
 * reload path materializes without a preceding assistant turn; it does not
 * change session status, which providers own.
 */
function reportMoveActivationFailures(session: ActiveSession, failures: MoveActivationFailure[]) {
  if (failures.length === 0) return;
  persistAndBroadcastEvent(session, {
    type: "error",
    error: formatMoveActivationFailures(failures),
    source: "move-activation",
    failures,
  });
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

/**
 * Run the gathers that decorate a single user message: the ambient gather for
 * persistent moves already active on the session, plus activation of any moves
 * attached to this specific message.
 *
 * Split out of the queue path because steering needs the identical treatment —
 * a move attached to an interjection has to be gathered before the message can
 * be injected — and because a steer that the provider declines at the last
 * moment must be able to fall back to the queue *without* re-running gathers
 * that have side effects (persistent activation, API token minting).
 */
async function augmentPromptWithMoveContext(
  session: ActiveSession,
  sessionId: string,
  prompt: string,
  moves?: QueueMessageMoveBinding[],
): Promise<string> {
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
        { persistentOnly: false, logPrefix: "message-moves", agentProfile: session.profile },
      );
      // Phase 2: activate persistent moves (ambient gathers)
      await getActivateMoveBindings()(
        moves, sessionId, cwd, session.userProfile,
        { persistentOnly: true, logPrefix: "message-moves", agentProfile: session.profile },
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

  return augmentedPrompt;
}

async function _queueMessageAsync(
  session: ActiveSession,
  sessionId: string,
  dispatchId: string,
  prompt: string,
  attachments?: ImageAttachment[],
  moves?: QueueMessageMoveBinding[],
): Promise<void> {
  const augmentedPrompt = await augmentPromptWithMoveContext(session, sessionId, prompt, moves);
  await _dispatchUserMessage(session, sessionId, dispatchId, augmentedPrompt, attachments);
}

/** Persist, checkpoint, and either queue or hand a fully-gathered message to the provider. */
async function _dispatchUserMessage(
  session: ActiveSession,
  sessionId: string,
  dispatchId: string,
  augmentedPrompt: string,
  attachments?: ImageAttachment[],
): Promise<void> {
  const content = buildContent(augmentedPrompt, attachments);

  // Persist user event for catch-up replay
  session.seq++;
  addEvent(sessionId, session.seq, "user", "prompt", JSON.stringify({
    type: "user",
    subtype: "prompt",
    message: { role: "user", content },
  }));

  // Capture must settle before this message can be dispatched to the provider.
  try {
    const captured = await captureCheckpoint(session.cwd ?? process.cwd(), sessionId, session.seq);
    if (!captured.ok && captured.reason !== "not a git repository") {
      console.warn(`[checkpoints] capture failed for ${sessionId}: ${captured.reason}`);
    }
  } catch (err: any) {
    console.warn(`[checkpoints] capture failed for ${sessionId}:`, err?.message ?? err);
  }

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
 * Where a steered message actually landed.
 *
 * `"steer"` — injected into the turn that was already running; the agent sees it
 * at the next tool boundary. `"queued"` — the provider cannot inject mid-turn
 * (or declined right then), so it is waiting in `pendingDispatch` and will be
 * delivered when the current turn ends; `dispatchId` cancels it. `"none"` — no
 * such live session.
 *
 * Callers must be able to tell these apart. Reporting a queued message as though
 * it had been injected is the difference between "the agent is about to read
 * this" and "the agent will read this in ten minutes".
 */
export type SteerResult = {
  ok: boolean;
  mode: "steer" | "queued" | "none";
  dispatchId?: string;
};

/**
 * Inject a message into a running turn, delivered at the next tool boundary.
 * Accepts the same per-message move bindings as an ordinary send, so a move can
 * be attached to an interjection without interrupting or restarting the session.
 * Falls back to the queue whenever live injection is not possible.
 */
export async function steerMessage(
  sessionId: string,
  prompt: string,
  attachments?: ImageAttachment[],
  moves?: QueueMessageMoveBinding[],
): Promise<SteerResult> {
  const session = activeSessions.get(sessionId);
  if (!session) return { ok: false, mode: "none" };

  const queueInstead = (): SteerResult => {
    const queued = queueMessage(sessionId, prompt, attachments, moves);
    return { ok: queued.queued, mode: "queued", dispatchId: queued.dispatchId };
  };

  // Nothing to steer into, or a provider that cannot: take the ordinary path,
  // which starts a turn when idle and queues when busy.
  const turnRunning = session.status === "running" || session.status === "starting";
  if (!turnRunning || !session._provider.steerMessage) return queueInstead();

  const augmentedPrompt = await augmentPromptWithMoveContext(session, sessionId, prompt, moves);
  const content = buildContent(augmentedPrompt, attachments);
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

  if (session._provider.steerMessage(ctx, content)) {
    // Persist *and* broadcast. A steered message is delivered inside a turn that
    // is already streaming, so nothing else will announce it — persisting alone
    // leaves the interjection invisible in the transcript until a reload.
    persistAndBroadcastEvent(session, {
      type: "user",
      subtype: "prompt",
      message: { role: "user", content },
    });
    return { ok: true, mode: "steer" };
  }

  // The provider declined at the last moment — its process is unwinding, or the
  // turn ended between the status check and the write. The gathers have already
  // run and may have had side effects, so queue the augmented text directly
  // rather than re-entering queueMessage with the original moves.
  beginFollowupDispatch(session);
  const dispatchId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  void _dispatchUserMessage(session, sessionId, dispatchId, augmentedPrompt, attachments).catch((err) => {
    console.error(`[session-manager] steer fallback dispatch failed for ${sessionId}:`, err);
    endFollowupDispatch(session);
    removePendingDispatch(session, dispatchId);
    persistAndBroadcastEvent(session, { type: "error", message: `Message delivery failed: ${err?.message ?? err}` });
    persistAndBroadcastEvent(session, { type: "done" });
  });
  return { ok: true, mode: "queued", dispatchId };
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
  flushPendingAssistantTurn(session, { type: "system", subtype: "interrupted" });
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
  | { type: "session:activity"; sessionId: string; status: SessionStatus; seq: number; lastText: string | null; lastEventAt: number; costUsd?: number }
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
    try {
      sub.write(data).catch(() => { globalSubscribers.delete(sub); });
    } catch {
      globalSubscribers.delete(sub);
    }
  }
}

// ── Session Reaper ──
//
// Drops sessions from the in-memory activeSessions map so they don't
// accumulate across a long uptime. DB rows are unaffected — reclaiming a
// session ends its provider process, not its history.
//
// Reclaiming an idle session kills the provider CLI and everything below it,
// including background work the agent left running, so the idle rules live in
// session-reap-policy.ts and are driven by what a session actually costs
// rather than by how long it has been quiet. Terminal and stuck states below
// have nothing left to protect and stay on simple timers.

const REAP_INTERVAL_MS = 60_000;          // check every 60s
const REAP_TERMINAL_AFTER_MS = 60_000;    // done/error: reap after 1 min
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

    flushPendingAssistantTurn(session, { type: "system", subtype: "interrupted", reason });
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
    revokeSessionMcpCredentials(sessionId);
    activeSessions.delete(sessionId);
    sseLog("SESSION-FORCE-CLEARED", sessionId, `${reason} status=${status}`);
  }

  return true;
}

/**
 * Measure what each idle session costs, so the policy decides from memory
 * rather than from elapsed time.
 *
 * A session that registered no OS pids cannot be measured — that is reported as
 * unknown, never as zero, so an unmeasurable session is not mistaken for a free
 * one. The process table is sampled once for the whole sweep.
 */
function sampleIdleSessions(sessions: ActiveSession[], now: number): IdleSessionSample[] {
  const table: ProcessTable = sessions.length > 0 ? sampleProcessTable(now) : new Map();
  const measurable = table.size > 0;

  return sessions.map((session) => {
    const idleMs = now - session.lastEventAt;
    if (!measurable || session.osPids.size === 0) {
      return { sessionId: session.sessionId, idleMs, cliRssBytes: null, treeRssBytes: null };
    }
    const cli = providerCliName(session.provider);
    const footprint = measureProcessTree(table, session.osPids, cli ? [cli] : []);
    return {
      sessionId: session.sessionId,
      idleMs,
      cliRssBytes: footprint.matchedBytes,
      treeRssBytes: footprint.totalBytes,
    };
  });
}

/**
 * End a session's provider process and drop it from the active map.
 *
 * The reason reaches the user three ways because each survives a different
 * thing: a persisted system message survives reload, a status broadcast updates
 * a session list that is not watching this session, and closing the subscribers
 * stops an open transcript from rendering a session that will never emit again.
 */
function reclaimSession(sessionId: string, reason: string, now: number): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  const idleSeconds = Math.round((now - session.lastEventAt) / 1000);
  const previousStatus = session.status;
  revokeSessionMcpCredentials(sessionId);
  activeSessions.delete(sessionId);

  flushPendingAssistantTurn(session, { type: "done", reason });
  const announce = shouldAnnounceReclaim(previousStatus);
  if (announce) {
    session.seq++;
    const event = {
      type: "system",
      subtype: "reclaimed",
      reason,
      previousStatus,
      message: `Session process reclaimed: ${reason}. Sending a message starts a new process; ` +
        `anything running in the background did not survive.`,
    };
    addEvent(sessionId, session.seq, event.type, event.subtype, JSON.stringify(event));
    insertMessage({
      sessionId,
      seq: session.seq,
      role: "system",
      content: event.message,
      createdAt: Date.now(),
    });
    // The notice is written by the harness, not by the conversation, so it must
    // not re-order the session list. A user who left a chat idle for two days
    // finds it back at the top otherwise, looking like something replied.
    syncSessionMessageCount(sessionId, { touchActivity: false });
    broadcastEventToSession(session, event, session.seq);
  }

  if (previousStatus !== "done" && previousStatus !== "error") {
    session.status = "done";
    updateSessionStatus(sessionId, "done");
  }
  emitGlobalSessionEvent({
    type: "session:status",
    sessionId,
    status: session.status,
    costUsd: session.costUsd,
    preview: session.preview,
  });

  try { session._provider.dispose?.(session)?.catch(() => {}); } catch { /* best effort */ }

  // Release the transcript stream. Without this the HTTP response stays open on
  // its keepalive and the UI keeps presenting a session that has already ended.
  for (const sub of session.subscribers) {
    try { sub.close(); } catch { /* the stream may already be gone */ }
  }
  session.subscribers.clear();

  sseLog("SESSION-REAPED", sessionId,
    `status=${previousStatus} age=${idleSeconds}s announced=${announce ? "yes" : "no"} `
    + `reason=${reason} totalActive=${activeSessions.size}`);
}

function reapStaleSessions(): void {
  const now = Date.now();
  const toReap: Array<{ id: string; reason: string }> = [];
  const idleSessions: ActiveSession[] = [];

  for (const [id, session] of activeSessions) {
    const age = now - session.lastEventAt;

    if (session.status === "done" || session.status === "error") {
      if (age >= REAP_TERMINAL_AFTER_MS && session.subscribers.size === 0) {
        toReap.push({ id, reason: `${session.status} session settled` });
      }
    } else if (session.status === "idle") {
      idleSessions.push(session);
    } else if (session.status === "starting") {
      // Stuck in starting state — provider failed to spawn or connect.
      // These zombies hold a slot in activeSessions but do nothing.
      if (age >= REAP_STARTING_AFTER_MS) {
        toReap.push({ id, reason: "provider never finished starting" });
      }
    } else if (session.status === "interrupting") {
      if (age >= REAP_INTERRUPTING_AFTER_MS) {
        toReap.push({ id, reason: "provider teardown did not finish" });
      }
    }
  }

  if (idleSessions.length > 0) {
    const samples = sampleIdleSessions(idleSessions, now);
    const ctx = { underPressure: isUnderMemoryPressure() };
    const limits = resolveReapLimits();
    // Recorded every sweep, not only when something is reclaimed: a policy that
    // never fires because it is measuring nothing looks exactly like one that
    // never fires because nothing crossed a limit. System usage rides along
    // because the watchdog only speaks above 75%, leaving no record of how
    // close pressure ever came.
    sseLog("REAP-SURVEY", undefined,
      `${formatIdleSurvey(samples, ctx, limits)} sysMem=${getMemoryStatus().usagePercent}%`);
    // Name the sessions that could not be measured, since which provider failed
    // to register a pid is the next question and cannot be recovered later.
    const unmeasured = samples.filter((s) => s.cliRssBytes === null || s.treeRssBytes === null);
    for (const sample of unmeasured.slice(0, 8)) {
      const session = activeSessions.get(sample.sessionId);
      sseLog("REAP-UNMEASURED", sample.sessionId,
        `provider=${session?.provider ?? "?"} cli=${providerCliName(session?.provider ?? "") ?? "none"} `
        + `osPids=${session?.osPids.size ?? 0} idle=${Math.round(sample.idleMs / 1000)}s`);
    }
    for (const entry of planIdleReaps(samples, ctx, limits)) {
      toReap.push({ id: entry.sessionId, reason: entry.reason });
    }
  }

  for (const { id, reason } of toReap) reclaimSession(id, reason, now);

  if (toReap.length > 0) {
    console.log(`[session-reaper] reclaimed ${toReap.length} session(s), ${activeSessions.size} remain`);
  }
}

let reapTimer: ReturnType<typeof setInterval> | null = null;

export function startSessionReaper(): void {
  if (reapTimer) return;
  // Probe the process table once at startup. Whether the platform tooling works
  // inside a packaged backend is otherwise only observable after a session has
  // been idle long enough to be surveyed, and it is the first thing to rule out
  // when the memory rules never fire.
  try {
    const table = sampleProcessTable();
    sseLog("REAP-PROBE", undefined, table.size > 0
      ? `process table readable, rows=${table.size}`
      : "process table UNREADABLE — memory rules cannot fire, only the idle backstop");
  } catch (err) {
    sseLog("REAP-PROBE", undefined, `process table sample threw: ${err}`);
  }
  reapTimer = setInterval(reapStaleSessions, REAP_INTERVAL_MS);
}

export function stopSessionReaper(): void {
  if (reapTimer) { clearInterval(reapTimer); reapTimer = null; }
}

// ── Cleanup ──

/**
 * How long shutdown waits for provider teardown before giving up on it. A provider's
 * dispose() is what reaps its CLI subprocess, so exiting while it is still running
 * orphans that subprocess — on POSIX it is reparented to init and survives us.
 */
const PROVIDER_DISPOSE_TIMEOUT_MS = 5_000;

/**
 * Tear down every active session. Returns once provider teardown has settled or the
 * timeout above expires, whichever comes first; callers must await it before exiting
 * the process. abort() below is synchronous and reaps the subprocess on the ordinary
 * path — the wait matters for the degraded path, where dispose() is doing the work.
 */
export function shutdownAll(): Promise<void> {
  stopSessionReaper();
  const disposals: Promise<unknown>[] = [];
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
      flushPendingAssistantTurn(session, { type: "done", reason: "session shutdown" });
      session._provider.abort(session);
      const disposal = session._provider.dispose?.(session);
      if (disposal) disposals.push(disposal.catch(() => {}));
    } catch { /* best effort */ }
    revokeSessionMcpCredentials(id);
    sseLog("SESSION-UNREGISTERED", id, `subsAtRemoval=${session.subscribers.size} totalActive=${activeSessions.size - 1}`);
    activeSessions.delete(id);
  }
  if (disposals.length === 0) return Promise.resolve();
  return Promise.race([
    Promise.all(disposals).then(() => {}),
    Bun.sleep(PROVIDER_DISPOSE_TIMEOUT_MS),
  ]);
}

// ── Branching ──

export type ConversationBranchCapability = "native-message" | "transcript-copy" | "unsupported";

export type BranchPreview = {
  sourceSessionId: string;
  branchSeq: number;
  provider: string;
  requiresConfirmation: true;
  conversation: {
    capability: ConversationBranchCapability;
    supported: boolean;
    label: string;
    warning?: string;
  };
  workspace: RewindPreview | null;
};

function conversationBranchPreview(provider: string, messageUuid: string | null): BranchPreview["conversation"] {
  if (provider === "claude-code" && messageUuid) {
    return { capability: "native-message", supported: true, label: "Claude native message fork" };
  }
  if (provider === "cursor") {
    return {
      capability: "transcript-copy",
      supported: false,
      label: "Transcript copy only",
      warning: "Cursor does not expose an arbitrary native fork here; Modus will not present transcript copying as a real branch.",
    };
  }
  return {
    capability: "unsupported",
    supported: false,
    label: "Provider-native branch not wired",
    warning: "This provider does not currently have a verified native branch implementation in Modus.",
  };
}

function observeDeclaredFileTools(session: ActiveSession, event: any): void {
  if (event?.type !== "assistant" || !Array.isArray(event?.message?.content)) return;
  for (const block of event.message.content) {
    if (block?.type !== "tool_use" || typeof block.name !== "string" || !block.input || typeof block.input !== "object") continue;
    const name = block.name.toLowerCase();
    if (!/(write|edit|replace|patch|notebook)/.test(name)) continue;
    const rawPath = block.input.file_path ?? block.input.path ?? block.input.notebook_path;
    if (typeof rawPath !== "string" || !rawPath.trim()) continue;
    const operation = /(write|create)/.test(name) ? "write" : "edit";
    insertFileObservation({
      sessionId: session.sessionId,
      seq: session.seq,
      provider: session.provider,
      toolCallId: typeof block.id === "string" ? block.id : undefined,
      toolName: block.name,
      path: rawPath,
      operation,
      details: { source: "assistant tool_use event" },
    });
  }
}

export async function previewSessionBranch(
  sourceId: string,
  branchSeq: number,
  opts?: { restoreCode?: boolean; checkpointSeq?: number; providerMessageId?: string },
): Promise<BranchPreview | { error: string }> {
  const source = getSession(sourceId);
  if (!source) return { error: "source session not found" };
  if (!Number.isInteger(branchSeq) || branchSeq < 0 || branchSeq > getMaxSeq(sourceId)) {
    return { error: "branch seq is outside the stored session history" };
  }
  const provider = source.provider ?? "claude-code";
  const messageUuid = findAssistantUuid(sourceId, branchSeq);
  let workspace: RewindPreview | null = null;
  if (opts?.restoreCode) {
    const active = activeSessions.get(sourceId);
    const nativePreview = active && opts.providerMessageId && active._provider.previewWorkspaceRewind
      ? await active._provider.previewWorkspaceRewind(active, opts.providerMessageId)
      : null;
    if (nativePreview?.available) {
      workspace = {
        capability: "native-claude",
        status: "ready",
        files: nativePreview.files.map((path) => ({
          path,
          action: "provider-rewind" as const,
          evidence: "native-provider" as const,
          reason: "provider-reported" as const,
        })),
        excluded: [],
        unchangedCount: 0,
        managedBytes: 0,
        undoAvailable: !!source.cwd,
        scopeNotes: [
          "Claude reported these exact paths from its native file checkpoint.",
          "Claude file checkpoints may not include changes made indirectly by shell commands.",
          "Modus will capture a bounded managed-file safety checkpoint immediately before applying the native rewind.",
        ],
      };
    } else {
      const checkpoint = checkpointForSeq(sourceId, opts.checkpointSeq ?? branchSeq);
      workspace = checkpoint ? await previewCheckpoint(checkpoint.id) : {
          capability: "unsupported",
          status: "unsupported",
          files: [],
          excluded: [],
          unchangedCount: 0,
          managedBytes: 0,
          undoAvailable: false,
          scopeNotes: [],
          error: "no managed checkpoint exists at or before that message",
        };
    }
  }
  return {
    sourceSessionId: sourceId,
    branchSeq,
    provider,
    requiresConfirmation: true,
    conversation: conversationBranchPreview(provider, messageUuid),
    workspace,
  };
}

export async function branchSession(
  sourceId: string,
  branchSeq: number,
  opts?: {
    /** Also reset the working tree to its checkpointed state before the rewound-to message ran */
    restoreCode?: boolean;
    /** Seq of the original user message (for checkpoint lookup) — defaults to branchSeq */
    checkpointSeq?: number;
    /** Provider's original user-message ID, used only for verified native rewind APIs. */
    providerMessageId?: string;
    /** Must be true after the caller displays a fresh preview. */
    confirmed?: boolean;
  },
): Promise<{
  sessionId: string;
  conversationCapability: ConversationBranchCapability;
  workspace: RewindResult | null;
} | { error: string }> {
  if (!opts?.confirmed) return { error: "explicit confirmation is required" };
  const source = getSession(sourceId);
  if (!source) return { error: "source session not found" };

  const preview = await previewSessionBranch(sourceId, branchSeq, opts);
  if ("error" in preview) return preview;
  if (!preview.conversation.supported) {
    return { error: preview.conversation.warning ?? "conversation branch is unsupported" };
  }
  if (opts.restoreCode && (!preview.workspace || preview.workspace.status === "unsupported")) {
    return { error: preview.workspace?.error ?? "workspace rewind is unsupported" };
  }

  // Find the SDK assistant message UUID for resumeSessionAt
  const messageUuid = findAssistantUuid(sourceId, branchSeq);

  let workspace: RewindResult | null = null;
  if (opts.restoreCode && preview.workspace?.capability === "native-claude") {
    const active = activeSessions.get(sourceId);
    const applyNative = active?._provider.applyWorkspaceRewind;
    if (!active || !applyNative || !opts.providerMessageId || !source.cwd) {
      return { error: "Claude native file checkpoint is no longer available; review again" };
    }
    const safety = await captureCheckpoint(source.cwd, sourceId, getMaxSeq(sourceId));
    if (!safety.ok) return { error: `could not create the required pre-rewind safety checkpoint: ${safety.reason}` };
    const native = await applyNative(active, opts.providerMessageId);
    if (!native.ok) return { error: native.error ?? "Claude native file rewind failed" };
    workspace = {
      status: safety.manifest.excluded.length > 0 ? "partial" : "success",
      undoCheckpointId: safety.checkpointId,
      restored: [],
      deleted: [],
      providerChanged: native.files,
      excluded: safety.manifest.excluded,
    };
  } else if (opts.restoreCode && preview.workspace?.checkpointId) {
    workspace = await restoreCheckpointById(preview.workspace.checkpointId, {
      sessionId: sourceId,
      seq: getMaxSeq(sourceId),
    });
    if (workspace.status === "failed" || workspace.status === "unsupported") {
      return { error: workspace.error ?? "workspace rewind failed" };
    }
  }

  // Create new session — just a copy with a fresh ID
  const newId = crypto.randomUUID();

  // Create DB row first (events FK references sessions)
  upsertSession({
    id: newId,
    preview: source.preview,
    profile: source.profile ?? undefined,
    provider: source.provider ?? undefined,
    model: source.model ?? undefined,
    status: "idle",
    messageCount: 0,
    costUsd: 0,
    lastPrompt: source.last_prompt ?? undefined,
    cwd: source.cwd ?? undefined,
    userProfile: source.user_profile ?? undefined,
    parentSessionId: sourceId,
    branchMessageUuid: messageUuid ?? undefined,
  });

  // Copy events from source up to branchSeq
  const copied = copyEventsToSession(sourceId, newId, branchSeq);
  if (copied === 0) return { error: "no events to copy at that seq" };
  const copiedMessages = copyMessagesToSession(sourceId, newId, branchSeq);
  upsertSession({
    id: newId,
    preview: source.preview,
    profile: source.profile ?? undefined,
    provider: source.provider ?? undefined,
    model: source.model ?? undefined,
    status: "idle",
    messageCount: copiedMessages,
    costUsd: 0,
    lastPrompt: source.last_prompt ?? undefined,
    cwd: source.cwd ?? undefined,
    userProfile: source.user_profile ?? undefined,
    parentSessionId: sourceId,
    branchMessageUuid: messageUuid ?? undefined,
  });

  return {
    sessionId: newId,
    conversationCapability: preview.conversation.capability,
    workspace,
  };
}

export async function restoreSessionCheckpoint(
  sessionId: string,
  checkpointId: number,
  confirmed: boolean,
): Promise<RewindResult | { error: string }> {
  if (!confirmed) return { error: "explicit confirmation is required" };
  if (!getSession(sessionId)) return { error: "session not found" };
  const checkpoint = checkpointById(checkpointId);
  if (!checkpoint || checkpoint.session_id !== sessionId) return { error: "checkpoint does not belong to this session" };
  return restoreCheckpointById(checkpointId, { sessionId, seq: getMaxSeq(sessionId) });
}

export async function previewSessionCheckpoint(
  sessionId: string,
  checkpointId: number,
): Promise<RewindPreview | { error: string }> {
  if (!getSession(sessionId)) return { error: "session not found" };
  const checkpoint = checkpointById(checkpointId);
  if (!checkpoint || checkpoint.session_id !== sessionId) return { error: "checkpoint does not belong to this session" };
  return previewCheckpoint(checkpointId);
}
