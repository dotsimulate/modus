import { afterEach, describe, expect, test } from "bun:test";
import {
  applyEventBatch,
  ensureSubscribed,
  getSessionHistoryLoadState,
  getSessionState,
  hydrateSessionHistorySnapshot,
  loadSessionMessageDetails,
  removeSession,
  setSessionState,
  shouldRefetchEmptyResolvedHistory,
  shouldReuseSessionSubscription,
  unsubscribeAll,
} from "./src/sessionStore";
import { createInitialState } from "./src/eventReducer";
import { modus } from "./src/modusClient";

describe("sessionStore history snapshot hydration", () => {
  afterEach(() => {
    removeSession("ses-history");
    removeSession("ses-race");
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
      historyStatus: "error",
    })).toBe(false);

    expect(shouldReuseSessionSubscription({
      subscribed: true,
      messageCount: 0,
      historyStatus: "error",
    })).toBe(false);

    expect(shouldReuseSessionSubscription({
      subscribed: true,
      forceHistoryRefresh: true,
      messageCount: 2,
      historyStatus: "ready",
    })).toBe(true);
  });

  test("a bare event cursor with no messages is not reusable history", () => {
    // The catch-up-of-skipped-events state: lastSeq advanced, thread empty.
    // Treating it as warm is what left chats blank until a manual reload, so
    // the predicate must ignore the cursor entirely and force a snapshot fetch.
    expect(shouldReuseSessionSubscription({
      subscribed: true,
      messageCount: 0,
      historyStatus: "idle",
    })).toBe(false);

    // A snapshot that legitimately came back empty stays reusable, so a brand
    // new conversation does not refetch on every widget mount.
    expect(shouldReuseSessionSubscription({
      subscribed: true,
      messageCount: 0,
      historyStatus: "ready",
    })).toBe(true);
  });

  test("skipped-only event catch-up does not mark history ready", () => {
    // A cold entry, exactly as ensureSubscribed creates one before any snapshot.
    setSessionState("ses-history", createInitialState("ses-history"));
    expect(getSessionHistoryLoadState("ses-history").status).toBe("idle");

    applyEventBatch("ses-history", [
      { event: "message", data: { type: "stream_event", delta: "hi" }, seq: 11 },
      { event: "message", data: { type: "tool_progress", tool: "Read" }, seq: 12 },
      { event: "message", data: { type: "system", subtype: "live_snapshot" }, seq: 13 },
    ]);

    const state = getSessionState("ses-history");
    expect(state?.messages).toHaveLength(0);
    // The cursor still advances so the next subscribe doesn't replay them...
    expect(state?.lastSeq).toBe(13);
    // ...but the empty thread must not be reusable as if it were real history.
    expect(shouldReuseSessionSubscription({
      subscribed: true,
      messageCount: state?.messages.length ?? 0,
      historyStatus: getSessionHistoryLoadState("ses-history").status,
    })).toBe(false);
  });

  test("a forced refresh is not absorbed by an in-flight plain subscribe", async () => {
    const emptySnapshot = {
      sessionId: "ses-race",
      status: "done" as const,
      model: "claude-sonnet",
      cwd: "/tmp/modus",
      additionalDirectories: [] as string[],
      loadProjectSettings: true,
      agentConfig: {
        toolStates: {}, model: "claude-sonnet", provider: "claude-code",
        effort: "high", maxTurns: "", providerControls: {},
      },
      messages: [] as any[],
      lastSeq: 0,
      createdAt: 500,
    };
    const requests: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const original = modus.getSessionHistorySnapshot;
    modus.getSessionHistorySnapshot = (async (sessionId: string) => {
      requests.push(sessionId);
      if (requests.length === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return emptySnapshot;
      }
      return {
        ...emptySnapshot,
        messages: [{ role: "user" as const, seq: 1, text: "where did my chat go", timestamp: 1000 }],
        lastSeq: 1,
      };
    }) as typeof modus.getSessionHistorySnapshot;

    try {
      const plain = ensureSubscribed("ses-race");
      const forced = ensureSubscribed("ses-race", { forceHistoryRefresh: true });
      // The forced caller must not simply be handed the plain run's promise.
      expect(forced).not.toBe(plain);
      releaseFirst!();
      await plain;
      await forced;
    } finally {
      modus.getSessionHistorySnapshot = original;
    }

    // Two fetches: the plain run resolved to an empty thread, and the forced
    // caller re-evaluated afterwards instead of inheriting that outcome.
    expect(requests).toEqual(["ses-race", "ses-race"]);
    expect(getSessionState("ses-race")?.messages).toHaveLength(1);
  });

  test("self-heal fires only for a resolved-but-empty thread the server says has content", () => {
    const base = {
      historyStatus: "ready" as const,
      messageCount: 0,
      serverMessageCount: 4,
      serverPreview: "audit this architecture",
      alreadyAttempted: false,
    };
    expect(shouldRefetchEmptyResolvedHistory(base)).toBe(true);

    // Never twice for the same session.
    expect(shouldRefetchEmptyResolvedHistory({ ...base, alreadyAttempted: true })).toBe(false);
    // Never on a thread that painted — this must not cost a working load.
    expect(shouldRefetchEmptyResolvedHistory({ ...base, messageCount: 3 })).toBe(false);
    // Never while history is still resolving or has already failed loudly.
    expect(shouldRefetchEmptyResolvedHistory({ ...base, historyStatus: "loading" })).toBe(false);
    expect(shouldRefetchEmptyResolvedHistory({ ...base, historyStatus: "error" })).toBe(false);
    // Never for a session the server agrees is empty.
    expect(shouldRefetchEmptyResolvedHistory({
      ...base, serverMessageCount: 0, serverPreview: "   ",
    })).toBe(false);
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

  test("loads deferred details with an immutable message-array update", async () => {
    hydrateSessionHistorySnapshot({
      sessionId: "ses-history",
      status: "done",
      model: "gpt-5",
      cwd: "/tmp/modus",
      additionalDirectories: [],
      loadProjectSettings: true,
      agentConfig: {
        toolStates: {}, model: "gpt-5", provider: "codex", effort: "high", maxTurns: "", providerControls: {},
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
    const before = getSessionState("ses-history")!.messages;
    const original = modus.getMessages;
    modus.getMessages = async () => ({
      role: "assistant",
      seq: 20,
      text: "beforeafter",
      timestamp: 1000,
      toolCalls: [{ name: "Read", input: { path: "README.md" }, result: "ok" }],
      contentBlocks: [
        { type: "text", text: "before" },
        { type: "tool_call", toolCall: { name: "Read", input: { path: "README.md" }, result: "ok" } },
        { type: "text", text: "after" },
      ],
    });
    try {
      await loadSessionMessageDetails("ses-history", 20);
    } finally {
      modus.getMessages = original;
    }
    const after = getSessionState("ses-history")!.messages;
    expect(after).not.toBe(before);
    expect(after[0]?.detailsDeferred).toBe(false);
    expect(after[0]?.toolCalls?.[0]?.name).toBe("Read");
    expect(after[0]?.contentBlocks?.[1]?.type).toBe("tool_call");
  });
});
