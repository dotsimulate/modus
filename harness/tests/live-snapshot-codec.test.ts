import { expect, test } from "bun:test";
import { createLiveSnapshotDecoder, createLiveSnapshotEncoder } from "../live-snapshot-codec";

const snapshot = (text: string, thinking = "", feed = "") => ({ type: "system", subtype: "live_snapshot", text, thinking, feed });

test("multiplexed deltas round-trip text, thinking, feeds, resets, and interleaved durable events", () => {
  const encode = createLiveSnapshotEncoder();
  const decode = createLiveSnapshotDecoder();
  const events = [
    ["a", 1, snapshot("start".repeat(100), "think".repeat(100), "feed")],
    ["b", 1, snapshot("other".repeat(100))],
    ["a", 3, snapshot("start".repeat(100) + "Δ🌊", "think".repeat(100) + "続", "new feed")],
    ["a", 4, { type: "assistant", message: { content: "settled" } }],
    ["a", 5, snapshot("", "fresh", "")],
    ["b", 2, snapshot("other".repeat(100) + " next")],
    ["a", 6, snapshot("new block", "fresh", "tool")],
    ["a", 6, snapshot("new block", "fresh", "tool")],
  ] as const;
  for (const [sid, seq, event] of events) expect(decode(sid, seq, encode(sid, seq, event))).toEqual(event);
});

test("new connections and old servers use full snapshots, and missing bases fail before delivery", () => {
  const first = snapshot("x".repeat(1000));
  const second = snapshot(first.text + "next");
  const encode = createLiveSnapshotEncoder();
  expect(encode("a", 10, first)).toBe(first);
  const delta = encode("a", 11, second);
  expect(delta.subtype).toBe("live_delta");
  expect(createLiveSnapshotEncoder()("a", 11, second)).toBe(second);
  const decode = createLiveSnapshotDecoder();
  expect(() => decode("a", 11, delta)).toThrow("base");
  expect(decode("a", 10, first)).toEqual(first);
  expect(() => decode("a", 11, { ...delta, text: [1001, "bad"] })).toThrow("Invalid");
  expect(decode("a", 11, delta)).toEqual(second);
  expect(decode("a", 12, snapshot("legacy full update"))).toEqual(snapshot("legacy full update"));
});

test("an appended 100k-character stream sends linear-sized updates with identical snapshots", () => {
  const encode = createLiveSnapshotEncoder();
  const decode = createLiveSnapshotDecoder();
  let fullBytes = 0;
  let wireBytes = 0;
  for (let i = 1; i <= 500; i++) {
    const event = snapshot("x".repeat(i * 200));
    const wire = encode("stream", i, event);
    fullBytes += JSON.stringify(event).length;
    wireBytes += JSON.stringify(wire).length;
    expect(decode("stream", i, wire)).toEqual(event);
  }
  expect(wireBytes).toBeLessThan(fullBytes / 100);
});
