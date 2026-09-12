import { afterEach, describe, expect, test } from "bun:test";
import {
  currentTurnKey,
  dispatchControlIntent,
  registerControlIntentHandler,
  resetControlIntentHandlers,
  stepSessionId,
  stepTurnKey,
} from "../../ui/src/control-intent-routing";

afterEach(() => resetControlIntentHandlers());

describe("stepTurnKey", () => {
  const turns = ["t1", "t2", "t3", "t4"];

  test("steps in both directions", () => {
    expect(stepTurnKey(turns, "t2", 1)).toBe("t3");
    expect(stepTurnKey(turns, "t3", -2)).toBe("t1");
  });

  test("clamps at the ends and reports no movement", () => {
    expect(stepTurnKey(turns, "t4", 1)).toBeNull();
    expect(stepTurnKey(turns, "t1", -1)).toBeNull();
    // A big step short of the end still moves, it just lands on the end.
    expect(stepTurnKey(turns, "t1", 99)).toBe("t4");
  });

  test("an unknown anchor enters from the matching end", () => {
    expect(stepTurnKey(turns, null, 1)).toBe("t1");
    expect(stepTurnKey(turns, null, -1)).toBe("t4");
    expect(stepTurnKey(turns, "gone", 2)).toBe("t2");
  });

  test("degenerate input never throws", () => {
    expect(stepTurnKey([], "t1", 1)).toBeNull();
    expect(stepTurnKey(turns, "t1", 0)).toBeNull();
  });
});

describe("stepSessionId", () => {
  const ids = ["a", "b", "c"];

  test("wraps in both directions", () => {
    expect(stepSessionId(ids, "c", 1)).toBe("a");
    expect(stepSessionId(ids, "a", -1)).toBe("c");
    expect(stepSessionId(ids, "a", 4)).toBe("b");
    expect(stepSessionId(ids, "a", -4)).toBe("c");
  });

  test("a full revolution is a no-op rather than a redundant reselect", () => {
    expect(stepSessionId(ids, "b", 3)).toBeNull();
  });

  test("an unknown current id starts from the first entry", () => {
    expect(stepSessionId(ids, null, 1)).toBe("b");
    expect(stepSessionId(ids, "gone", 1)).toBe("b");
  });

  test("a single session has nowhere to cycle to", () => {
    expect(stepSessionId(["only"], "only", 1)).toBeNull();
    expect(stepSessionId([], null, 1)).toBeNull();
  });
});

describe("currentTurnKey", () => {
  const turns = ["t1", "t2", "t3"];
  const offsets = new Map([["t1", 0], ["t2", 400], ["t3", 900]]);

  test("finds the turn the viewport is inside", () => {
    expect(currentTurnKey(turns, offsets, 0)).toBe("t1");
    expect(currentTurnKey(turns, offsets, 380)).toBe("t1");
    expect(currentTurnKey(turns, offsets, 400)).toBe("t2");
    expect(currentTurnKey(turns, offsets, 5000)).toBe("t3");
  });

  test("tolerates landing a sub-pixel short of an anchor", () => {
    // scrollToKey lands on fractional device pixels. Without the tolerance a
    // knob stalls for one detent here: the viewport is visibly on t2, but the
    // step would read t1 as current and move to t2 again.
    expect(currentTurnKey(turns, offsets, 399.5)).toBe("t2");
  });

  test("falls back to the first turn before anything is measured", () => {
    expect(currentTurnKey(turns, new Map(), 500)).toBe("t1");
    expect(currentTurnKey([], new Map(), 0)).toBeNull();
  });

  test("skips unmeasured anchors instead of guessing their position", () => {
    const partial = new Map([["t1", 0], ["t3", 900]]);
    expect(currentTurnKey(turns, partial, 500)).toBe("t1");
  });
});

describe("handler registry", () => {
  test("routes an intent to its handler", () => {
    const seen: number[] = [];
    registerControlIntentHandler("transcript.scrollByTurns", (intent) => {
      if (intent.intent === "transcript.scrollByTurns") seen.push(intent.delta);
    });
    dispatchControlIntent({ intent: "transcript.scrollByTurns", delta: -2 });
    expect(seen).toEqual([-2]);
  });

  test("only the most recently registered handler runs", () => {
    const seen: string[] = [];
    registerControlIntentHandler("transcript.follow", () => seen.push("first"));
    registerControlIntentHandler("transcript.follow", () => seen.push("second"));
    dispatchControlIntent({ intent: "transcript.follow" });
    expect(seen).toEqual(["second"]);
  });

  test("unregistering hands control back to the previous owner", () => {
    const seen: string[] = [];
    registerControlIntentHandler("transcript.follow", () => seen.push("first"));
    const dropSecond = registerControlIntentHandler("transcript.follow", () => seen.push("second"));
    dropSecond();
    dispatchControlIntent({ intent: "transcript.follow" });
    expect(seen).toEqual(["first"]);
  });

  test("an unhandled intent is a silent no-op", () => {
    expect(() => dispatchControlIntent({ intent: "session.cycle", delta: 1 })).not.toThrow();
  });

  test("a throwing handler does not break the dispatcher", () => {
    registerControlIntentHandler("transcript.follow", () => { throw new Error("boom"); });
    expect(() => dispatchControlIntent({ intent: "transcript.follow" })).not.toThrow();
  });

  test("unregistering twice is harmless", () => {
    const drop = registerControlIntentHandler("transcript.follow", () => {});
    drop();
    expect(() => drop()).not.toThrow();
  });

  // A provider is an ancestor of the surface it backs, and React runs a child's
  // effects first — so the generic handler registers last and would win on mount
  // order alone. These pin the tier, not the order.
  test("a fallback loses to a handler registered before it", () => {
    const seen: string[] = [];
    registerControlIntentHandler("session.cycle", () => seen.push("surface"));
    registerControlIntentHandler("session.cycle", () => seen.push("fallback"), { fallback: true });
    dispatchControlIntent({ intent: "session.cycle", delta: 1 });
    expect(seen).toEqual(["surface"]);
  });

  test("a fallback loses to a handler registered after it", () => {
    const seen: string[] = [];
    registerControlIntentHandler("session.cycle", () => seen.push("fallback"), { fallback: true });
    registerControlIntentHandler("session.cycle", () => seen.push("surface"));
    dispatchControlIntent({ intent: "session.cycle", delta: 1 });
    expect(seen).toEqual(["surface"]);
  });

  test("a fallback answers when no surface has claimed the intent", () => {
    const seen: string[] = [];
    registerControlIntentHandler("session.cycle", () => seen.push("fallback"), { fallback: true });
    dispatchControlIntent({ intent: "session.cycle", delta: 1 });
    expect(seen).toEqual(["fallback"]);
  });

  test("the fallback takes over again once the surface unmounts", () => {
    const seen: string[] = [];
    registerControlIntentHandler("session.cycle", () => seen.push("fallback"), { fallback: true });
    const dropSurface = registerControlIntentHandler("session.cycle", () => seen.push("surface"));
    dispatchControlIntent({ intent: "session.cycle", delta: 1 });
    dropSurface();
    dispatchControlIntent({ intent: "session.cycle", delta: 1 });
    expect(seen).toEqual(["surface", "fallback"]);
  });
});
