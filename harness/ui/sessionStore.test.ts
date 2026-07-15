import { afterEach, describe, expect, test } from "bun:test";
import {
  getSessionHistoryLoadState,
  getSessionState,
  hydrateSessionHistorySnapshot,
  removeSession,
  shouldReuseSessionSubscription,
  unsubscribeAll,
} from "./src/sessionStore";

describe("sessionStore history snapshot hydration", () => {
  afterEach(() => {
    removeSession("ses-history");
    unsubscribeAll();
  });

  test("hydrates semantic turns without event replay", () => {
    hydrateSessionHistorySnapshot({
      sessionId: "ses-history",
      status: "done",
      model: "claude-sonnet",
      cwd: "/tmp/modus",
      additionalDirectories: ["/tmp/modus/TODO"],
      loadProjectSettings: true,
      agentConfig: {
        toolStates: { bash: "on" },
        model: "claude-sonnet",
        provider: "claude-code",
        effort: "high",
        maxTurns: "12",
        providerControls: {},
      },
      messages: [
        {
          role: "user",
          seq: 1,
          text: "audit this architecture",
          timestamp: 1000,
        },
        {
          role: "assistant",
          seq: 4,
          text: "the hot path is wrong",
          thinking: "checking persistence path",
          timestamp: 2000,
          toolCalls: [
            {
              name: "Read",
              input: { path: "harness/session-manager.ts" },
              result: "loaded",
            },
          ],
        },
      ],
      lastSeq: 6,
      createdAt: 500,
    });

    const state = getSessionState("ses-history");
    expect(state).not.toBeNull();
    expect(state?.status).toBe("done");
    expect(state?.lastSeq).toBe(6);
    expect(state?.messages).toHaveLength(2);
    expect(state?.messages[1]?.content).toBe("the hot path is wrong");
    expect(state?.messages[1]?.toolCalls?.[0]?.status).toBe("completed");
    expect(state?.messages[1]?.artifacts).toBeUndefined();
    expect(getSessionHistoryLoadState("ses-history").status).toBe("ready");
  });

  test("does not mistake an empty subscription for hydrated history", () => {
    expect(shouldReuseSessionSubscription({
      subscribed: true,
      forceHistoryRefresh: true,
      messageCount: 0,
      lastSeq: 0,
      historyStatus: "error",
    })).toBe(false);

    expect(shouldReuseSessionSubscription({
      subscribed: true,
      messageCount: 0,
      lastSeq: 0,
      historyStatus: "error",
    })).toBe(false);

    expect(shouldReuseSessionSubscription({
      subscribed: true,
      forceHistoryRefresh: true,
      messageCount: 2,
      lastSeq: 8,
      historyStatus: "ready",
    })).toBe(true);
  });

  test("hydrates lightweight ordered blocks around deferred provider activity", () => {
    hydrateSessionHistorySnapshot({
      sessionId: "ses-history",
      status: "done",
      model: "gpt-5",
      cwd: "/tmp/modus",
      additionalDirectories: [],
      loadProjectSettings: true,
      agentConfig: {
        toolStates: {},
        model: "gpt-5",
        provider: "codex",
        effort: "high",
        maxTurns: "",
        providerControls: {},
      },
      messages: [{
        role: "assistant",
        seq: 20,
        text: "beforeafter",
        timestamp: 1000,
        detailsDeferred: true,
        deferredToolCallCount: 1,
        contentBlocks: [
          { type: "text", textStart: 0, textEnd: 6 },
          { type: "deferred", hasThinking: false, toolCallCount: 1 },
          { type: "text", textStart: 6, textEnd: 11 },
        ],
      }],
      lastSeq: 20,
      createdAt: 500,
    });

    expect(getSessionState("ses-history")?.messages[0]?.contentBlocks).toEqual([
      { type: "text", text: "before" },
      { type: "deferred", hasThinking: false, toolCallCount: 1 },
      { type: "text", text: "after" },
    ]);
  });
});
