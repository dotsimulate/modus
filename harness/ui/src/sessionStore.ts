/**
 * Session Store — multi-session state management.
 *
 * Holds a Map<sessionId, ReducerState> with external-store semantics
 * for React (useSyncExternalStore). Each session with a live SSE
 * connection gets its own reducer instance.
 */

import { useSyncExternalStore, useCallback } from "react";
import { createInitialState, reduceEvent, type ReducerState } from "./eventReducer";
import { modus } from "./modusClient";
import {
  multiSubscribe, multiReconnect, multiRekey, multiUnsubscribeAll,
} from "./multiEventStream";
import { nextMsgId, type Session, type SessionHistorySnapshot, type TurnContent } from "../../sdk/index";

// ── Store State ──

type SessionEntry = {
  state: ReducerState;
  profile?: string;
  provider?: string;
  nextProfile?: string;
  nextAgentConfig?: Session["nextAgentConfig"];
  /** True while we're replaying historical SSE events — suppresses spurious "running" status */
  catchingUp?: boolean;
  /** Whether persisted conversation history has actually been resolved. */
  historyStatus?: "idle" | "loading" | "ready" | "error";
  historyError?: string;
  historyHasMore?: boolean;
  historyOldestSeq?: number | null;
  historyLoadingOlder?: boolean;
  historyOlderError?: string;
  /** Per-session revision — useSessionState only re-renders when this changes */
  revision: number;
};

export type SessionHistoryLoadState = {
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  hasMore: boolean;
  loadingOlder: boolean;
  olderError?: string;
};

const HISTORY_FETCH_TIMEOUT_MS = 30_000;
// Six-ish user/assistant exchanges is enough to paint useful context quickly;
// older pages stay one click away. Tool-heavy turns can be hundreds of KB each.
const HISTORY_PAGE_SIZE = 12;

type Subscription = {
  unsub: () => void;
  sessionId: string;
  profile?: string;
};

const sessions = new Map<string, SessionEntry>();
const subscriptions = new Map<string, Subscription>();
const listeners = new Set<() => void>();

// Snapshot reference — changes on every mutation to trigger React re-renders
let snapshot = 0;

function notify() {
  snapshot++;
  for (const fn of listeners) fn();
}

// ── Store API ──

/** Get the ReducerState for a session (or null if not in store) */
export function getSessionState(id: string): ReducerState | null {
  return sessions.get(id)?.state ?? null;
}

/** Get the profile name associated with a session */
export function getSessionProfile(id: string): string | undefined {
  return sessions.get(id)?.profile;
}

/** Set or replace state for a session */
export function setSessionState(id: string, state: ReducerState, profile?: string) {
  const existing = sessions.get(id);
  sessions.set(id, {
    state,
    profile: profile ?? existing?.profile,
    provider: existing?.provider,
    nextProfile: existing?.nextProfile,
    nextAgentConfig: existing?.nextAgentConfig,
    historyStatus: existing?.historyStatus,
    historyError: existing?.historyError,
    historyHasMore: existing?.historyHasMore,
    historyOldestSeq: existing?.historyOldestSeq,
    historyLoadingOlder: existing?.historyLoadingOlder,
    historyOlderError: existing?.historyOlderError,
    revision: (existing?.revision ?? 0) + 1,
  });
  notify();
}

function messageFromTurn(sessionId: string, turn: TurnContent): ReducerState["messages"][number] {
  const contentBlocks = turn.contentBlocks?.map((block, index) => {
    if (block.type === "text") {
      const start = block.textStart ?? 0;
      const end = block.textEnd ?? start;
      return { type: "text" as const, text: block.text ?? turn.text.slice(start, end) };
    }
    if (block.type !== "tool_call") return block;
    const toolCall = block.toolCall;
    return {
      type: "tool_call" as const,
      toolCall: {
        id: toolCall.id ?? `${sessionId}:${turn.seq}:ordered-tool:${index}`,
        name: toolCall.name,
        input: toolCall.input,
        status: "completed" as const,
        ...(toolCall.result != null ? { result: toolCall.result } : {}),
        startedAt: turn.timestamp,
      },
    };
  });
  return {
    id: nextMsgId(),
    role: turn.role,
    content: turn.text,
    ...(turn.uuid ? { uuid: turn.uuid } : {}),
    ...(turn.thinking ? { thinking: turn.thinking } : {}),
    ...(turn.seq ? { seq: turn.seq } : {}),
    ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
    ...(turn.artifacts ? { artifacts: turn.artifacts } : {}),
    ...(contentBlocks?.length ? { contentBlocks } : {}),
    ...(turn.detailsDeferred ? { detailsDeferred: true } : {}),
    ...(turn.deferredToolCallCount ? { deferredToolCallCount: turn.deferredToolCallCount } : {}),
    ...(turn.toolCalls ? {
      toolCalls: turn.toolCalls.map((toolCall, index) => ({
        id: `${sessionId}:${turn.seq}:tool:${index}`,
        name: toolCall.name,
        input: toolCall.input,
        status: "completed" as const,
        ...(toolCall.result ? { result: toolCall.result } : {}),
        startedAt: turn.timestamp,
      })),
    } : {}),
  };
}

