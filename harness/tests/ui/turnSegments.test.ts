/**
 * The turn model is shared, so it has to be pinned in one place.
 *
 * `segmentContentBlocks` and `buildTurns` were private copies inside
 * `MessageBubble` and `ChatView` respectively, which is how the transcript and
 * the spine came to disagree about where a turn started. Now both read this
 * module, and any surface that renders a conversation reads it too — so these
 * tests are the contract for all of them.
 */

import { describe, expect, test } from "bun:test";
import {
  buildTurns,
  findTurnBySeq,
  segmentContentBlocks,
  segmentMessage,
  tallyToolNames,
  turnProseWeight,
  turnToolCalls,
} from "../../ui/src/turn-segments";
import type { Message, MessageContentBlock, ToolCall } from "../../sdk/index";

function tool(name: string, id = name): ToolCall {
  return { id, name, input: {}, status: "completed" };
}

function msg(partial: Partial<Message> & Pick<Message, "role">): Message {
  return { id: partial.id ?? `m-${partial.seq ?? 0}`, content: "", ...partial } as Message;
}

describe("segmentContentBlocks", () => {
  test("folds consecutive tool calls into one run", () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "looking" },
      { type: "tool_call", toolCall: tool("Read", "a") },
      { type: "tool_call", toolCall: tool("Read", "b") },
      { type: "tool_call", toolCall: tool("Grep", "c") },
      { type: "text", text: "found it" },
    ];
    const segments = segmentContentBlocks("m1", blocks);
    expect(segments.map((s) => s.kind)).toEqual(["text", "tools", "text"]);
    const run = segments[1];
    expect(run.kind === "tools" && run.tools.length).toBe(3);
  });

  test("keeps runs separated by prose apart, in provider order", () => {
    const blocks: MessageContentBlock[] = [
      { type: "tool_call", toolCall: tool("Read", "a") },
      { type: "text", text: "one" },
      { type: "tool_call", toolCall: tool("Edit", "b") },
      { type: "text", text: "two" },
      { type: "tool_call", toolCall: tool("Bash", "c") },
    ];
    const segments = segmentContentBlocks("m1", blocks);
    expect(segments.map((s) => s.kind)).toEqual(["tools", "text", "tools", "text", "tools"]);
  });

  test("drops empty text blocks but keeps thinking", () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "" },
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "ok" },
    ];
    expect(segmentContentBlocks("m1", blocks).map((s) => s.kind)).toEqual(["thinking", "text"]);
  });

  test("a trailing run is flushed", () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "go" },
      { type: "tool_call", toolCall: tool("Read", "a") },
    ];
    const segments = segmentContentBlocks("m1", blocks);
    expect(segments[segments.length - 1]!.kind).toBe("tools");
  });

  test("deferred blocks carry their tally through", () => {
    const blocks: MessageContentBlock[] = [
      { type: "deferred", hasThinking: true, toolCallCount: 40, toolNames: { Read: 26, Edit: 14 } },
    ];
    const segments = segmentContentBlocks("m1", blocks);
    const deferred = segments[0]!;
    expect(deferred.kind === "deferred" && deferred.count).toBe(40);
    expect(deferred.kind === "deferred" && deferred.toolNames.Read).toBe(26);
  });

  test("segment keys are unique within a message", () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "a" },
      { type: "tool_call", toolCall: tool("Read", "a") },
      { type: "text", text: "b" },
      { type: "tool_call", toolCall: tool("Read", "b") },
    ];
    const keys = segmentContentBlocks("m1", blocks).map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("segmentMessage", () => {
  test("prefers ordered content blocks when present", () => {
    const message = msg({
      role: "assistant",
      content: "ignored",
      contentBlocks: [
        { type: "tool_call", toolCall: tool("Read") },
        { type: "text", text: "after" },
      ],
    });
    expect(segmentMessage(message).map((s) => s.kind)).toEqual(["tools", "text"]);
  });

  test("falls back to flat fields in transcript order", () => {
    const message = msg({
      role: "assistant",
      content: "prose",
      thinking: "reasoning",
      toolCalls: [tool("Read")],
    });
    expect(segmentMessage(message).map((s) => s.kind)).toEqual(["thinking", "text", "tools"]);
  });

  test("a flat deferred message still produces a deferred segment", () => {
    const message = msg({
      role: "assistant",
      detailsDeferred: true,
      deferredHasThinking: true,
      deferredToolCallCount: 12,
    });
    const segments = segmentMessage(message);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind === "deferred" && segments[0]!.count).toBe(12);
  });
});

describe("tallyToolNames", () => {
  test("counts by name", () => {
    expect(tallyToolNames([tool("Read", "a"), tool("Read", "b"), tool("Edit", "c")]))
      .toEqual({ Read: 2, Edit: 1 });
  });
});

