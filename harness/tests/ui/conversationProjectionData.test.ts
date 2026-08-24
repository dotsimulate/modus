import { describe, expect, test } from "bun:test";
import type { Message, SessionTurnIndex } from "../../sdk/types";
import {
  buildConversationProjectionTurns,
  conversationProjectionIsPartial,
} from "../../ui/src/conversation-projection-data";

const index: SessionTurnIndex = {
  source: "messages",
  olderTurnCount: 0,
  turns: [
    { number: 1, seq: 10, timestamp: 100, promptWeight: 20, textWeight: 40, toolCount: 2 },
    { number: 2, seq: 20, timestamp: 200, promptWeight: 30, textWeight: 50, toolCount: 4 },
  ],
};

describe("conversation projection turn data", () => {
  test("keeps indexed turns honest and overwrites loaded detail without inventing labels", () => {
    const messages: Message[] = [
      { id: "u2", role: "user", content: "Real loaded prompt", seq: 20, timestamp: 200 },
      {
        id: "a2",
        role: "assistant",
        content: "",
        seq: 21,
        timestamp: 210,
        contentBlocks: [{ type: "deferred", hasThinking: true, toolCallCount: 4, toolNames: { Read: 4 } }],
      },
    ];
    const turns = buildConversationProjectionTurns(index, messages, 1);
    expect(turns.map((turn) => turn.number)).toEqual([1, 2]);
    expect(turns[0]).toMatchObject({ loaded: false, deferred: false });
    expect(turns[0]?.promptPreview).toBeUndefined();
    expect(turns[1]).toMatchObject({ loaded: true, deferred: true, promptPreview: "Real loaded prompt" });
  });

  test("live loaded turns extend a stale index immediately", () => {
    const messages: Message[] = [
      { id: "u3", role: "user", content: "Newest", seq: 30, timestamp: 300 },
      { id: "a3", role: "assistant", content: "Streaming", seq: 31, timestamp: 310 },
    ];
    const turns = buildConversationProjectionTurns(index, messages, 2);
    expect(turns.map((turn) => turn.number)).toEqual([1, 2, 3]);
    expect(turns[2]).toMatchObject({ loaded: true, deferred: false, promptPreview: "Newest" });
  });

  test("reports truncated or failed turn indexes as partial", () => {
    expect(conversationProjectionIsPartial(index, null)).toBe(false);
    expect(conversationProjectionIsPartial({ ...index, olderTurnCount: 3 }, null)).toBe(true);
    expect(conversationProjectionIsPartial(index, "index unavailable")).toBe(true);
  });
});