function messagesFromHistorySnapshot(snapshotData: SessionHistorySnapshot): ReducerState["messages"] {
  return snapshotData.messages.map((turn) => messageFromTurn(snapshotData.sessionId, turn));
}

function buildStateFromHistorySnapshot(snapshotData: SessionHistorySnapshot): ReducerState {
  const state = createInitialState(snapshotData.sessionId);
  state.status = snapshotData.status;
  state.model = snapshotData.model;
  state.agentConfig = snapshotData.agentConfig;
  state.cwd = snapshotData.cwd;
  state.additionalDirectories = snapshotData.additionalDirectories;
  state.loadProjectSettings = snapshotData.loadProjectSettings;
  state.lastSeq = snapshotData.lastSeq;
  state.createdAt = snapshotData.createdAt;
  state.messages = messagesFromHistorySnapshot(snapshotData);
  return state;
}

export function hydrateSessionHistorySnapshot(snapshotData: SessionHistorySnapshot, profile?: string) {
  setSessionState(snapshotData.sessionId, buildStateFromHistorySnapshot(snapshotData), profile);
  const entry = sessions.get(snapshotData.sessionId);
  if (entry) {
    entry.historyHasMore = !!snapshotData.hasMoreHistory;
    entry.historyOldestSeq = snapshotData.oldestSeq ?? null;
    entry.historyLoadingOlder = false;
    entry.historyOlderError = undefined;
  }
  setHistoryLoadState(snapshotData.sessionId, "ready");
}

function setHistoryLoadState(
  sessionId: string,
  status: SessionHistoryLoadState["status"],
  error?: string,
) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  if (entry.historyStatus === status && entry.historyError === error) return;
  entry.historyStatus = status;
  entry.historyError = error;
  entry.revision++;
  notify();
}

export function getSessionHistoryLoadState(sessionId: string | null): SessionHistoryLoadState {
  if (!sessionId) return { status: "idle", hasMore: false, loadingOlder: false };
  const entry = sessions.get(sessionId);
  return {
    status: entry?.historyStatus ?? "idle",
    ...(entry?.historyError ? { error: entry.historyError } : {}),
    hasMore: !!entry?.historyHasMore,
    loadingOlder: !!entry?.historyLoadingOlder,
    ...(entry?.historyOlderError ? { olderError: entry.historyOlderError } : {}),
  };
}

/** Prepend one older bounded page without disturbing the live SSE cursor. */
export async function loadOlderSessionHistory(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry || !entry.historyHasMore || entry.historyLoadingOlder) return;
  const beforeSeq = entry.historyOldestSeq
    ?? entry.state.messages.reduce<number | null>((min, message) => (
      typeof message.seq === "number" && message.seq > 0 && (min === null || message.seq < min)
        ? message.seq
        : min
    ), null);
  if (!beforeSeq) return;

  entry.historyLoadingOlder = true;
  entry.historyOlderError = undefined;
  entry.revision++;
  notify();
  try {
    const snapshotData = await modus.getSessionHistorySnapshot(sessionId, {
      limit: HISTORY_PAGE_SIZE,
      beforeSeq,
      details: "summary",
    });
    const current = sessions.get(sessionId);
    if (!current) return;
    const existingKeys = new Set(current.state.messages.map((message) => (
      `${message.role}:${message.seq ?? 0}:${message.uuid ?? ""}:${message.content}`
    )));
    const older = messagesFromHistorySnapshot(snapshotData).filter((message) => !existingKeys.has(
      `${message.role}:${message.seq ?? 0}:${message.uuid ?? ""}:${message.content}`
    ));
    current.state.messages = [...older, ...current.state.messages];
    current.historyHasMore = !!snapshotData.hasMoreHistory;
    current.historyOldestSeq = snapshotData.oldestSeq ?? beforeSeq;
    current.historyLoadingOlder = false;
    current.historyOlderError = undefined;
    current.revision++;
    notify();
  } catch {
    const current = sessions.get(sessionId);
    if (!current) return;
    current.historyLoadingOlder = false;
    current.historyOlderError = "Could not load earlier messages.";
    current.revision++;
    notify();
  }
}

