import { expect, test } from "bun:test";
import { addEvent, getSessionMessageHistory, insertMessage, upsertSession } from "../db";

function seedSimpleTurn(sessionId: string, baseSeq: number, label: string, createdAt?: number) {
  addEvent(sessionId, baseSeq, "user", "prompt", JSON.stringify({
    subtype: "prompt",
    message: { content: [{ type: "text", text: `${label} prompt` }] },
  }), createdAt);
  addEvent(sessionId, baseSeq + 1, "assistant", "message", JSON.stringify({
    message: { content: [{ type: "text", text: `${label} answer` }] },
  }), createdAt);
  addEvent(sessionId, baseSeq + 2, "result", "success", JSON.stringify({ subtype: "success" }), createdAt);
}

test("history pages through a provider sequence reset by wall-clock cursor", async () => {
  const sessionId = `history-page-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "pagination", messageCount: 0, costUsd: 0 });

  seedSimpleTurn(sessionId, 1, "old one");
  await Bun.sleep(2);
  seedSimpleTurn(sessionId, 4, "old two");
  await Bun.sleep(2);
  // Simulate a resumed provider that restarted its durable seq at one.
  seedSimpleTurn(sessionId, 1, "new one");
  await Bun.sleep(2);
  seedSimpleTurn(sessionId, 4, "new two");

  const recent = getSessionMessageHistory(sessionId, {
    limit: 4,
    preserveEventSequence: true,
  });
  expect(recent.messages.map((turn) => turn.text)).toEqual([
    "new one prompt",
    "new one answer",
    "new two prompt",
    "new two answer",
  ]);
  expect(recent.hasMore).toBe(true);
  expect(recent.oldestCreatedAt).not.toBeNull();

  const older = getSessionMessageHistory(sessionId, {
    limit: 4,
    beforeSeq: recent.oldestSeq ?? undefined,
    beforeCreatedAt: recent.oldestCreatedAt ?? undefined,
    preserveEventSequence: true,
  });
  expect(older.messages.map((turn) => turn.text)).toEqual([
    "old one prompt",
    "old one answer",
    "old two prompt",
    "old two answer",
  ]);
  expect(older.hasMore).toBe(false);
});

test("event history reports how many turns precede each page", async () => {
  const sessionId = `history-offset-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "offsets", messageCount: 0, costUsd: 0 });

  for (let turn = 1; turn <= 4; turn++) {
    seedSimpleTurn(sessionId, turn * 3, `turn ${turn}`);
    await Bun.sleep(2);
  }

  // Two turns per page: the newest page starts after two older prompts, and the
  // page before it starts at the beginning of the conversation.
  const recent = getSessionMessageHistory(sessionId, { limit: 4, preserveEventSequence: true });
  expect(recent.messages.map((turn) => turn.text)).toEqual([
    "turn 3 prompt",
    "turn 3 answer",
    "turn 4 prompt",
    "turn 4 answer",
  ]);
  expect(recent.olderTurnCount).toBe(2);

  const older = getSessionMessageHistory(sessionId, {
    limit: 4,
    beforeCreatedAt: recent.oldestCreatedAt ?? undefined,
    preserveEventSequence: true,
  });
  expect(older.messages.map((turn) => turn.text)).toEqual([
    "turn 1 prompt",
    "turn 1 answer",
    "turn 2 prompt",
    "turn 2 answer",
  ]);
  expect(older.olderTurnCount).toBe(0);
  expect(older.hasMore).toBe(false);
});

