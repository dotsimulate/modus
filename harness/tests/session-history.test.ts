import { describe, expect, test } from "bun:test";
import {
  QUEUED_PROMPT_SUBTYPE,
  reconstructSessionTurns,
  shouldRecoverSessionHistory,
  summarizeContentBlocks,
} from "../session-history";

function event(seq: number, type: string, subtype: string | null, data: unknown) {
  return { seq, type, subtype, data: JSON.stringify(data), created_at: 1_000 + seq };
}

describe("incomplete semantic history recovery", () => {
  test("keeps semantic history when its assistant result is newer than raw assistant events", () => {
    expect(shouldRecoverSessionHistory([
      { role: "user", seq: 1, text: "go", timestamp: 1 },
      { role: "assistant", seq: 10, text: "done", timestamp: 2 },
    ], 9)).toBe(false);
  });

  test("detects a raw assistant turn stranded after the last semantic assistant", () => {
    expect(shouldRecoverSessionHistory([
      { role: "user", seq: 1, text: "go", timestamp: 1 },
    ], 88)).toBe(true);
  });

  test("reconstructs text and completed tools without a terminal result event", () => {
    const turns = reconstructSessionTurns([
      event(1, "user", "prompt", { subtype: "prompt", message: { content: "do the work" } }),
      event(2, "assistant", null, { message: { content: [{ type: "text", text: "working" }] } }),
      event(3, "assistant", null, { message: { content: [{ type: "tool_use", id: "tool-1", name: "CommandExecution", input: { command: "test" } }] } }),
      event(4, "user", "tool_result", { message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "passed" }] } }),
      event(5, "assistant", null, { message: { content: [{ type: "text", text: "\nfinished" }] } }),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "user", seq: 1, text: "do the work" });
    expect(turns[1]).toMatchObject({ role: "assistant", seq: 2, text: "working\nfinished" });
    expect(turns[1]!.timestamp).toBe(1_005);
    expect(turns[1]!.toolCalls).toEqual([{
      id: "tool-1",
      name: "CommandExecution",
      input: { command: "test" },
      result: "passed",
      status: "completed",
    }]);
    expect(turns[1]!.contentBlocks).toEqual([
      { type: "text", text: "working" },
      {
        type: "tool_call",
        toolCall: {
          id: "tool-1",
          name: "CommandExecution",
          input: { command: "test" },
          result: "passed",
          status: "completed",
        },
      },
      { type: "text", text: "\nfinished" },
    ]);
  });

  test("keeps deferred controls at their provider positions without duplicating text", () => {
    expect(summarizeContentBlocks([
      { type: "thinking", thinking: "reason" },
      { type: "text", text: "before" },
      { type: "tool_call", toolCall: { id: "a", name: "Read", input: {} } },
      { type: "tool_call", toolCall: { id: "b", name: "Edit", input: {} } },
      { type: "text", text: "after" },
    ])).toEqual([
      { type: "deferred", hasThinking: true, toolCallCount: 0, toolNames: {} },
      { type: "text", textStart: 0, textEnd: 6 },
      { type: "deferred", hasThinking: false, toolCallCount: 2, toolNames: { Read: 1, Edit: 1 } },
      { type: "text", textStart: 6, textEnd: 11 },
    ]);
  });

  test("closes an unterminated assistant turn before a later user prompt", () => {
    const turns = reconstructSessionTurns([
      event(1, "user", "prompt", { subtype: "prompt", message: { content: "first" } }),
      event(2, "assistant", null, { message: { content: [{ type: "text", text: "partial" }] } }),
      event(3, "user", "prompt", { subtype: "prompt", message: { content: "second" } }),
      event(4, "assistant", null, { message: { content: [{ type: "text", text: "answer" }] } }),
      event(5, "result", "success", { result: "answer" }),
    ]);

    expect(turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "first"],
      ["assistant", "partial"],
      ["user", "second"],
      ["assistant", "answer"],
    ]);
    expect(turns[1]!.timestamp).toBe(1_002);
    expect(turns[3]!.timestamp).toBe(1_005);
  });

  test("keeps turns intact when seq numbers collide across wall-clock time", () => {
    // Grok-build resume used to restart ActiveSession at seq 0, so later turns
    // reused seq 1, 2, 3…. Ordering by seq alone interleaves those turns.
    const turns = reconstructSessionTurns([
      { seq: 1, type: "user", subtype: "prompt", data: JSON.stringify({ subtype: "prompt", message: { content: "early" } }), created_at: 1000, id: 1 },
      { seq: 2, type: "assistant", subtype: null, data: JSON.stringify({ message: { content: [{ type: "text", text: "early answer" }] } }), created_at: 1001, id: 2 },
      { seq: 3, type: "result", subtype: "success", data: JSON.stringify({ result: "early answer" }), created_at: 1002, id: 3 },
      // Later turn reuses seq 1–3
      { seq: 1, type: "user", subtype: "prompt", data: JSON.stringify({ subtype: "prompt", message: { content: "<!-- move:live-html --> later" } }), created_at: 5000, id: 10 },
      { seq: 2, type: "assistant", subtype: null, data: JSON.stringify({ message: { content: [{ type: "text", text: "opening html" }] } }), created_at: 5001, id: 11 },
      { seq: 2, type: "assistant", subtype: null, data: JSON.stringify({ message: { content: [{ type: "tool_use", id: "t1", name: "modus_submit", input: { token: "mapi-html-1", data: { op: "show" } } }] } }), created_at: 5002, id: 12 },
      { seq: 3, type: "result", subtype: "success", data: JSON.stringify({ result: "opening html" }), created_at: 5003, id: 13 },
      // Deliberately out of seq order in the array (as a seq-only query would return)
      { seq: 1, type: "user", subtype: "prompt", data: JSON.stringify({ subtype: "prompt", message: { content: "middle" } }), created_at: 2000, id: 4 },
      { seq: 2, type: "assistant", subtype: null, data: JSON.stringify({ message: { content: [{ type: "text", text: "middle answer" }] } }), created_at: 2001, id: 5 },
      { seq: 3, type: "result", subtype: "success", data: JSON.stringify({ result: "middle answer" }), created_at: 2002, id: 6 },
    ]);

    expect(turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "early"],
      ["assistant", "early answer"],
      ["user", "middle"],
      ["assistant", "middle answer"],
      ["user", "<!-- move:live-html --> later"],
      ["assistant", "opening html"],
    ]);
    expect(turns[5]!.toolCalls).toEqual([{
      id: "t1",
      name: "modus_submit",
      input: { token: "mapi-html-1", data: { op: "show" } },
    }]);
  });
});