/** Resolve heavy thinking/tool data for one summary message on demand. */
export async function loadSessionMessageDetails(sessionId: string, seq: number): Promise<void> {
  const entry = sessions.get(sessionId);
  const index = entry?.state.messages.findIndex((message) => message.seq === seq) ?? -1;
  if (!entry || index < 0) return;
  const existing = entry.state.messages[index]!;
  if (!existing.detailsDeferred || existing.detailsLoading) return;
  entry.state = {
    ...entry.state,
    messages: entry.state.messages.map((message, messageIndex) => (
      messageIndex === index ? { ...existing, detailsLoading: true, detailsError: undefined } : message
    )),
  };
  entry.revision++;
  notify();
  try {
    const turn = await modus.getMessages(sessionId, seq);
    if (Array.isArray(turn)) throw new Error("message detail response was not singular");
    const current = sessions.get(sessionId);
    const currentIndex = current?.state.messages.findIndex((message) => message.seq === seq) ?? -1;
    if (!current || currentIndex < 0) return;
    const previous = current.state.messages[currentIndex]!;
    current.state = {
      ...current.state,
      messages: current.state.messages.map((message, messageIndex) => messageIndex === currentIndex
        ? {
            ...messageFromTurn(sessionId, turn),
            id: previous.id,
            meta: previous.meta,
            detailsDeferred: false,
            detailsLoading: false,
            detailsError: undefined,
          }
        : message),
    };
    current.revision++;
    notify();
  } catch {
    const current = sessions.get(sessionId);
    const currentIndex = current?.state.messages.findIndex((message) => message.seq === seq) ?? -1;
    if (!current || currentIndex < 0) return;
    const previous = current.state.messages[currentIndex]!;
    current.state = {
      ...current.state,
      messages: current.state.messages.map((message, messageIndex) => messageIndex === currentIndex
        ? {
            ...previous,
            detailsLoading: false,
            detailsError: "Could not load message details.",
          }
        : message),
    };
    current.revision++;
    notify();
  }
}

/** Set the profile queued for the next user turn */
export function setSessionNextProfile(id: string, nextProfile?: string) {
  const entry = sessions.get(id);
  if (!entry) return;
  entry.nextProfile = nextProfile || undefined;
  entry.revision++;
  notify();
}

/** Set the agent config queued for the next user turn */
export function setSessionNextAgentConfig(id: string, nextAgentConfig?: Session["nextAgentConfig"]) {
  const entry = sessions.get(id);
  if (!entry) return;
  entry.nextAgentConfig = nextAgentConfig;
  entry.revision++;
  notify();
}

// ── UI Event Bus ──
// Ephemeral events from backend (type: "ui") that trigger frontend actions
// without affecting session state. Listeners are per-action.

type UiEventListener = (sessionId: string, event: any) => void;
const uiEventListeners = new Map<string, Set<UiEventListener>>();

/** Subscribe to a specific UI event action (e.g. "open-file") */
export function onUiEvent(action: string, listener: UiEventListener): () => void {
  let set = uiEventListeners.get(action);
  if (!set) { set = new Set(); uiEventListeners.set(action, set); }
  set.add(listener);
  return () => { set!.delete(listener); };
}

// Track old→new ID mappings so SSE callbacks with stale IDs can resolve
const rekeyMap = new Map<string, string>();

/** Resolve a session ID through any rekey chain */
function resolveId(id: string): string {
  let resolved = id;
  while (rekeyMap.has(resolved)) resolved = rekeyMap.get(resolved)!;
  return resolved;
}

