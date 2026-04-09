/**
 * Input Store — external store for the main chat input value.
 *
 * Isolates input state from SessionProvider so keystrokes don't
 * trigger full-app re-renders. Only components that explicitly
 * subscribe via useInputValue() re-render on typing.
 *
 * Provider-level operations (selectSession, newSession, send, etc.)
 * use setInputValue() / getInputValue() imperatively.
 */

import { useSyncExternalStore } from "react";

let value = "";
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function getInputValue(): string {
  return value;
}

export function setInputValue(v: string) {
  if (v === value) return;
  value = v;
  notify();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook — re-renders only when the input value changes. */
export function useInputValue(): string {
  return useSyncExternalStore(subscribe, getInputValue);
}