describe("queued prompt rows", () => {
  /**
   * Every send writes twice: once when the harness accepts the message, once
   * when the provider echoes it back on delivery. Only the second is a turn.
   */
  test("renders one user turn per message despite the queue-time row", () => {
    const turns = reconstructSessionTurns([
      event(1, "user", QUEUED_PROMPT_SUBTYPE, { subtype: QUEUED_PROMPT_SUBTYPE, message: { content: "explain jev" } }),
      event(2, "user", "prompt", { subtype: "prompt", message: { content: "explain jev" } }),
      event(3, "assistant", null, { message: { content: [{ type: "text", text: "it decides" }] } }),
    ]);

    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: "user", seq: 2, text: "explain jev" });
  });

  test("keeps a message queued mid-turn out of the turn it was queued during", () => {
    const turns = reconstructSessionTurns([
      event(1, "user", "prompt", { subtype: "prompt", message: { content: "first" } }),
      event(2, "assistant", null, { message: { content: [{ type: "text", text: "thinking" }] } }),
      // Sent while the assistant was still streaming, so it persists here.
      event(3, "user", QUEUED_PROMPT_SUBTYPE, { subtype: QUEUED_PROMPT_SUBTYPE, message: { content: "second" } }),
      event(4, "assistant", null, { message: { content: [{ type: "text", text: " done" }] } }),
      // Delivered only once the turn ended.
      event(5, "user", "prompt", { subtype: "prompt", message: { content: "second" } }),
    ]);

    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[1]).toMatchObject({ text: "thinking done" });
    expect(turns[2]).toMatchObject({ role: "user", seq: 5, text: "second" });
  });

  test("still renders two turns when the same text is genuinely sent twice", () => {
    const turns = reconstructSessionTurns([
      event(1, "user", QUEUED_PROMPT_SUBTYPE, { subtype: QUEUED_PROMPT_SUBTYPE, message: { content: "again" } }),
      event(2, "user", "prompt", { subtype: "prompt", message: { content: "again" } }),
      event(3, "user", QUEUED_PROMPT_SUBTYPE, { subtype: QUEUED_PROMPT_SUBTYPE, message: { content: "again" } }),
      event(4, "user", "prompt", { subtype: "prompt", message: { content: "again" } }),
    ]);

    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(2);
  });
});
