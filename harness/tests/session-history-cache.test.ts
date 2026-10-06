import { expect, test } from "bun:test";
import { reconstructCachedSessionTurns } from "../session-history-cache";
import { reconstructSessionTurns, summarizeTurnDetails, type SessionHistoryEventRow } from "../session-history";

function fixture(): SessionHistoryEventRow[] {
  return [
    { id: 1, seq: 1, type: "user", subtype: "prompt", created_at: 1, data: JSON.stringify({ message: { content: "prompt" } }) },
    { id: 2, seq: 2, type: "assistant", subtype: "message", created_at: 2, data: JSON.stringify({ message: { content: [
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "before" },
      { type: "tool_use", id: "tool", name: "Read", input: { path: "fixture.ts" } },
      { type: "text", text: "after" },
    ] } }) },
    { id: 3, seq: 3, type: "user", subtype: "tool_result", created_at: 3, data: JSON.stringify({ message: { content: [
      { type: "tool_result", tool_use_id: "tool", content: "output".repeat(10_000) },
    ] } }) },
    { id: 4, seq: 4, type: "result", subtype: "success", created_at: 4, data: JSON.stringify({ subtype: "success", duration_ms: 20, total_cost_usd: 0.1, usage: { input_tokens: 5, output_tokens: 10 } }) },
  ];
}

test("cached history preserves complete turns, summary placeholders, and model selection", () => {
  const events = fixture();
  for (const model of ["first", "second"]) {
    for (const details of [true, false, true]) {
      const complete = reconstructSessionTurns(events, model);
      const expected = details ? complete : complete.map(summarizeTurnDetails);
      expect(reconstructCachedSessionTurns(events, model, details)).toEqual(expected);
      expect(reconstructCachedSessionTurns(events, model, details)).toEqual(expected);
    }
  }
});

test("returned history can be enriched without changing later responses", () => {
  const events = fixture();
  const expected = reconstructSessionTurns(events).map(summarizeTurnDetails);
  const first = reconstructCachedSessionTurns(events, "", false);
  const deferred = first[1]!.contentBlocks!.find((block) => block.type === "deferred")!;
  if (deferred.type === "deferred") deferred.hasThinking = false;
  first[1]!.text = "changed";
  const second = reconstructCachedSessionTurns(events, "", false);
  expect(second).toEqual(expected);
  second[1]!.contentBlocks!.length = 0;
  expect(reconstructCachedSessionTurns(events, "", false)).toEqual(expected);
});

test("row contents, timestamps, pruning, and reused sequence numbers invalidate history", () => {
  const events = fixture();
  reconstructCachedSessionTurns(events, "", false);
  events[0]!.data = JSON.stringify({ message: { content: "edited" } });
  expect(reconstructCachedSessionTurns(events, "", false)).toEqual(reconstructSessionTurns(events).map(summarizeTurnDetails));
  events[1]!.created_at = 20;
  events[1]!.seq = 1;
  expect(reconstructCachedSessionTurns(events, "", false)).toEqual(reconstructSessionTurns(events).map(summarizeTurnDetails));
  events.shift();
  expect(reconstructCachedSessionTurns(events, "", false)).toEqual(reconstructSessionTurns(events).map(summarizeTurnDetails));
});
