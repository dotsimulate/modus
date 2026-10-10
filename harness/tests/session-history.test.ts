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

  describe("recovers messages whose delivery left no prompt row", () => {
    const prompt = (seq: number, text: string) =>
      event(seq, "user", "prompt", { subtype: "prompt", message: { content: text } });
    const queued = (seq: number, text: string) =>
      event(seq, "user", QUEUED_PROMPT_SUBTYPE, { subtype: QUEUED_PROMPT_SUBTYPE, message: { content: text } });
    const said = (seq: number, text: string) =>
      event(seq, "assistant", null, { message: { content: [{ type: "text", text }] } });
    const result = (seq: number) => event(seq, "result", "success", { subtype: "success" });
    const shape = (turns: ReturnType<typeof reconstructSessionTurns>) =>
      turns.map((turn) => `${turn.role}:${turn.text}`);

    test("a follow-up sent while idle opens the reply that answers it", () => {
      const turns = reconstructSessionTurns([
        prompt(1, "first"),
        said(2, "one"),
        result(3),
        queued(4, "second"),
        said(5, "two"),
        result(6),
      ]);
      expect(shape(turns)).toEqual(["user:first", "assistant:one", "user:second", "assistant:two"]);
      expect(turns[2]).toMatchObject({ seq: 4, timestamp: 1_004 });
    });

    test("a message queued mid-turn lands after that turn, before its own reply", () => {
      expect(shape(reconstructSessionTurns([
        prompt(1, "first"),
        said(2, "working"),
        queued(3, "and also"),
        said(4, " done"),
        result(5),
        said(6, "on it"),
        result(7),
      ]))).toEqual(["user:first", "assistant:working done", "user:and also", "assistant:on it"]);
    });

    test("messages queued together are answered in the order they were sent", () => {
      expect(shape(reconstructSessionTurns([
        prompt(1, "first"),
        said(2, "working"),
        queued(3, "a"),
        queued(4, "b"),
        result(5),
        said(6, "for a"),
        result(7),
        said(8, "for b"),
        result(9),
      ]))).toEqual(["user:first", "assistant:working", "user:a", "assistant:for a", "user:b", "assistant:for b"]);
    });

    test("a queued message that never reached the agent stays out", () => {
      expect(shape(reconstructSessionTurns([
        prompt(1, "first"),
        said(2, "working"),
        // Cancelled, or discarded by a stop, before the turn ended.
        queued(3, "never sent"),
        result(4),
        queued(5, "next"),
        said(6, "for next"),
        result(7),
      ]))).toEqual(["user:first", "assistant:working", "user:next", "assistant:for next"]);

      expect(shape(reconstructSessionTurns([
        prompt(1, "first"),
        said(2, "working"),
        queued(3, "never sent"),
        result(4),
        prompt(5, "recorded"),
        said(6, "for recorded"),
        result(7),
        said(8, "on its own"),
        result(9),
      ]))).toEqual(["user:first", "assistant:working", "user:recorded", "assistant:for recorded", "assistant:on its own"]);
    });

    test("a message steered into the turn does not retire one still queued", () => {
      expect(shape(reconstructSessionTurns([
        prompt(1, "first"),
        said(2, "working"),
        queued(3, "after this"),
        prompt(4, "steer"),
        said(5, "steered"),
        result(6),
        said(7, "for after this"),
        result(8),
      ]))).toEqual([
        "user:first", "assistant:working", "user:steer", "assistant:steered",
        "user:after this", "assistant:for after this",
      ]);
    });

    test("a prompt with no text still opens its own reply", () => {
      const turns = reconstructSessionTurns([
        prompt(1, "first"),
        said(2, "one"),
        result(3),
        queued(4, "pending"),
        event(5, "user", "prompt", { subtype: "prompt", message: { content: [{ type: "image" }] } }),
        said(6, "nice picture"),
        result(7),
      ]);
      expect(shape(turns)).toEqual(["user:first", "assistant:one", "assistant:nice picture"]);
    });
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
