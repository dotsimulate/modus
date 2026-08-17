/**
 * The turn index has one job that matters: every entry it emits must address a
 * turn the history layer can actually produce. It mirrors
 * `getSessionMessageHistory`'s source selection for exactly that reason, so
 * these tests exercise both sources and the fallback between them.
 *
 * The rest is weight hints for drawing marks. They are asserted for shape and
 * relative ordering, never as content.
 */

import { expect, test } from "bun:test";
import {
  addEvent,
  db,
  getSessionMessage,
  getSessionMessageHistory,
  getSessionTurnIndex,
  insertMessage,
  upsertSession,
} from "../db";

function newSession(label: string): string {
  const id = `turn-index-${label}-${crypto.randomUUID()}`;
  upsertSession({ id, preview: label, messageCount: 0, costUsd: 0 });
  return id;
}

function seedEventTurn(sessionId: string, baseSeq: number, label: string) {
  addEvent(sessionId, baseSeq, "user", "prompt", JSON.stringify({
    subtype: "prompt",
    message: { content: [{ type: "text", text: `${label} prompt` }] },
  }));
  addEvent(sessionId, baseSeq + 1, "assistant", "message", JSON.stringify({
    message: { content: [{ type: "text", text: `${label} answer` }] },
  }));
  addEvent(sessionId, baseSeq + 2, "result", "success", JSON.stringify({ subtype: "success" }));
}

test("indexes turns from the messages table with prose weight and tool counts", () => {
  const sessionId = newSession("messages");
  insertMessage({ sessionId, seq: 1, role: "user", content: "do the thing" });
  insertMessage({
    sessionId,
    seq: 2,
    role: "assistant",
    content: "done",
    toolCalls: [
      { name: "Read", input: {} },
      { name: "Read", input: {} },
      { name: "Edit", input: {} },
    ],
  });
  insertMessage({ sessionId, seq: 3, role: "user", content: "again" });
  insertMessage({ sessionId, seq: 4, role: "assistant", content: "ok then" });

  const index = getSessionTurnIndex(sessionId);
  expect(index.source).toBe("messages");
  expect(index.olderTurnCount).toBe(0);
  expect(index.turns).toHaveLength(2);

  expect(index.turns[0]!.number).toBe(1);
  expect(index.turns[0]!.seq).toBe(1);
  expect(index.turns[0]!.promptWeight).toBe("do the thing".length);
  expect(index.turns[0]!.textWeight).toBe("done".length);
  expect(index.turns[0]!.toolCount).toBe(3);

  expect(index.turns[1]!.number).toBe(2);
  expect(index.turns[1]!.seq).toBe(3);
  expect(index.turns[1]!.toolCount).toBe(0);
});

test("a turn's tool count sums every assistant message inside it", () => {
  const sessionId = newSession("multi-assistant");
  insertMessage({ sessionId, seq: 1, role: "user", content: "go" });
  insertMessage({ sessionId, seq: 2, role: "assistant", content: "a", toolCalls: [{ name: "Read", input: {} }] });
  insertMessage({ sessionId, seq: 3, role: "system", content: "interrupted" });
  insertMessage({ sessionId, seq: 4, role: "assistant", content: "b", toolCalls: [{ name: "Bash", input: {} }] });

  const index = getSessionTurnIndex(sessionId);
  expect(index.turns).toHaveLength(1);
  expect(index.turns[0]!.toolCount).toBe(2);
  expect(index.turns[0]!.textWeight).toBe(2);
});

test("malformed tool json degrades to a zero count rather than failing the session", () => {
  const sessionId = newSession("bad-json");
  insertMessage({ sessionId, seq: 1, role: "user", content: "go" });
  insertMessage({ sessionId, seq: 2, role: "assistant", content: "hm" });
  // tool_calls_json is written by several provider adapters. One bad value must
  // not take out the index for the whole session, so the count is guarded by
  // json_valid rather than trusting the column.
  db.run(
    `UPDATE messages SET tool_calls_json = 'not json at all' WHERE session_id = ? AND seq = 2`,
    [sessionId],
  );

  const index = getSessionTurnIndex(sessionId);
  expect(index.turns).toHaveLength(1);
  expect(index.turns[0]!.toolCount).toBe(0);
});

test("indexes turns from durable events when nothing is materialized", () => {
  const sessionId = newSession("events");
  seedEventTurn(sessionId, 1, "one");
  seedEventTurn(sessionId, 4, "two");
  seedEventTurn(sessionId, 7, "three");

  const index = getSessionTurnIndex(sessionId);
  expect(index.source).toBe("events");
  expect(index.turns).toHaveLength(3);
  expect(index.turns.map((turn) => turn.number)).toEqual([1, 2, 3]);
  expect(index.turns.map((turn) => turn.seq)).toEqual([1, 4, 7]);
  // Boundaries only — counting tools here would mean parsing every payload.
  expect(index.turns[0]!.toolCount).toBeUndefined();
  expect(index.turns[0]!.promptWeight).toBeGreaterThan(0);
});

test("every indexed seq resolves to a real turn", () => {
  const sessionId = newSession("resolvable");
  seedEventTurn(sessionId, 1, "alpha");
  seedEventTurn(sessionId, 4, "beta");

  const index = getSessionTurnIndex(sessionId);
  expect(index.turns.length).toBeGreaterThan(0);
  for (const entry of index.turns) {
    expect(getSessionMessage(sessionId, entry.seq)).not.toBeNull();
  }
});

test("a session with no turns indexes empty rather than failing", () => {
  const index = getSessionTurnIndex(newSession("empty"));
  expect(index.turns).toEqual([]);
  expect(index.olderTurnCount).toBe(0);
});

test("assistant output with no prompt above it is still addressable", () => {
  const sessionId = newSession("headless");
  insertMessage({ sessionId, seq: 5, role: "assistant", content: "resumed mid-conversation" });
  insertMessage({ sessionId, seq: 6, role: "user", content: "next" });
  insertMessage({ sessionId, seq: 7, role: "assistant", content: "reply" });

  const index = getSessionTurnIndex(sessionId);
  expect(index.turns).toHaveLength(2);
  expect(index.turns[0]!.seq).toBe(5);
  expect(index.turns[0]!.promptWeight).toBe(0);
  expect(index.turns[1]!.seq).toBe(6);
});

test("the window is capped from the newest end and keeps real turn numbers", () => {
  const sessionId = newSession("capped");
  for (let i = 0; i < 10; i++) {
    insertMessage({ sessionId, seq: i * 2 + 1, role: "user", content: `q${i}` });
    insertMessage({ sessionId, seq: i * 2 + 2, role: "assistant", content: `a${i}` });
  }

  const index = getSessionTurnIndex(sessionId, { limit: 3 });
  expect(index.turns).toHaveLength(3);
  expect(index.olderTurnCount).toBe(7);
  // Numbering describes position in the conversation, not position in the page.
  expect(index.turns.map((turn) => turn.number)).toEqual([8, 9, 10]);
});

test("the index counts the same turns the history layer returns", () => {
  const sessionId = newSession("agreement");
  seedEventTurn(sessionId, 1, "one");
  seedEventTurn(sessionId, 4, "two");
  seedEventTurn(sessionId, 7, "three");

  const index = getSessionTurnIndex(sessionId);
  const history = getSessionMessageHistory(sessionId, { preserveEventSequence: true });
  const promptCount = history.messages.filter((turn) => turn.role === "user").length;
  expect(index.turns).toHaveLength(promptCount);
});