/** Apply a batch of events in one pass, notifying React only once at the end */
export function applyEventBatch(id: string, events: { event: string; data: any; seq: number }[]) {
  const _aebT0 = performance.now();
  const resolvedId = resolveId(id);
  const entry = sessions.get(resolvedId);
  if (!entry) return;

  for (const evt of events) {
    const event = evt.data;
    const seq = evt.seq;

    // UI command events — dispatch immediately
    if (event.type === "ui" && typeof event.action === "string") {
      const set = uiEventListeners.get(event.action);
      if (set) for (const fn of set) fn(resolvedId, event);
      continue;
    }

    // Skip events that only matter for real-time streaming display.
    // During catch-up replay, the materialized assistant/user/result
    // events already contain the final content. Streaming deltas would
    // just rebuild text character-by-character, copying the messages
    // array on each delta — for large sessions (50k+ deltas) this
    // freezes the browser for seconds to minutes.
    if (
      event.type === "stream_event"
      || event.type === "tool_progress"
      || event.type === "tool_use_summary"
      || (event.type === "system" && event.subtype === "live_snapshot")
    ) {
      continue;
    }

    const prevStatus = entry.state.status;
    entry.state = reduceEvent(entry.state, event, seq);
    if (entry.catchingUp && (entry.state.status === "running" || entry.state.status === "starting" || entry.state.status === "interrupting")) {
      entry.state = { ...entry.state, status: prevStatus };
    }
    // Handle rekey within batch — but NOT during catch-up replay.
    // Completed sessions may contain multiple init events with different
    // session_id values (e.g. temp → real → temp again after interrupts).
    // Replaying those rekeys creates an infinite subscribe loop between
    // the old and new IDs. The store already has the correct final ID.
    if (!entry.catchingUp && event.type === "system" && event.subtype === "init" && event.session_id && event.session_id !== resolvedId) {
      rekeySession(resolvedId, event.session_id);
      return; // rekey triggers notify
    }
    if (event.type === "system" && event.subtype === "switch" && event.toProfile) {
      entry.profile = event.toProfile;
      entry.nextProfile = undefined;
      entry.nextAgentConfig = undefined;
    }
  }

  // Ensure lastSeq covers all events in the batch including skipped ones,
  // so the next SSE subscribe doesn't replay them again.
  if (events.length > 0) {
    const batchMaxSeq = events[events.length - 1].seq;
    if (batchMaxSeq > entry.state.lastSeq) {
      entry.state = { ...entry.state, lastSeq: batchMaxSeq };
    }
  }

  // A completed catch-up batch is also authoritative history hydration.
  if (entry.historyStatus !== "ready") {
    entry.historyStatus = "ready";
    entry.historyError = undefined;
  }

  entry.revision++;
  notify(); // single React re-render for the entire batch
  const _aebMs = performance.now() - _aebT0;
  if (_aebMs > 10) console.log(`[CLIENT-TIMING] applyEventBatch ${events.length} events ${_aebMs.toFixed(1)}ms session=${id.slice(0,8)}`);
}

/** Update state for a session via a reducer event */
export function applyEvent(id: string, event: any, seq: number) {
  // Resolve stale IDs from SSE callbacks that still reference pre-rekey IDs
  const resolvedId = resolveId(id);

  // UI command events — dispatch and skip reducer
  if (event.type === "ui" && typeof event.action === "string") {
    const set = uiEventListeners.get(event.action);
    if (set) for (const fn of set) fn(resolvedId, event);
    return;
  }

  const entry = sessions.get(resolvedId);
  if (!entry) return;
  if (entry.historyStatus !== "ready") {
    entry.historyStatus = "ready";
    entry.historyError = undefined;
  }
  const prevStatus = entry.state.status;
  entry.state = reduceEvent(entry.state, event, seq);
  // During SSE catch-up replay of a completed session, suppress spurious "running" status
  if (entry.catchingUp && (entry.state.status === "running" || entry.state.status === "starting" || entry.state.status === "interrupting")) {
    entry.state = { ...entry.state, status: prevStatus };
  }
  // Auto-rekey when provider's init event carries a different session ID
  // (e.g. temp ses-* → real UUID from claude-code-pty or other providers).
  // Skip during catch-up — replaying old rekeys creates infinite loops.
  if (!entry.catchingUp && event.type === "system" && event.subtype === "init" && event.session_id && event.session_id !== resolvedId) {
    rekeySession(resolvedId, event.session_id);
    return; // rekeySession already calls notify()
  }
  // Profile switch: update the entry-level profile name
  if (event.type === "system" && event.subtype === "switch" && event.toProfile) {
    entry.profile = event.toProfile;
    entry.nextProfile = undefined;
    entry.nextAgentConfig = undefined;
  }
  entry.revision++;
  notify();
}

