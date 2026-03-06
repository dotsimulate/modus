/**
 * Session Store — multi-session state management.
 *
 * Holds a Map<sessionId, ReducerState> with external-store semantics
 * for React (useSyncExternalStore). Each session with a live SSE
 * connection gets its own reducer instance.
 */

import { useSyncExternalStore, useCallback } from "react";
import { createInitialState, reduceEvent, type ReducerState } from "./eventReducer";
import { subscribeEvents } from "./api";
import type { Session, PendingPermission } from "./api/types";

// ── Store State ──

type SessionEntry = {
  state: ReducerState;
  profile?: string;
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
  sessions.set(id, { state, profile: profile ?? sessions.get(id)?.profile });
  notify();
}

/** Update state for a session via a reducer event */
export function applyEvent(id: string, event: any, seq: number) {
  const entry = sessions.get(id);
  if (!entry) return;
  entry.state = reduceEvent(entry.state, event, seq);
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

  const unsub = subscribeEvents(sessionId, afterSeq, {
    onEvent: (event, seq) => {
      applyEvent(sessionId, event, seq);
    },
    onDone: () => {
      subscriptions.delete(sessionId);
      // Mark idle if still running
      const entry = sessions.get(sessionId);
      if (entry) {
        const st = entry.state;
        if (st.status === "running" || st.status === "starting") {
          entry.state = { ...st, status: "idle" };
          notify();
        }
      }
      onDone?.();
    },
    onDisconnect: () => {
      subscriptions.delete(sessionId);
      // Reconnect after brief delay
      setTimeout(() => {
        const entry = sessions.get(sessionId);
        if (entry) {
          subscribeSession(sessionId, entry.state.lastSeq, entry.profile, onDone);
        }
      }, 2000);
    },
    onError: (error) => {
      subscriptions.delete(sessionId);
      const entry = sessions.get(sessionId);
      if (entry) {
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

export function deriveSession(rs: ReducerState, profile?: string): Session {
  return {
    id: rs.sessionId,
    status: rs.status,
    preview: rs.messages[0]?.content?.slice(0, 60) ?? "",
    profile,
    model: rs.model,
    messages: rs.messages,
    totalCost: rs.totalCost,
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

/**
 * React hook — returns the derived Session for a given session ID.
 * Re-renders when any store state changes.
 */
export function useSessionState(id: string | null): Session | null {
  useSyncExternalStore(subscribe, getSnapshot);
  if (!id) return null;
  const entry = sessions.get(id);
  if (!entry) return null;
  return deriveSession(entry.state, entry.profile);
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