describe("buildTurns", () => {
  test("groups assistant output under the prompt that asked for it", () => {
    const turns = buildTurns([
      msg({ role: "user", id: "u1", seq: 1, content: "first" }),
      msg({ role: "assistant", id: "a1", seq: 2, content: "reply" }),
      msg({ role: "user", id: "u2", seq: 3, content: "second" }),
      msg({ role: "assistant", id: "a2", seq: 4, content: "reply" }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.prompt?.id).toBe("u1");
    expect(turns[0]!.body.map((m) => m.id)).toEqual(["a1"]);
    expect(turns[1]!.prompt?.id).toBe("u2");
  });

  test("system dividers stay inside the turn they interrupted", () => {
    const turns = buildTurns([
      msg({ role: "user", id: "u1", seq: 1 }),
      msg({ role: "assistant", id: "a1", seq: 2 }),
      msg({ role: "system", id: "s1", seq: 3, content: "interrupted" }),
      msg({ role: "assistant", id: "a2", seq: 4 }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.body.map((m) => m.id)).toEqual(["a1", "s1", "a2"]);
  });

  test("numbering continues the conversation, not the loaded window", () => {
    const turns = buildTurns([
      msg({ role: "user", id: "u1", seq: 90 }),
      msg({ role: "assistant", id: "a1", seq: 91 }),
      msg({ role: "user", id: "u2", seq: 92 }),
    ], 40);
    expect(turns.map((t) => t.number)).toEqual([41, 42]);
  });

  test("leading assistant content with no prompt is still an addressable turn", () => {
    const turns = buildTurns([
      msg({ role: "assistant", id: "a0", seq: 5 }),
      msg({ role: "user", id: "u1", seq: 6 }),
      msg({ role: "assistant", id: "a1", seq: 7 }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.prompt).toBeNull();
    expect(turns[0]!.seq).toBe(5);
    expect(turns[0]!.number).toBe(1);
    expect(turns[1]!.number).toBe(2);
  });

  test("a turn takes its seq from the prompt when it has one", () => {
    const turns = buildTurns([
      msg({ role: "user", id: "u1", seq: 10 }),
      msg({ role: "assistant", id: "a1", seq: 11 }),
    ]);
    expect(turns[0]!.seq).toBe(10);
  });

  test("a prompt with no seq inherits the first body seq so it stays selectable", () => {
    const turns = buildTurns([
      msg({ role: "user", id: "u1" }),
      msg({ role: "assistant", id: "a1", seq: 11 }),
    ]);
    expect(turns[0]!.seq).toBe(11);
  });

  test("an empty list has no turns", () => {
    expect(buildTurns([])).toEqual([]);
  });

  test("keys are stable and unique", () => {
    const messages = [
      msg({ role: "user", id: "u1", seq: 1 }),
      msg({ role: "assistant", id: "a1", seq: 2 }),
      msg({ role: "user", id: "u2", seq: 3 }),
    ];
    const first = buildTurns(messages).map((t) => t.key);
    const second = buildTurns(messages).map((t) => t.key);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });
});

describe("findTurnBySeq", () => {
  const turns = buildTurns([
    msg({ role: "user", id: "u1", seq: 1 }),
    msg({ role: "assistant", id: "a1", seq: 2 }),
    msg({ role: "user", id: "u2", seq: 3 }),
    msg({ role: "assistant", id: "a2", seq: 4 }),
  ]);

  test("finds by the prompt seq", () => {
    expect(findTurnBySeq(turns, 3)?.number).toBe(2);
  });

  test("finds by a body seq, so an assistant-addressed seq still resolves", () => {
    expect(findTurnBySeq(turns, 4)?.number).toBe(2);
  });

  test("returns null for a seq that is not loaded", () => {
    expect(findTurnBySeq(turns, 99)).toBeNull();
  });
});

describe("turn measurements", () => {
  test("turnToolCalls flattens every run in order", () => {
    const turns = buildTurns([
      msg({ role: "user", id: "u1", seq: 1 }),
      msg({
        role: "assistant",
        id: "a1",
        seq: 2,
        contentBlocks: [
          { type: "tool_call", toolCall: tool("Read", "a") },
          { type: "text", text: "mid" },
          { type: "tool_call", toolCall: tool("Edit", "b") },
        ],
      }),
    ]);
    expect(turnToolCalls(turns[0]!).map((t) => t.name)).toEqual(["Read", "Edit"]);
  });

  test("prose weight counts text and ignores tool payloads", () => {
    const turns = buildTurns([
      msg({ role: "user", id: "u1", seq: 1 }),
      msg({
        role: "assistant",
        id: "a1",
        seq: 2,
        contentBlocks: [
          { type: "text", text: "12345" },
          {
            type: "tool_call",
            toolCall: { id: "a", name: "Read", input: {}, status: "completed", result: "x".repeat(9999) },
          },
          { type: "text", text: "678" },
        ],
      }),
    ]);
    expect(turnProseWeight(turns[0]!)).toBe(8);
  });

  test("the prompt is not counted as the agent's prose", () => {
    const turns = buildTurns([
      msg({ role: "user", id: "u1", seq: 1, content: "a very long question indeed" }),
      msg({ role: "assistant", id: "a1", seq: 2, content: "ok" }),
    ]);
    expect(turnProseWeight(turns[0]!)).toBe(2);
  });
});