/** Remove a session from the store */
export function removeSession(id: string) {
  sessions.delete(id);
  notify();
}

/** Listeners for session rekey events (e.g. ses-* → UUID) */
const rekeyListeners = new Set<(oldId: string, newId: string) => void>();

/** Subscribe to rekey events. Returns unsubscribe function. */
export function onSessionRekey(fn: (oldId: string, newId: string) => void): () => void {
  rekeyListeners.add(fn);
  return () => { rekeyListeners.delete(fn); };
}

/** Re-key a session (e.g. pending-xxx → real ID) */
export function rekeySession(oldId: string, newId: string) {
  const entry = sessions.get(oldId);
  if (!entry) return;
  // Record mapping so SSE callbacks with stale IDs can resolve
  rekeyMap.set(oldId, newId);
  sessions.delete(oldId);
  entry.state = { ...entry.state, sessionId: newId };
  entry.revision++;
  sessions.set(newId, entry);

  // Also migrate subscription if one exists
  const sub = subscriptions.get(oldId);
  if (sub) {
    subscriptions.delete(oldId);
    sub.sessionId = newId;
    subscriptions.set(newId, sub);
  }
  // Move the multiplexed-stream registration to the new id so future reconnects
  // subscribe under the real id (events tagged with the old id still resolve
  // through rekeyMap until the next reconnect).
  multiRekey(oldId, newId);

  // Notify rekey listeners (SessionProvider uses this to update URL hash)
  for (const fn of rekeyListeners) fn(oldId, newId);

  notify();
}

/** Get all session IDs currently in the store */
export function getStoreSessionIds(): string[] {
  return Array.from(sessions.keys());
}

// ── SSE Subscription Management ──

/** Subscribe to SSE events for a session, creating store entry if needed */
export function subscribeSession(
  sessionId: string,
  afterSeq: number,
  profile?: string,
  onDone?: () => void,
) {
  // Don't double-subscribe
  if (subscriptions.has(sessionId)) return;

  // Ensure store entry exists
  if (!sessions.has(sessionId)) {
    const state = createInitialState(sessionId);
    sessions.set(sessionId, { state, profile, revision: 1 });
    notify();
  } else if (profile) {
    const entry = sessions.get(sessionId)!;
    entry.profile = profile;
  }

  // If replaying from the beginning for a session that isn't actively running,
  // suppress status→running updates so the UI doesn't look like a rerun.
  if (afterSeq === 0) {
    const entry = sessions.get(sessionId)!;
    const knownStatus = entry.state.status;
    if (knownStatus !== "running" && knownStatus !== "starting" && knownStatus !== "interrupting") {
      entry.catchingUp = true;
    }
  }

  // Register on the shared multiplexed event stream. The manager owns the
  // single connection (and its reconnection) for ALL sessions, so the browser's
  // ~6-connection HTTP/1.1 cap can't be exhausted no matter how many agents run.
  const unsub = multiSubscribe(sessionId, afterSeq, {
    onEvent: (event, seq) => {
      applyEvent(sessionId, event, seq);
    },
    onEventBatch: (events) => {
      applyEventBatch(sessionId, events);
    },
    onDone: () => {
      const entry = sessions.get(sessionId);
      if (entry) {
        entry.historyStatus = "ready";
        entry.historyError = undefined;
        entry.catchingUp = false;
        const st = entry.state;
        if (st.status === "running" || st.status === "starting" || st.status === "interrupting") {
          // Backend reports this session settled, but we still believe it's
          // active — most likely a freshly-sent message is reactivating it and
          // the shared stream connected a beat too early. Nudge a reconnect so
          // the backend attaches a live subscription. Capped; then accept idle.
          const retryKey = `__multiReactivate_${sessionId}`;
          const retryCount = (entry as any)[retryKey] ?? 0;
          if (retryCount < 3) {
            (entry as any)[retryKey] = retryCount + 1;
            setTimeout(() => {
              const e2 = sessions.get(sessionId);
              if (e2 && (e2.state.status === "running" || e2.state.status === "starting" || e2.state.status === "interrupting")) {
                multiReconnect();
              }
            }, 1500);
            return; // reactivation in progress — don't fire caller onDone yet
          }
          entry.state = { ...st, status: "idle" };
          (entry as any)[retryKey] = 0;
          entry.revision++;
          notify();
        } else {
          (entry as any)[`__multiReactivate_${sessionId}`] = 0;
        }
      }
      onDone?.();
    },
    onError: (error) => {
      const entry = sessions.get(sessionId);
      if (entry) {
        entry.catchingUp = false;
        entry.state = { ...entry.state, status: "error" };
        entry.revision++;
        notify();
      }
      console.error("Event stream error:", error);
    },
  });

  subscriptions.set(sessionId, { unsub, sessionId, profile });
}