test("materialized history pages through a provider sequence reset by wall-clock cursor", () => {
  const sessionId = `history-page-rows-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "materialized pagination", messageCount: 0, costUsd: 0 });

  const base = Date.now() - 10_000;
  const seedTurn = (seq: number, label: string, createdAt: number) => {
    insertMessage({ sessionId, seq, role: "user", content: `${label} prompt`, createdAt });
    insertMessage({ sessionId, seq: seq + 1, role: "assistant", content: `${label} answer`, createdAt: createdAt + 1 });
  };
  seedTurn(1, "old one", base + 10);
  seedTurn(3, "old two", base + 20);
  // Simulate materialization after a resumed provider restarted its durable seq.
  seedTurn(1, "new one", base + 30);
  seedTurn(3, "new two", base + 40);

  const recent = getSessionMessageHistory(sessionId, { limit: 4 });
  expect(recent.messages.map((turn) => turn.text)).toEqual([
    "new one prompt",
    "new one answer",
    "new two prompt",
    "new two answer",
  ]);
  expect(recent.hasMore).toBe(true);

  const older = getSessionMessageHistory(sessionId, {
    limit: 4,
    // New clients send both. The wall-clock cursor must win when seq is reused.
    beforeSeq: recent.oldestSeq ?? undefined,
    beforeCreatedAt: recent.oldestCreatedAt ?? undefined,
  });
  expect(older.messages.map((turn) => turn.text)).toEqual([
    "old one prompt",
    "old one answer",
    "old two prompt",
    "old two answer",
  ]);
  expect(older.hasMore).toBe(false);
});

test("materialized history reports how many turns precede each page", () => {
  const sessionId = `history-offset-rows-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "offsets", messageCount: 0, costUsd: 0 });

  // Semantic rows only, so this exercises the messages table rather than the
  // event-reconstruction path.
  const base = Date.now() - 10_000;
  for (let turn = 1; turn <= 4; turn++) {
    insertMessage({ sessionId, seq: turn * 2 - 1, role: "user", content: `turn ${turn} prompt`, createdAt: base + turn * 10 });
    insertMessage({ sessionId, seq: turn * 2, role: "assistant", content: `turn ${turn} answer`, createdAt: base + turn * 10 + 1 });
  }

  const recent = getSessionMessageHistory(sessionId, { limit: 4 });
  expect(recent.messages.map((turn) => turn.text)).toEqual([
    "turn 3 prompt",
    "turn 3 answer",
    "turn 4 prompt",
    "turn 4 answer",
  ]);
  expect(recent.hasMore).toBe(true);
  expect(recent.olderTurnCount).toBe(2);

  const older = getSessionMessageHistory(sessionId, {
    limit: 4,
    beforeSeq: recent.oldestSeq ?? undefined,
  });
  expect(older.messages.map((turn) => turn.text)).toEqual([
    "turn 1 prompt",
    "turn 1 answer",
    "turn 2 prompt",
    "turn 2 answer",
  ]);
  expect(older.hasMore).toBe(false);
  expect(older.olderTurnCount).toBe(0);
});

test("event history does not skip turns persisted in the same millisecond", () => {
  const sessionId = `history-same-ms-events-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "event cursor", messageCount: 0, costUsd: 0 });
  const createdAt = Date.now() - 10_000;
  for (let turn = 1; turn <= 4; turn++) {
    seedSimpleTurn(sessionId, turn * 3, `turn ${turn}`, createdAt);
  }

  const recent = getSessionMessageHistory(sessionId, { limit: 4, preserveEventSequence: true });
  expect(recent.messages.map((turn) => turn.text)).toEqual([
    "turn 3 prompt",
    "turn 3 answer",
    "turn 4 prompt",
    "turn 4 answer",
  ]);
  expect(recent.oldestId).not.toBeNull();

  const older = getSessionMessageHistory(sessionId, {
    limit: 4,
    beforeCreatedAt: recent.oldestCreatedAt ?? undefined,
    beforeId: recent.oldestId ?? undefined,
    preserveEventSequence: true,
  });
  expect(older.messages.map((turn) => turn.text)).toEqual([
    "turn 1 prompt",
    "turn 1 answer",
    "turn 2 prompt",
    "turn 2 answer",
  ]);
  expect(older.hasMore).toBe(false);
});

test("materialized history does not skip messages persisted in the same millisecond", () => {
  const sessionId = `history-same-ms-rows-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "message cursor", messageCount: 0, costUsd: 0 });
  const createdAt = Date.now() - 10_000;
  for (let turn = 1; turn <= 4; turn++) {
    insertMessage({ sessionId, seq: turn * 2 - 1, role: "user", content: `turn ${turn} prompt`, createdAt });
    insertMessage({ sessionId, seq: turn * 2, role: "assistant", content: `turn ${turn} answer`, createdAt });
  }

  const recent = getSessionMessageHistory(sessionId, { limit: 4 });
  expect(recent.oldestId).not.toBeNull();
  const older = getSessionMessageHistory(sessionId, {
    limit: 4,
    beforeCreatedAt: recent.oldestCreatedAt ?? undefined,
    beforeId: recent.oldestId ?? undefined,
  });
  expect([...recent.messages, ...older.messages].map((turn) => turn.text).sort()).toEqual([
    "turn 1 answer",
    "turn 1 prompt",
    "turn 2 answer",
    "turn 2 prompt",
    "turn 3 answer",
    "turn 3 prompt",
    "turn 4 answer",
    "turn 4 prompt",
  ]);
  expect(older.hasMore).toBe(false);
});
