/**
 * Deferral must track weight, not presence.
 *
 * The rule used to be `!!turn.thinking || toolCalls.length > 0`, which put a
 * 455-byte turn and a 4MB turn in the same bucket — so effectively every
 * assistant message in a loaded session became a "load N tool calls" button and
 * the affordance carried no information about anything. These pin the threshold
 * and the shape of what a deferred turn still tells the client.
 */

import { expect, test } from "bun:test";
import { addEvent, getSessionMessageHistory, upsertSession } from "./db";
import { estimateTurnDetailBytes, summarizeContentBlocks } from "./session-history";

/** One assistant turn with `tools` calls whose results are `resultBytes` each. */
function seedTurn(sessionId: string, base: number, tools: number, resultBytes: number, thinking = false) {
  addEvent(sessionId, base, "user", "prompt", JSON.stringify({
    subtype: "prompt", message: { content: [{ type: "text", text: "go" }] },
  }));
  addEvent(sessionId, base + 1, "assistant", "message", JSON.stringify({
    message: {
      content: [
        ...(thinking ? [{ type: "thinking", thinking: "brief" }] : []),
        { type: "text", text: "working" },
        ...Array.from({ length: tools }, (_, i) => ({
          type: "tool_use", id: `${base}-t${i}`, name: i % 2 ? "Edit" : "Read", input: { file_path: `/x/${i}.ts` },
        })),
      ],
    },
  }));
  if (tools > 0) {
    addEvent(sessionId, base + 2, "user", "tool_result", JSON.stringify({
      message: {
        content: Array.from({ length: tools }, (_, i) => ({
          type: "tool_result", tool_use_id: `${base}-t${i}`, content: "x".repeat(resultBytes),
        })),
      },
    }));
  }
  addEvent(sessionId, base + 3, "result", "success", JSON.stringify({
    subtype: "success", harness_duration_ms: 100,
  }));
}

test("a small tool-using turn ships whole instead of becoming a button", () => {
  const sessionId = `defer-small-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "small", messageCount: 0, costUsd: 0 });
  seedTurn(sessionId, 1, 3, 200, true);

  const assistant = getSessionMessageHistory(sessionId, { includeDetails: false, preserveEventSequence: true })
    .messages.find((turn) => turn.role === "assistant");
  expect(assistant?.detailsDeferred).toBeUndefined();
  expect(assistant?.toolCalls).toHaveLength(3);
  expect(assistant?.thinking).toBe("brief");
});

test("a genuinely heavy turn still defers, and says what it is holding back", () => {
  const sessionId = `defer-heavy-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "heavy", messageCount: 0, costUsd: 0 });
  seedTurn(sessionId, 1, 8, 20_000, true);

  const assistant = getSessionMessageHistory(sessionId, { includeDetails: false, preserveEventSequence: true })
    .messages.find((turn) => turn.role === "assistant");
  expect(assistant?.detailsDeferred).toBe(true);
  expect(assistant?.toolCalls).toBeUndefined();
  expect(assistant?.thinking).toBeUndefined();
  expect(assistant?.deferredToolCallCount).toBe(8);
  // Reported rather than inferred from "has no tool calls".
  expect(assistant?.deferredHasThinking).toBe(true);
});

test("a deferred run carries the same tally a loaded run would show", () => {
  const summary = summarizeContentBlocks([
    { type: "thinking", thinking: "reason" },
    { type: "tool_call", toolCall: { id: "a", name: "Read", input: {} } },
    { type: "tool_call", toolCall: { id: "b", name: "Read", input: {} } },
    { type: "tool_call", toolCall: { id: "c", name: "Edit", input: {} } },
  ]);
  expect(summary).toEqual([
    { type: "deferred", hasThinking: true, toolCallCount: 3, toolNames: { Read: 2, Edit: 1 } },
  ]);
});

test("requesting full details never defers, whatever the weight", () => {
  const sessionId = `defer-full-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "full", messageCount: 0, costUsd: 0 });
  seedTurn(sessionId, 1, 8, 20_000, true);

  const assistant = getSessionMessageHistory(sessionId, { preserveEventSequence: true })
    .messages.find((turn) => turn.role === "assistant");
  expect(assistant?.detailsDeferred).toBeUndefined();
  expect(assistant?.toolCalls).toHaveLength(8);
});

test("the size estimate tracks tool output rather than call count", () => {
  const light = estimateTurnDetailBytes({
    role: "assistant", seq: 1, text: "", timestamp: 0,
    toolCalls: Array.from({ length: 40 }, () => ({ name: "Read", input: {}, result: "ok" })),
  });
  const heavy = estimateTurnDetailBytes({
    role: "assistant", seq: 1, text: "", timestamp: 0,
    toolCalls: [{ name: "Read", input: {}, result: "x".repeat(100_000) }],
  });
  expect(light).toBeLessThan(heavy);
});
