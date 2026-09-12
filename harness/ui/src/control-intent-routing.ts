/**
 * Control intent routing — the part with no browser in it.
 *
 * Navigation arithmetic plus the handler registry. Split from `control-intents.ts`
 * so it can be tested without a DOM: that module opens an authenticated stream at
 * import time-ish and reaches `localStorage` for the token, which a test runner has
 * no business providing. Consumers import `control-intents.ts`, which re-exports
 * everything here.
 *
 * ## One handler per intent, last mount wins
 *
 * Handlers are a stack per intent name, and dispatch calls only the top. A physical
 * control has one target: if two transcripts are mounted, turning a knob three
 * detents should move one of them three turns, not two of them three turns each.
 * Unregistering pops, so the previous owner takes over again — which is what
 * closing a floating session window should do.
 *
 * ## Except for fallbacks, which sit under the stack
 *
 * "Last mount wins" is mount order, and mount order is not precedence: React runs
 * a child's effects before its parent's, so a provider that registers a generic
 * handler lands *above* the widget that renders the thing being driven. A handler
 * registered with `fallback` is pushed to the bottom instead, so it answers only
 * when no surface has claimed the intent — however the two happen to mount.
 */

import type { ControlIntent, ControlIntentName } from "../../control-intents";

export type ControlIntentHandler = (intent: ControlIntent) => void;

// ── Navigation arithmetic ──

/**
 * Step through turn anchors, clamped at both ends.
 *
 * Returns null when the step produces no movement, which lets the caller decide
 * what running off an end means — stepping past the newest turn is a reasonable
 * cue to jump to live, but that is a transcript decision, not arithmetic.
 *
 * An unknown `currentKey` anchors just outside the range, so a forward step from
 * nowhere lands on the first turn and a backward step lands on the last.
 */
export function stepTurnKey(
  turnKeys: readonly string[],
  currentKey: string | null,
  delta: number,
): string | null {
  if (!turnKeys.length || delta === 0) return null;
  const found = currentKey ? turnKeys.indexOf(currentKey) : -1;
  const anchor = found !== -1 ? found : (delta > 0 ? -1 : turnKeys.length);
  const next = Math.max(0, Math.min(turnKeys.length - 1, anchor + delta));
  if (next === anchor) return null;
  return turnKeys[next] ?? null;
}

/**
 * Step through a session list, wrapping.
 *
 * Wrapping where turns clamp is deliberate: a transcript has a beginning and an
 * end that mean something, a list of open sessions is a ring you cycle.
 */
export function stepSessionId(
  ids: readonly string[],
  currentId: string | null,
  delta: number,
): string | null {
  if (!ids.length || delta === 0) return null;
  const found = currentId ? ids.indexOf(currentId) : -1;
  const anchor = found !== -1 ? found : 0;
  const size = ids.length;
  const next = (((anchor + delta) % size) + size) % size;
  if (next === anchor) return null;
  return ids[next] ?? null;
}

/**
 * Which turn the viewport is currently inside: the last anchor at or above the
 * scroll position. Offsets come from the virtualizer's measured layout, so an
 * anchor that has not been measured yet is skipped rather than guessed at.
 */
export function currentTurnKey(
  turnKeys: readonly string[],
  offsets: ReadonlyMap<string, number>,
  scrollTop: number,
): string | null {
  let best: string | null = null;
  for (const key of turnKeys) {
    const offset = offsets.get(key);
    if (offset === undefined) continue;
    if (offset <= scrollTop + 1) best = key;
    else break;
  }
  return best ?? turnKeys[0] ?? null;
}

// ── Handler registry ──

const handlers = new Map<ControlIntentName, ControlIntentHandler[]>();

/** Exported for tests and for any producer that wants to drive the UI in-process. */
export function dispatchControlIntent(intent: ControlIntent): void {
  const stack = handlers.get(intent.intent);
  const top = stack?.[stack.length - 1];
  if (!top) return;
  try {
    top(intent);
  } catch (err) {
    console.error(`[control] handler for "${intent.intent}" threw:`, err);
  }
}

export type ControlIntentHandlerOptions = {
  /** Sit under the stack: answer only when no surface has claimed this intent. */
  fallback?: boolean;
};

export function registerControlIntentHandler(
  name: ControlIntentName,
  handler: ControlIntentHandler,
  options?: ControlIntentHandlerOptions,
): () => void {
  const stack = handlers.get(name) ?? [];
  if (options?.fallback) stack.unshift(handler);
  else stack.push(handler);
  handlers.set(name, stack);

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const current = handlers.get(name);
    if (!current) return;
    const idx = current.lastIndexOf(handler);
    if (idx !== -1) current.splice(idx, 1);
    if (!current.length) handlers.delete(name);
  };
}

/** How many intent names currently have an owner. Drives stream lifetime. */
export function controlIntentHandlerCount(): number {
  return handlers.size;
}

/** Test seam — drops every handler without unmounting anything. */
export function resetControlIntentHandlers(): void {
  handlers.clear();
}
