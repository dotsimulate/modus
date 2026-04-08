/**
 * Session Store — multi-session state management.
 *
 * Holds a Map<sessionId, ReducerState> with external-store semantics
 * for React (useSyncExternalStore). Each session with a live SSE
 * connection gets its own reducer instance.
 */

import { useSyncExternalStore } from "react";
import { createInitialState, reduceEvent, type ReducerState } from "./eventReducer";
import { subscribeEvents } from "./modusClient";
import { nextMsgId, type Session, type SessionHistorySnapshot } from "../../sdk/index";

// ── Store State ──

type SessionEntry = {
  state: ReducerState;
  profile?: string;
  provider?: string;
  nextProfile?: string;
  nextAgentConfig?: Session["nextAgentConfig"];
  /** True while we're replaying historical SSE events — suppresses spurious "running" status */
  catchingUp?: boolean;
};

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
  });
  notify();
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
  state.messages = snapshotData.messages.map((turn) => ({
    id: nextMsgId(),
    role: turn.role,
    content: turn.text,
    ...(turn.uuid ? { uuid: turn.uuid } : {}),
    ...(turn.thinking ? { thinking: turn.thinking } : {}),
    ...(turn.seq ? { seq: turn.seq } : {}),
    ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
    ...(turn.artifacts ? { artifacts: turn.artifacts } : {}),
    ...(turn.toolCalls ? {
      toolCalls: turn.toolCalls.map((toolCall, index) => ({
        id: `${snapshotData.sessionId}:${turn.seq}:tool:${index}`,
        name: toolCall.name,
        input: toolCall.input,
        status: "completed" as const,
        ...(toolCall.result ? { result: toolCall.result } : {}),
        startedAt: turn.timestamp,
      })),
    } : {}),
  }));
  return state;
}

export function hydrateSessionHistorySnapshot(snapshotData: SessionHistorySnapshot, profile?: string) {
  setSessionState(snapshotData.sessionId, buildStateFromHistorySnapshot(snapshotData), profile);
}

/** Set the profile queued for the next user turn */
export function setSessionNextProfile(id: string, nextProfile?: string) {
  const entry = sessions.get(id);
  if (!entry) return;
  entry.nextProfile = nextProfile || undefined;
  notify();
}

/** Set the agent config queued for the next user turn */
export function setSessionNextAgentConfig(id: string, nextAgentConfig?: Session["nextAgentConfig"]) {
  const entry = sessions.get(id);
  if (!entry) return;
  entry.nextAgentConfig = nextAgentConfig;
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

    const prevStatus = entry.state.status;
    entry.state = reduceEvent(entry.state, event, seq);
    if (entry.catchingUp && (entry.state.status === "running" || entry.state.status === "starting")) {
      entry.state = { ...entry.state, status: prevStatus };
    }
    // Handle rekey within batch
    if (event.type === "system" && event.subtype === "init" && event.session_id && event.session_id !== resolvedId) {
      rekeySession(resolvedId, event.session_id);
      return; // rekey triggers notify
    }
    if (event.type === "system" && event.subtype === "switch" && event.toProfile) {
      entry.profile = event.toProfile;
      entry.nextProfile = undefined;
      entry.nextAgentConfig = undefined;
    }
  }
  notify(); // single React re-render for the entire batch
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
  const prevStatus = entry.state.status;
  entry.state = reduceEvent(entry.state, event, seq);
  // During SSE catch-up replay of a completed session, suppress spurious "running" status
  if (entry.catchingUp && (entry.state.status === "running" || entry.state.status === "starting")) {
    entry.state = { ...entry.state, status: prevStatus };
  }
  // Auto-rekey when provider's init event carries a different session ID
  // (e.g. temp ses-* → real UUID from claude-code-pty or other providers)
  if (event.type === "system" && event.subtype === "init" && event.session_id && event.session_id !== resolvedId) {
    rekeySession(resolvedId, event.session_id);
    return; // rekeySession already calls notify()
  }
  // Profile switch: update the entry-level profile name
  if (event.type === "system" && event.subtype === "switch" && event.toProfile) {
    entry.profile = event.toProfile;
    entry.nextProfile = undefined;
    entry.nextAgentConfig = undefined;
  }
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
  sessions.set(newId, entry);

  // Also migrate subscription if one exists
  const sub = subscriptions.get(oldId);
  if (sub) {
    subscriptions.delete(oldId);
    sub.sessionId = newId;
    subscriptions.set(newId, sub);
  }

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
    sessions.set(sessionId, { state, profile });
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
    if (knownStatus !== "running" && knownStatus !== "starting") {
      entry.catchingUp = true;
    }
  }

  const unsub = subscribeEvents(sessionId, afterSeq, {
    onEvent: (event, seq) => {
      applyEvent(sessionId, event, seq);
    },
    onEventBatch: (events) => {
      applyEventBatch(sessionId, events);
    },
    onDone: () => {
      subscriptions.delete(sessionId);
      const entry = sessions.get(sessionId);
      if (entry) {
        entry.catchingUp = false;
        const st = entry.state;
        if (st.status === "running" || st.status === "starting") {
          // SSE closed while we think the session is still active — likely a race
          // between sendMessage and SSE subscribe. Retry once after a brief delay
          // to give the backend time to reactivate the session.
          const retryKey = `__sseRetry_${sessionId}`;
          const retryCount = (entry as any)[retryKey] ?? 0;
          if (retryCount < 2) {
            (entry as any)[retryKey] = retryCount + 1;
            setTimeout(() => {
              const e2 = sessions.get(sessionId);
              if (e2 && (e2.state.status === "running" || e2.state.status === "starting")) {
                subscribeSession(sessionId, e2.state.lastSeq, e2.profile, onDone);
              }
            }, 2000);
            return; // don't fire onDone yet — retry in progress
          }
          // Exhausted retries — mark idle
          entry.state = { ...st, status: "idle" };
          (entry as any)[retryKey] = 0;
          notify();
        }
      }
      onDone?.();
    },
    onDisconnect: () => {
      subscriptions.delete(sessionId);
      // Clear catch-up mode so reconnect works normally
      const entry = sessions.get(sessionId);
      if (entry) entry.catchingUp = false;
      // Reconnect after brief delay
      setTimeout(() => {
        const entry2 = sessions.get(sessionId);
        if (entry2) {
          subscribeSession(sessionId, entry2.state.lastSeq, entry2.profile, onDone);
        }
      }, 2000);
    },
    onError: (error) => {
      subscriptions.delete(sessionId);
      const entry = sessions.get(sessionId);
      if (entry) {
        entry.catchingUp = false;
        entry.state = { ...entry.state, status: "error" };
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
    if (status === "running" || status === "starting") continue;
    unsubscribeSession(id);
    sessions.delete(id);
    changed = true;
  }
  if (changed) notify();
}

/** Unsubscribe all sessions */
export function unsubscribeAll() {
  for (const sub of subscriptions.values()) {
    sub.unsub();
  }
  subscriptions.clear();
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
 * Re-renders when any store state changes.
 */
export function useSessionState(id: string | null): Session | null {
  useSyncExternalStore(subscribe, getSnapshot);
  if (!id) return null;
  const entry = sessions.get(id);
  if (!entry) return null;
  return deriveSession(entry.state, entry.profile, entry.provider, entry.nextProfile, entry.nextAgentConfig);
}

/**
 * React hook — returns the raw ReducerState for a session.
 * Use when you need internal accumulators.
 */
export function useSessionReducerState(id: string | null): ReducerState | null {
  useSyncExternalStore(subscribe, getSnapshot);
  if (!id) return null;
  return sessions.get(id)?.state ?? null;
}
