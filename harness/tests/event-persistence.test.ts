/**
 * Which emit method a provider calls is a request, not the decision: `error` is
 * durable even when broadcast, and `stream_event` is live-only even when
 * emitted. Both overrides used to be inline type checks inside session-manager,
 * one in each emit path, which is exactly how they drifted from the declared
 * contract ("broadcast to SSE subscribers only (no DB persist)").
 *
 * The policy is pure, so the rules are tested directly. The second half scans
 * session-manager, because the failure this guards against is not a wrong
 * answer from the policy — it is a future edit that stops asking it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import {
  ALWAYS_DURABLE_EVENT_TYPES,
  LIVE_ONLY_EVENT_TYPES,
  isAlwaysDurableEvent,
  isLiveOnlyEvent,
  resolveEventPersistence,
} from "../event-persistence";

const HARNESS_DIR = resolve(import.meta.dir, "..");
const sessionManagerSource = readFileSync(join(HARNESS_DIR, "session-manager.ts"), "utf-8");

describe("event persistence policy", () => {
  test("an ordinary event honors the caller's request", () => {
    const event = { type: "assistant", text: "hello" };
    expect(resolveEventPersistence(event, "durable")).toBe("durable");
    expect(resolveEventPersistence(event, "live-only")).toBe("live-only");
  });

  test("a broadcast error is promoted to durable", () => {
    // The pre-flight provider failure case: broadcast before any assistant turn
    // exists, so nothing else would record it and the transcript reloads empty.
    expect(resolveEventPersistence({ type: "error", error: "spawn failed" }, "live-only")).toBe("durable");
    expect(isAlwaysDurableEvent({ type: "error" })).toBe(true);
  });

  test("an emitted stream_event is demoted to live-only", () => {
    // Persisting it would store the same assistant turn twice.
    expect(resolveEventPersistence({ type: "stream_event" }, "durable")).toBe("live-only");
    expect(isLiveOnlyEvent({ type: "stream_event" })).toBe(true);
  });

  test("the two overrides do not claim each other's events", () => {
    expect(isAlwaysDurableEvent({ type: "stream_event" })).toBe(false);
    expect(isLiveOnlyEvent({ type: "error" })).toBe(false);
    expect(isAlwaysDurableEvent({ type: "result", subtype: "error" })).toBe(false);
    expect(isLiveOnlyEvent({ type: "assistant" })).toBe(false);
  });

  test("a malformed event falls back to the caller's request", () => {
    // Providers hand these in as `any`; an undefined or typeless event must not
    // change persistence behavior on its own.
    for (const event of [undefined, null, {}, { type: 7 }, "error"]) {
      expect(resolveEventPersistence(event, "durable")).toBe("durable");
      expect(resolveEventPersistence(event, "live-only")).toBe("live-only");
    }
  });

  test("the declared override sets stay minimal", () => {
    // Adding a type here changes persistence for every provider at once, so it
    // should be a deliberate edit rather than an incidental one.
    expect([...LIVE_ONLY_EVENT_TYPES]).toEqual(["stream_event"]);
    expect([...ALWAYS_DURABLE_EVENT_TYPES]).toEqual(["error"]);
  });
});

/** The body of a top-level function declaration, so a scan cannot match an unrelated one. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

describe("session-manager routes both emit paths through the policy", () => {
  test("broadcastEvent asks the policy instead of testing the type inline", () => {
    // `broadcastEvent` is a method on the TurnContext literal, so the window is
    // the factory that builds it.
    const factory = functionBody(sessionManagerSource, "createTurnContext");
    expect(factory).toContain("isAlwaysDurableEvent(event)");
    // The inline form this replaced. It read as a local special case, which is
    // how the declared contract came to be wrong for every provider.
    expect(factory).not.toContain('event?.type === "error"');
  });

  test("the persist path asks the policy before writing an event", () => {
    const persist = functionBody(sessionManagerSource, "persistAndBroadcastEvent");
    expect(persist).toContain("isLiveOnlyEvent(event)");
    expect(persist).not.toContain('event.type === "stream_event"');
    // The ordering guarantee: coalesced deltas are flushed before a durable
    // event is written, so a persisted event cannot overtake the stream it follows.
    expect(persist).toContain("if (!liveOnly) flushLiveBroadcast(session)");
  });
});
