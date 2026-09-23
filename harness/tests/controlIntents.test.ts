import { describe, expect, test } from "bun:test";
import {
  CONTROL_INTENT_NAMES,
  controlIntentListenerCount,
  parseControlIntent,
  publishControlIntent,
  subscribeControlIntents,
} from "../control-intents";

function collector() {
  const seen: string[] = [];
  return {
    seen,
    writer: {
      async write(data: string) { seen.push(data); },
      close() {},
    },
  };
}

describe("control intent parsing", () => {
  test("accepts the whole vocabulary", () => {
    expect(parseControlIntent({ intent: "transcript.follow" }))
      .toEqual({ intent: "transcript.follow" });
    expect(parseControlIntent({ intent: "transcript.scrollByTurns", delta: -3 }))
      .toEqual({ intent: "transcript.scrollByTurns", delta: -3 });
    expect(parseControlIntent({ intent: "session.cycle", delta: 1 }))
      .toEqual({ intent: "session.cycle", delta: 1 });
    expect(parseControlIntent({ intent: "dictation.toggle" }))
      .toEqual({ intent: "dictation.toggle" });
  });

  test("the vocabulary list matches what parses", () => {
    for (const name of CONTROL_INTENT_NAMES) {
      expect(parseControlIntent({ intent: name, delta: 1, unit: "line", fraction: 0.5 })).not.toBeNull();
    }
  });

  test("a distance scroll takes a unit and a finite, non-zero amount", () => {
    expect(parseControlIntent({ intent: "transcript.scroll", unit: "line", delta: -3 }))
      .toEqual({ intent: "transcript.scroll", unit: "line", delta: -3 });
    expect(parseControlIntent({ intent: "transcript.scroll", unit: "px", delta: 120 }))
      .toEqual({ intent: "transcript.scroll", unit: "px", delta: 120 });
    // Half a page is a real request, unlike half a turn.
    expect(parseControlIntent({ intent: "transcript.scroll", unit: "page", delta: 0.5 }))
      .toEqual({ intent: "transcript.scroll", unit: "page", delta: 0.5 });

    expect(parseControlIntent({ intent: "transcript.scroll", delta: 3 })).toBeNull();
    expect(parseControlIntent({ intent: "transcript.scroll", unit: "em", delta: 3 })).toBeNull();
    expect(parseControlIntent({ intent: "transcript.scroll", unit: "toString", delta: 3 })).toBeNull();
    expect(parseControlIntent({ intent: "transcript.scroll", unit: "line", delta: 0 })).toBeNull();
    expect(parseControlIntent({ intent: "transcript.scroll", unit: "line", delta: Infinity })).toBeNull();
    expect(parseControlIntent({ intent: "transcript.scroll", unit: "line", delta: "3" })).toBeNull();
  });

  test("a distance scroll is clamped per unit", () => {
    expect(parseControlIntent({ intent: "transcript.scroll", unit: "line", delta: 5_000 }))
      .toEqual({ intent: "transcript.scroll", unit: "line", delta: 999 });
    expect(parseControlIntent({ intent: "transcript.scroll", unit: "page", delta: -500 }))
      .toEqual({ intent: "transcript.scroll", unit: "page", delta: -99 });
    expect(parseControlIntent({ intent: "transcript.scroll", unit: "px", delta: 1e9 }))
      .toEqual({ intent: "transcript.scroll", unit: "px", delta: 100_000 });
  });

  test("an absolute scroll clamps its fraction into the transcript", () => {
    expect(parseControlIntent({ intent: "transcript.scrollTo", fraction: 0.25 }))
      .toEqual({ intent: "transcript.scrollTo", fraction: 0.25 });
    expect(parseControlIntent({ intent: "transcript.scrollTo", fraction: 1.5 }))
      .toEqual({ intent: "transcript.scrollTo", fraction: 1 });
    expect(parseControlIntent({ intent: "transcript.scrollTo", fraction: -1 }))
      .toEqual({ intent: "transcript.scrollTo", fraction: 0 });
    expect(parseControlIntent({ intent: "transcript.scrollTo" })).toBeNull();
    expect(parseControlIntent({ intent: "transcript.scrollTo", fraction: NaN })).toBeNull();
  });

  test("rejects anything outside the allowlist", () => {
    expect(parseControlIntent({ intent: "listen.gate", value: "open" })).toBeNull();
    expect(parseControlIntent({ intent: "composer.submit" })).toBeNull();
    expect(parseControlIntent({ intent: "transcript.scrollbyturns", delta: 1 })).toBeNull();
  });

  test("rejects malformed shapes", () => {
    expect(parseControlIntent(null)).toBeNull();
    expect(parseControlIntent("transcript.follow")).toBeNull();
    expect(parseControlIntent({})).toBeNull();
    expect(parseControlIntent({ intent: 7 })).toBeNull();
  });

  test("a step must be a non-zero integer", () => {
    expect(parseControlIntent({ intent: "session.cycle" })).toBeNull();
    expect(parseControlIntent({ intent: "session.cycle", delta: 0 })).toBeNull();
    expect(parseControlIntent({ intent: "session.cycle", delta: 1.5 })).toBeNull();
    expect(parseControlIntent({ intent: "session.cycle", delta: "2" })).toBeNull();
    expect(parseControlIntent({ intent: "session.cycle", delta: NaN })).toBeNull();
  });

  test("clamps a step rather than rejecting it", () => {
    expect(parseControlIntent({ intent: "transcript.scrollByTurns", delta: 10_000 }))
      .toEqual({ intent: "transcript.scrollByTurns", delta: 999 });
    expect(parseControlIntent({ intent: "transcript.scrollByTurns", delta: -10_000 }))
      .toEqual({ intent: "transcript.scrollByTurns", delta: -999 });
  });
});

describe("control intent fan-out", () => {
  test("delivers to every subscriber and reports the count", () => {
    const a = collector();
    const b = collector();
    const unsubA = subscribeControlIntents(a.writer);
    const unsubB = subscribeControlIntents(b.writer);

    const delivered = publishControlIntent({ intent: "transcript.follow" });

    expect(delivered).toBe(2);
    expect(a.seen).toEqual(['{"intent":"transcript.follow"}']);
    expect(b.seen).toEqual(['{"intent":"transcript.follow"}']);
    unsubA();
    unsubB();
  });

  test("reports zero when nothing is listening", () => {
    expect(controlIntentListenerCount()).toBe(0);
    expect(publishControlIntent({ intent: "session.cycle", delta: 1 })).toBe(0);
  });

  test("unsubscribing stops delivery", () => {
    const a = collector();
    const unsub = subscribeControlIntents(a.writer);
    unsub();
    expect(publishControlIntent({ intent: "transcript.follow" })).toBe(0);
    expect(a.seen).toEqual([]);
  });

  test("a writer that throws is dropped rather than taking the publish down", () => {
    const good = collector();
    const bad = {
      async write() { throw new Error("dead socket"); },
      close() {},
    };
    // A synchronous throw is the case the async .catch() path cannot cover.
    const unsubBad = subscribeControlIntents({
      write: () => { throw new Error("dead socket"); },
      close: bad.close,
    });
    const unsubGood = subscribeControlIntents(good.writer);

    expect(publishControlIntent({ intent: "transcript.follow" })).toBe(1);
    expect(good.seen.length).toBe(1);
    expect(controlIntentListenerCount()).toBe(1);

    unsubBad();
    unsubGood();
  });
});
