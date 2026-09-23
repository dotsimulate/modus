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
 * ## What belongs here
 *
 * What a person does with a control at the desk: move through the transcript,
 * change session, start or stop dictation. Publishing takes the same harness
 * credential the app itself uses.
 *
 * Sending the composer and answering permission prompts stay out on purpose:
 * those are the moments the user reads what is being sent or approved, and a
 * remote producer cannot show that.
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

/**
 * Distance units for a continuous scroll. `line` is one line of message text at
 * the client's font scale — what a mouse wheel notch moves in multiples of — and
 * `page` is a viewport with a little overlap, like Page Down. The client resolves
 * both, because only it knows its font scale and viewport.
 */
export type TranscriptScrollUnit = "px" | "line" | "page";

const SCROLL_UNITS: Record<TranscriptScrollUnit, number> = {
  px: 100_000,
  line: 999,
  page: 99,
};

export type ControlIntent =
  /**
   * Scroll the transcript by a distance, the way a wheel does. Negative is
   * toward the start. Fractional amounts are allowed: half a page is a real
   * request, and a fine encoder may want sub-line steps.
   */
  | { intent: "transcript.scroll"; unit: TranscriptScrollUnit; delta: number }
  /** Scroll to a position in the loaded transcript: 0 is the top, 1 the end. */
  | { intent: "transcript.scrollTo"; fraction: number }
  /** Move the transcript by whole turns. Negative is toward the start. */
  | { intent: "transcript.scrollByTurns"; delta: number }
  /** Jump to the live end of the transcript and resume following it. */
  | { intent: "transcript.follow" }
  /** Move to another session in the current list. Wraps. */
  | { intent: "session.cycle"; delta: number }
  /**
   * Start or stop dictation into the active composer. Answered by whichever
   * dictation extension is loaded (Whisper Transcribe or Modus Listen); with none
   * loaded it arrives and nothing happens.
   */
  | { intent: "dictation.toggle" };

export type ControlIntentName = ControlIntent["intent"];

export const CONTROL_INTENT_NAMES: readonly ControlIntentName[] = [
  "transcript.scroll",
  "transcript.scrollTo",
  "transcript.scrollByTurns",
  "transcript.follow",
  "session.cycle",
  "dictation.toggle",
];

function parseDelta(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw === 0) return null;
  const clamped = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, raw));
  return clamped;
}

function parseScroll(raw: { unit?: unknown; delta?: unknown }): ControlIntent | null {
  const { unit, delta } = raw;
  if (typeof unit !== "string" || !Object.hasOwn(SCROLL_UNITS, unit)) return null;
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta === 0) return null;
  const bound = SCROLL_UNITS[unit as TranscriptScrollUnit];
  return {
    intent: "transcript.scroll",
    unit: unit as TranscriptScrollUnit,
    delta: Math.max(-bound, Math.min(bound, delta)),
  };
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
    case "transcript.scroll":
      return parseScroll(raw as { unit?: unknown; delta?: unknown });
    case "transcript.scrollTo": {
      const fraction = (raw as { fraction?: unknown }).fraction;
      if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
      return { intent: "transcript.scrollTo", fraction: Math.max(0, Math.min(1, fraction)) };
    }
    case "transcript.scrollByTurns": {
      const delta = parseDelta((raw as { delta?: unknown }).delta);
      return delta === null ? null : { intent: "transcript.scrollByTurns", delta };
    }
    case "session.cycle": {
      const delta = parseDelta((raw as { delta?: unknown }).delta);
      return delta === null ? null : { intent: "session.cycle", delta };
    }
    case "dictation.toggle":
      return { intent: "dictation.toggle" };
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