/** Unsubscribe from SSE for a session (keeps store entry) */
export function unsubscribeSession(sessionId: string) {
  const sub = subscriptions.get(sessionId);
  if (sub) {
    sub.unsub();
    subscriptions.delete(sessionId);
  }
}

// In-flight ensureSubscribed calls, keyed by sessionId — lets multiple widgets
// racing to mount on the same session share a single snapshot fetch.
const pendingEnsure = new Map<string, Promise<void>>();

export type EnsureSubscribedOpts = {
  /** Profile to attach to the store entry if not yet set */
  profile?: string;
  /**
   * Known live status from the server-side session index. When set to
   * running/starting/paused, we skip the snapshot fetch and subscribe from
   * whatever cursor is already in the store — matching the old selectSession
   * behavior. Without this hint we'll fetch a snapshot to avoid the
   * "replay-over-snapshot" duplication race.
   */
  activeStatus?: Session["status"];
  /** Forwarded to subscribeSession's onDone (e.g. refreshSessions) */
  onDone?: () => void;
  /** Retry persisted-history hydration when the local thread is still empty. */
  forceHistoryRefresh?: boolean;
};

export function shouldReuseSessionSubscription(input: {
  subscribed: boolean;
  forceHistoryRefresh?: boolean;
  messageCount: number;
  lastSeq: number;
  historyStatus?: SessionEntry["historyStatus"];
}): boolean {
  if (!input.subscribed) return false;
  if (input.forceHistoryRefresh && input.messageCount === 0) return false;
  const hasLocalHistory = input.messageCount > 0 || input.lastSeq > 0;
  if (hasLocalHistory) return true;
  return input.historyStatus === "ready"
    || input.historyStatus === "loading";
}

