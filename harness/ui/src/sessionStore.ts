/**
 * Session Store — multi-session state management.
 *
 * Holds a Map<sessionId, ReducerState> with external-store semantics
 * for React (useSyncExternalStore). Each session with a live SSE
 * connection gets its own reducer instance.
 */

import { useSyncExternalStore } from "react";
import { createInitialState, reduceEvent, type ReducerState } from "./eventReducer";
import { subscribeEvents } from "./api";
import type { Session } from "./api/types";

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

/** Update state for a session via a reducer event */
export function applyEvent(id: string, event: any, seq: number) {
  // UI command events — dispatch and skip reducer
  if (event.type === "ui" && typeof event.action === "string") {
    const set = uiEventListeners.get(event.action);
    if (set) for (const fn of set) fn(id, event);
    return;
  }

  const entry = sessions.get(id);
  if (!entry) return;
  const prevStatus = entry.state.status;
  entry.state = reduceEvent(entry.state, event, seq);
  // During SSE catch-up replay of a completed session, suppress spurious "running" status
  if (entry.catchingUp && (entry.state.status === "running" || entry.state.status === "starting")) {
    entry.state = { ...entry.state, status: prevStatus };
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

/** Re-key a session (e.g. pending-xxx → real ID) */
export function rekeySession(oldId: string, newId: string) {
  const entry = sessions.get(oldId);
  if (!entry) return;
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
    onDone: () => {
      subscriptions.delete(sessionId);
      const entry = sessions.get(sessionId);
      if (entry) {
        entry.catchingUp = false;
        const st = entry.state;
        // Mark idle if status got stuck as running (shouldn't happen with catchingUp guard, but safety net)
        if (st.status === "running" || st.status === "starting") {
          entry.state = { ...st, status: "idle" };
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
