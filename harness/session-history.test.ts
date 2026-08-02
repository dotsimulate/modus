import { describe, expect, test } from "bun:test";
import { reconstructSessionTurns, shouldRecoverSessionHistory, summarizeContentBlocks } from "./session-history";

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
    expect(turns[1]!.toolCalls).toEqual([{
      name: "CommandExecution",
      input: { command: "test" },
      result: "passed",
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
  });
});
