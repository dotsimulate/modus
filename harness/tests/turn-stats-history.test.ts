import { expect, test } from "bun:test";
import { addEvent, getSessionMessageHistory, insertMessage, upsertSession } from "../db";
import { hasTurnStats, turnMetaFromResultEvent } from "../turn-meta";

/** A Claude-family result: usage lives under modelUsage. */
const claudeResult = {
  subtype: "success",
  total_cost_usd: 0.42,
  harness_duration_ms: 12_400,
  num_turns: 3,
  input_tokens: 900,
  output_tokens: 1_100,
  context_tokens_used: 250_000,
  modelUsage: {
    "claude-opus-5": {
      outputTokens: 1_100,
      cacheReadInputTokens: 40_000,
      cacheCreationInputTokens: 2_000,
      contextWindow: 1_000_000,
    },
  },
};

/** A PI-family result: the provider computes context itself. */
const piResult = {
  subtype: "success",
  total_cost_usd: 0.01,
  harness_duration_ms: 3_000,
  num_turns: 1,
  input_tokens: 100,
  output_tokens: 50,
  context_window: 200_000,
  context_tokens_used: 50_000,
  context_percent: 25,
};

test("turnMetaFromResultEvent reads context from modelUsage and from top-level fields", () => {
  expect(turnMetaFromResultEvent(claudeResult, "fallback")).toMatchObject({
    cost: 0.42,
    duration: 12_400,
    model: "claude-opus-5",
    turns: 3,
    cacheReadTokens: 40_000,
    cacheWriteTokens: 2_000,
    contextWindow: 1_000_000,
    contextTokensUsed: 250_000,
  });

  expect(turnMetaFromResultEvent(piResult, "some-pi-model")).toMatchObject({
    model: "some-pi-model",
    contextWindow: 200_000,
    contextTokensUsed: 50_000,
    contextPercent: 25,
  });
});

test("a provider that reports no usage yields no stats rather than a zeroed row", () => {
  const meta = turnMetaFromResultEvent({ subtype: "success", result: "done" });
  expect(meta.contextWindow).toBe(0);
  expect(hasTurnStats(meta)).toBe(false);
});

test("event-reconstructed history carries each turn's stats", () => {
  const sessionId = `turn-stats-events-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "events only", messageCount: 0, costUsd: 0 });

  addEvent(sessionId, 1, "user", "prompt", JSON.stringify({
    subtype: "prompt",
    message: { content: [{ type: "text", text: "go" }] },
  }));
  addEvent(sessionId, 2, "assistant", "message", JSON.stringify({
    message: { content: [{ type: "text", text: "done" }] },
  }));
  addEvent(sessionId, 3, "result", "success", JSON.stringify(claudeResult));

  const history = getSessionMessageHistory(sessionId);
  const assistant = history.messages.find((turn) => turn.role === "assistant");
  expect(assistant?.meta).toMatchObject({
    cost: 0.42,
    duration: 12_400,
    turns: 3,
    contextWindow: 1_000_000,
    contextTokensUsed: 250_000,
  });
});

test("materialized history merges result-event tokens over the stored message columns", () => {
  const sessionId = `turn-stats-materialized-${crypto.randomUUID()}`;
  upsertSession({
    id: sessionId,
    preview: "materialized",
    model: "claude-opus-5",
    messageCount: 0,
    costUsd: 0,
  });

  insertMessage({ sessionId, seq: 1, role: "user", content: "go" });
  insertMessage({
    sessionId,
    seq: 3,
    role: "assistant",
    content: "done",
    costUsd: 0.42,
    durationMs: 12_400,
    model: "claude-opus-5",
    turns: 3,
  });
  // Only the durable event carries token and context figures — the messages
  // table has no columns for them.
  addEvent(sessionId, 3, "result", "success", JSON.stringify(claudeResult));

  const assistant = getSessionMessageHistory(sessionId).messages
    .find((turn) => turn.role === "assistant");
  expect(assistant?.meta).toMatchObject({
    cost: 0.42,
    duration: 12_400,
    model: "claude-opus-5",
    turns: 3,
    inputTokens: 900,
    outputTokens: 1_100,
    contextWindow: 1_000_000,
    contextTokensUsed: 250_000,
  });
});

test("an interrupted turn materialized before its result still gets the result's stats", () => {
  const sessionId = `turn-stats-interrupted-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "interrupted", messageCount: 0, costUsd: 0 });

  insertMessage({ sessionId, seq: 1, role: "user", content: "go" });
  // Interrupting flushes the pending turn at the interrupt's seq, so the turn
  // is materialized *before* the result event that describes it.
  insertMessage({ sessionId, seq: 4, role: "assistant", content: "partial" });
  addEvent(sessionId, 5, "result", "interrupted", JSON.stringify(piResult));

  const assistant = getSessionMessageHistory(sessionId).messages
    .find((turn) => turn.role === "assistant");
  expect(assistant?.meta).toMatchObject({
    contextWindow: 200_000,
    contextPercent: 25,
  });
});

test("a user turn never carries stats", () => {
  const sessionId = `turn-stats-user-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "user only", messageCount: 0, costUsd: 0 });
  insertMessage({ sessionId, seq: 1, role: "user", content: "go" });

  const user = getSessionMessageHistory(sessionId).messages
    .find((turn) => turn.role === "user");
  expect(user?.meta).toBeUndefined();
});