async function fetchHistorySnapshotWithTimeout(sessionId: string): Promise<SessionHistorySnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HISTORY_FETCH_TIMEOUT_MS);
  try {
    return await modus.getSessionHistorySnapshot(sessionId, {
      signal: controller.signal,
      // Text and user prompts are lightweight and must remain complete and
      // chronologically intelligible. Only thinking/tool bodies are deferred.
      limit: "all",
      details: "summary",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ensure a session has an active SSE subscription, fetching a history
 * snapshot first when necessary so the reducer never replays events that
 * the snapshot has already materialized.
 *
 * Idempotent and race-safe: concurrent callers on the same sessionId share
 * one in-flight snapshot fetch, and any caller that arrives after the
 * subscription is live is a no-op.
 *
 * This is the canonical entry point — all UI code should go through here
 * instead of calling subscribeSession directly. subscribeSession remains
 * exported only for the internal onDisconnect/onDone retry paths, which
 * already know the right cursor.
 */
export function ensureSubscribed(
  sessionId: string,
  opts: EnsureSubscribedOpts = {},
): Promise<void> {
  const currentEntry = sessions.get(sessionId);
  const reuseSubscription = shouldReuseSessionSubscription({
    subscribed: subscriptions.has(sessionId),
    forceHistoryRefresh: opts.forceHistoryRefresh,
    messageCount: currentEntry?.state.messages.length ?? 0,
    lastSeq: currentEntry?.state.lastSeq ?? 0,
    historyStatus: currentEntry?.historyStatus,
  });
  if (reuseSubscription) {
    // Update profile if the caller has one and the entry didn't
    if (opts.profile) {
      const entry = sessions.get(sessionId);
      if (entry && !entry.profile) entry.profile = opts.profile;
    }
    // If the caller knows the session is (re)activating (e.g. a message was just
    // sent), force the shared stream to reconnect so the backend attaches a live
    // subscription for it — it may have been settled when the stream connected.
    const hinted = opts.activeStatus;
    if (hinted === "running" || hinted === "starting" || hinted === "interrupting" || hinted === "paused") {
      multiReconnect();
    }
    return Promise.resolve();
  }
  if (subscriptions.has(sessionId)) unsubscribeSession(sessionId);
  const pending = pendingEnsure.get(sessionId);
  if (pending) return pending;

  const run = (async () => {
    const _ensT0 = performance.now();
    try {
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
          state: createInitialState(sessionId),
          profile: opts.profile,
          revision: 1,
          historyStatus: "idle",
        });
        notify();
      }
      const existing = getSessionState(sessionId);
      const hasWarmState = !!existing && (existing.lastSeq > 0 || existing.messages.length > 0);
      const needsForcedHistory = !!opts.forceHistoryRefresh && (existing?.messages.length ?? 0) === 0;

      const hinted = opts.activeStatus;
      const storedStatus = existing?.status;
      const isActive = hinted === "running" || hinted === "starting" || hinted === "interrupting" || hinted === "paused"
        || storedStatus === "running" || storedStatus === "starting" || storedStatus === "interrupting";

      let afterSeq = existing?.lastSeq ?? 0;

      // Always refetch snapshot when the session isn't mid-flight. Cached
      // store state gets stale the moment we unsubscribe — if events
      // arrived while we were detached, subscribing from our old lastSeq
      // lets the UI render stale messages before SSE catch-up lands.
      // The snapshot is authoritative; let it overwrite.
      //
      // Cold active sessions also fetch the snapshot first. That restores
      // completed history after a hard refresh while live SSE rebuilds the
      // current in-flight turn on top of the snapshot cursor.
      if (needsForcedHistory || !isActive || !hasWarmState) {
        setHistoryLoadState(sessionId, "loading");
        try {
          const snap = await fetchHistorySnapshotWithTimeout(sessionId);
          if (subscriptions.has(sessionId)) return; // another caller won

          const latest = getSessionState(sessionId);
          const latestHasWarmState = !!latest && (latest.lastSeq > 0 || latest.messages.length > 0);
          const hasAssistantToolCalls = snap.messages.some((m) => (
            m.role === "assistant"
            && Array.isArray((m as any).toolCalls)
            && (m as any).toolCalls.length > 0
          ));

          if (hasAssistantToolCalls && !latestHasWarmState && !snap.recoveredFromEvents) {
            // Cold entry with tool-call history — snapshot's tool-call
            // serialization is historically ambiguous, so do a full event
            // replay from seq=0 against a clean state.
            const rs = createInitialState(sessionId);
            rs.status = snap.status;
            rs.model = snap.model;
            rs.cwd = snap.cwd;
            setSessionState(sessionId, rs, opts.profile);
            afterSeq = 0;
          } else {
            const isSnapshotMeaningful = snap.messages.length > 0 || snap.lastSeq > 0;
            const shouldApplySnapshot = isSnapshotMeaningful
              && (!latest
                || snap.lastSeq > latest.lastSeq
                || snap.messages.length >= latest.messages.length);
            if (shouldApplySnapshot) {
              hydrateSessionHistorySnapshot(snap, opts.profile);
              // snap.lastSeq is the live high-water mark — for a running session
              // it equals active.seq, which sits AHEAD of the last materialized
              // message. The in-flight turn's already-persisted assistant/tool
              // events live in that gap, so subscribing from snap.lastSeq skips
              // them and the agent's mid-turn work stays invisible until the turn
              // ends and a reload re-fetches the now-materialized snapshot. For an
              // active session, resume from the last materialized message instead
              // so SSE catch-up replays the in-flight turn (sub-agent nesting and
              // all). Settled sessions have no gap, so they keep using lastSeq.
              afterSeq = isActive
                ? snap.messages.reduce((max, msg) => (typeof msg.seq === "number" && msg.seq > max ? msg.seq : max), 0)
                : snap.lastSeq;
            } else {
              afterSeq = latest?.lastSeq ?? 0;
              setHistoryLoadState(sessionId, "ready");
            }
          }
        } catch (error) {
          const message = error instanceof Error && error.name === "AbortError"
            ? "The Modus server did not answer the history request."
            : "Modus could not load this conversation's history.";
          setHistoryLoadState(sessionId, "error", message);
          // Snapshot fetch failed — fall back to streaming from whatever
          // cursor we have (0 for a brand-new entry).
        }
      }

      if (subscriptions.has(sessionId)) return; // raced with another caller
      subscribeSession(sessionId, afterSeq, opts.profile, opts.onDone);
    } finally {
      pendingEnsure.delete(sessionId);
      console.log(`[CLIENT-TIMING] ensureSubscribed ${sessionId.slice(0,8)} ${(performance.now() - _ensT0).toFixed(1)}ms`);
    }
  })();

  pendingEnsure.set(sessionId, run);
  return run;
}

