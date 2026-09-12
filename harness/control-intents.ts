/**
 * Control Intents — a named vocabulary for driving the client's view from
 * outside the browser.
 *
 * The client is otherwise a pure initiator: it opens SSE streams and nothing
 * pushes commands at it. Keyboard shortcuts, the only inbound event a client
 * extension can receive, require OS focus — so a desk control, a pedal, or a
 * script becomes a paperweight the moment the user clicks into another app.
 * An intent is published to the harness and fanned out to every listening
 * client, focused or not.
 *
 * ## Why this vocabulary and not a bigger one
 *
 * Every intent here moves the viewport and nothing else. Worst case for a
 * hostile publisher is that the user's scroll position changes. That bound is
 * the reason the surface needs no new confirmation boundary, and it is the
 * property to preserve: an intent that opens the microphone, submits the
 * composer, or answers a permission prompt is a different authority class and
 * does not belong in this union. Adding one means designing its gate first —
 * device pairing, loopback origin, and an explicit opt-in — not appending a
 * member here.
 *
 * `session.cycle` is the edge of what is navigation. It changes which session
 * the user is reading, which is a view change; it does not create, send,
 * archive, or spend anything.
 *
 * ## Delivery
 *
 * Fan-out only, no persistence, no replay. A publisher learns how many clients
 * received the intent, which is what lets a hardware producer tell "nothing is
 * listening" apart from "it did not work" without inventing a health protocol.
 * A client that is not connected misses it, and that is correct: a knob turned
 * while the window was closed should not be replayed on reconnect.
 */

/** Steps are bounded so a runaway producer cannot ask for unbounded work. */
const MAX_DELTA = 999;

export type ControlIntent =
  /** Move the transcript by whole turns. Negative is toward the start. */
  | { intent: "transcript.scrollByTurns"; delta: number }
  /** Jump to the live end of the transcript and resume following it. */
  | { intent: "transcript.follow" }
  /** Move to another session in the current list. Wraps. */
  | { intent: "session.cycle"; delta: number };

export type ControlIntentName = ControlIntent["intent"];

export const CONTROL_INTENT_NAMES: readonly ControlIntentName[] = [
  "transcript.scrollByTurns",
  "transcript.follow",
  "session.cycle",
];

function parseDelta(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw === 0) return null;
  const clamped = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, raw));
  return clamped;
}

/**
 * Strict allowlist parse. Returns null for anything not exactly in the union —
 * an unknown intent name, a missing or non-integer delta, a zero step. Callers
 * on both ends of the wire use this: the publisher rejects at the boundary, and
 * the client re-validates rather than trusting a payload because it arrived on
 * an authenticated stream.
 */
export function parseControlIntent(raw: unknown): ControlIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const name = (raw as { intent?: unknown }).intent;
  if (typeof name !== "string") return null;

  switch (name) {
    case "transcript.follow":
      return { intent: "transcript.follow" };
    case "transcript.scrollByTurns": {
      const delta = parseDelta((raw as { delta?: unknown }).delta);
      return delta === null ? null : { intent: "transcript.scrollByTurns", delta };
    }
    case "session.cycle": {
      const delta = parseDelta((raw as { delta?: unknown }).delta);
      return delta === null ? null : { intent: "session.cycle", delta };
    }
    default:
      return null;
  }
}

// ── Fan-out bus ──
// Mirrors the global session event bus in session-manager.ts: a Set of writers,
// a write that drops its own subscriber on failure. Intentionally separate from
// that bus because the two have opposite directions — session events describe
// what happened, intents ask for something to happen — and merging them would
// put an unvalidated command on a stream clients already trust as observation.

export type ControlIntentWriter = {
  write(data: string): Promise<void>;
  close(): void;
};

const subscribers = new Set<ControlIntentWriter>();

export function subscribeControlIntents(writer: ControlIntentWriter): () => void {
  subscribers.add(writer);
  return () => { subscribers.delete(writer); };
}

/** @returns how many clients the intent was written to. */
export function publishControlIntent(intent: ControlIntent): number {
  const data = JSON.stringify(intent);
  let delivered = 0;
  for (const sub of subscribers) {
    try {
      sub.write(data).catch(() => { subscribers.delete(sub); });
      delivered++;
    } catch {
      subscribers.delete(sub);
    }
  }
  return delivered;
}

/** Listener count, for the publish response and for tests. */
export function controlIntentListenerCount(): number {
  return subscribers.size;
}
