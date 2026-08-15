/**
 * Input Store — per-session draft storage for the chat input.
 *
 * Keeps a Map<sessionId, string> so switching sessions preserves
 * unsent drafts. Components subscribe via useInputValue() which
 * only re-renders when the active session's value changes.
 */

import { useSyncExternalStore } from "react";

const drafts = new Map<string, string>();
let activeSessionId: string | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function notify() {
  revision++;
  for (const fn of listeners) fn();
}

export function getInputValue(): string {
  return (activeSessionId ? drafts.get(activeSessionId) : undefined) ?? "";
}

export function setInputValue(v: string) {
  const current = getInputValue();
  if (v === current) return;
  if (activeSessionId) {
    if (v) {
      drafts.set(activeSessionId, v);
    } else {
      drafts.delete(activeSessionId);
    }
  }
  notify();
}

/**
 * Whether a draft just fetched from the server may be written into the composer.
 *
 * Only into an empty one. The fetch races the user: selecting a session paints
 * the composer immediately, and on a cold, long, or remote session the draft and
 * history requests can take seconds to land. Anything already in the composer by
 * then is either what the user has just typed or an in-memory draft that survived
 * the switch, and both are newer than the server's copy.
 */
export function shouldApplyFetchedDraft(currentValue: string): boolean {
  return currentValue.length === 0;
}

export function setActiveInputSession(id: string | null) {
  if (id === activeSessionId) return;
  activeSessionId = id;
  notify();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): number {
  return revision;
}

/** React hook — re-renders only when the active session's input value changes. */
export function useInputValue(): string {
  useSyncExternalStore(subscribe, getSnapshot);
  return getInputValue();
}