/** Check if a session has an active SSE subscription */
export function isSubscribed(sessionId: string): boolean {
  return subscriptions.has(sessionId);
}

/** Evict all inactive sessions from the store, keeping the active one and any running sessions */
export function evictInactiveSessions(keepId: string) {
  let changed = false;
  for (const [id, entry] of sessions) {
    if (id === keepId) continue;
    if (id.startsWith("pending-")) continue;
    const status = entry.state.status;
    if (status === "running" || status === "starting" || status === "interrupting") continue;
    unsubscribeSession(id);
    sessions.delete(id);
    changed = true;
  }
  if (changed) notify();
}

/** Unsubscribe all sessions */
export function unsubscribeAll() {
  subscriptions.clear();
  multiUnsubscribeAll();
}

// ── Derive Session (public shape) from ReducerState ──

export function deriveSession(
  rs: ReducerState,
  profile?: string,
  provider?: string,
  nextProfile?: string,
  nextAgentConfig?: Session["nextAgentConfig"],
): Session {
  return {
    id: rs.sessionId,
    status: rs.status,
    preview: rs.messages[0]?.content?.slice(0, 60) ?? "",
    profile,
    provider,
    nextProfile,
    nextAgentConfig,
    model: rs.model,
    agentConfig: rs.agentConfig,
    cwd: rs.cwd || undefined,
    additionalDirectories: rs.additionalDirectories.length > 0 ? rs.additionalDirectories : undefined,
    loadProjectSettings: rs.loadProjectSettings,
    messages: rs.messages,
    totalCost: rs.totalCost,
    totalInputTokens: rs.totalInputTokens,
    totalOutputTokens: rs.totalOutputTokens,
    lastSeq: rs.lastSeq,
    createdAt: rs.createdAt,
    updatedAt: Date.now(),
    activeToolName: rs.activeToolName,
    activeToolElapsed: rs.activeToolElapsed,
    availableTools: rs.availableTools.length > 0 ? rs.availableTools : undefined,
    pendingPermissions: rs.pendingPermissions.length > 0 ? rs.pendingPermissions : undefined,
    streamFeed: rs.streamFeed || undefined,
  };
}

// ── React Hook ──

/** Subscribe to store changes (for useSyncExternalStore) */
function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): number {
  return snapshot;
}

/** Subscribe to the entire store — for components that need to react to any session change */
export function subscribeStore(callback: () => void): () => void {
  return subscribe(callback);
}

/** Get the store revision snapshot — use with subscribeStore in useSyncExternalStore */
export function getStoreSnapshot(): number {
  return getSnapshot();
}

/**
 * React hook — returns the derived Session for a given session ID.
 * Only re-renders when the watched session's revision changes,
 * not on every global store mutation.
 */
export function useSessionState(id: string | null): Session | null {
  const getSessionSnap = useCallback(
    () => id ? (sessions.get(id)?.revision ?? 0) : 0,
    [id],
  );
  useSyncExternalStore(subscribe, getSessionSnap);
  if (!id) return null;
  const entry = sessions.get(id);
  if (!entry) return null;
  return deriveSession(entry.state, entry.profile, entry.provider, entry.nextProfile, entry.nextAgentConfig);
}

/** React hook for distinguishing loading/failed history from a truly empty thread. */
export function useSessionHistoryLoadState(id: string | null): SessionHistoryLoadState {
  const getSessionSnap = useCallback(
    () => id ? (sessions.get(id)?.revision ?? 0) : 0,
    [id],
  );
  useSyncExternalStore(subscribe, getSessionSnap);
  return getSessionHistoryLoadState(id);
}

/**
 * React hook — returns the raw ReducerState for a session.
 * Only re-renders when the watched session changes.
 */
export function useSessionReducerState(id: string | null): ReducerState | null {
  const getSessionSnap = useCallback(
    () => id ? (sessions.get(id)?.revision ?? 0) : 0,
    [id],
  );
  useSyncExternalStore(subscribe, getSessionSnap);
  if (!id) return null;
  return sessions.get(id)?.state ?? null;
}
