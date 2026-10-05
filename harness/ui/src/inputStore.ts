/**
 * Input Store — per-session draft storage for the chat input.
 *
 * Keeps typed text and pasted-text chips by session so switching chats
 * preserves unsent drafts. Paste chips survive composer remounts in this
 * browser tab, but are not persisted across page reloads.
 */

import { useCallback, useSyncExternalStore, type SetStateAction } from "react";

const drafts = new Map<string, string>();
export type StagedPaste = { id: string; text: string };
const pastedDrafts = new Map<string, StagedPaste[]>();
const EMPTY_PASTES: StagedPaste[] = [];
let activeSessionId: string | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function notify() {
  revision++;
  for (const fn of listeners) fn();
}

export function getInputValue(): string {
  return activeSessionId ? getInputValueForSession(activeSessionId) : "";
}

export function getInputValueForSession(sessionId: string): string {
  return drafts.get(sessionId) ?? "";
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

/** Paste chips belong to the draft's session, including across composer remounts. */
export function useInputPastes(sessionId: string) {
  const getPastes = useCallback(() => pastedDrafts.get(sessionId) ?? EMPTY_PASTES, [sessionId]);
  const pastes = useSyncExternalStore(subscribe, getPastes, getPastes);
  const setPastes = useCallback((update: SetStateAction<StagedPaste[]>) => {
    const previous = pastedDrafts.get(sessionId) ?? EMPTY_PASTES;
    const next = typeof update === "function" ? update(previous) : update;
    if (next === previous) return;
    if (next.length) pastedDrafts.set(sessionId, next);
    else pastedDrafts.delete(sessionId);
    notify();
  }, [sessionId]);
  return [pastes, setPastes] as const;
}
