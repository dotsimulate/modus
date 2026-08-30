import { afterEach, describe, expect, test } from "bun:test";
import {
  applyEvent,
  applyEventBatch,
  ensureSubscribed,
  getSessionHistoryLoadState,
  getSessionState,
  getStoreSessionIds,
  hydrateSessionHistorySnapshot,
  evictInactiveSessions,
  loadOlderSessionHistory,
  loadSessionMessageDetails,
  removeSession,
  setSessionState,
  subscribeStore,
  shouldRefetchEmptyResolvedHistory,
  shouldReuseSessionSubscription,
  unsubscribeAll,
} from "../../ui/src/sessionStore";
import { createInitialState } from "../../ui/src/eventReducer";
import { modus } from "../../ui/src/modusClient";

describe("sessionStore render scheduling", () => {
  test("coalesces browser subscriber notifications to one animation frame", () => {
    const original = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    let notified = 0;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    const unsubscribe = subscribeStore(() => { notified++; });

    try {
      setSessionState("ses-frame", createInitialState("ses-frame"));
      setSessionState("ses-frame", createInitialState("ses-frame"));

      expect(notified).toBe(0);
      expect(frames).toHaveLength(1);
      frames.shift()?.(performance.now());
      expect(notified).toBe(1);
    } finally {
      unsubscribe();
      removeSession("ses-frame");
      frames.shift()?.(performance.now());
      globalThis.requestAnimationFrame = original;
    }
  });
});

describe("sessionStore history snapshot hydration", () => {
  afterEach(() => {
    removeSession("ses-history");
    removeSession("ses-race");
    removeSession("ses-page");
    removeSession("ses-offset");
    for (let index = 0; index <= 10; index++) {
      removeSession(`ses-cache-${index}`);
    }
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

  test("hydrates only the recent history page on a cold subscription", async () => {
    let requestedLimit: number | "all" | undefined;
    const original = modus.getSessionHistorySnapshot;
    modus.getSessionHistorySnapshot = (async (_sessionId: string, options?: { limit?: number | "all" }) => {
      requestedLimit = options?.limit;
      return {
        sessionId: "ses-page",
        status: "done" as const,
        model: "claude-sonnet",
        cwd: "/tmp/modus",
        additionalDirectories: [] as string[],
        loadProjectSettings: true,
        agentConfig: {
          toolStates: {}, model: "claude-sonnet", provider: "claude-code",
          effort: "high", maxTurns: "", providerControls: {},
        },
        messages: [{ role: "user" as const, seq: 91, text: "recent context", timestamp: 1000 }],
        lastSeq: 91,
        createdAt: 500,
        hasMoreHistory: true,
        oldestSeq: 91,
      };
    }) as typeof modus.getSessionHistorySnapshot;

    try {
      await ensureSubscribed("ses-page", { forceHistoryRefresh: true });
    } finally {
      modus.getSessionHistorySnapshot = original;
    }

    expect(requestedLimit).toBe(12);
    expect(getSessionHistoryLoadState("ses-page").hasMore).toBe(true);
  });

  test("keeps a bounded LRU of settled sessions for instant revisit", () => {
    for (let index = 0; index <= 10; index++) {
      const state = createInitialState(`ses-cache-${index}`);
      state.status = index === 1 ? "running" : "done";
      state.messages = index === 0
        ? Array.from({ length: 20 }, (_, messageIndex) => ({
            id: messageIndex,
            role: "user" as const,
            content: `message 0-${messageIndex}`,
            seq: messageIndex + 1,
            timestamp: 1000 + messageIndex,
          }))
        : [{
            id: index,
            role: "user",
            content: `message ${index}`,
          }];
      setSessionState(`ses-cache-${index}`, state);
    }

    // Touch the oldest settled entry so the cache policy is access-ordered,
    // not tied to when the session happened to enter the store.
    setSessionState("ses-cache-0", getSessionState("ses-cache-0")!);
    evictInactiveSessions("ses-cache-10");

    expect(getSessionState("ses-cache-10")).not.toBeNull();
    expect(getSessionState("ses-cache-1")?.status).toBe("running");
    // A retained transcript keeps every page that was loaded into it, and
    // eviction never fabricates a hasMore for pages it discarded.
    expect(getSessionState("ses-cache-0")?.messages).toHaveLength(20);
    expect(getSessionState("ses-cache-0")?.messages[0]?.content).toBe("message 0-0");
    expect(getSessionHistoryLoadState("ses-cache-0").hasMore).toBe(false);
    expect(getSessionState("ses-cache-2")).toBeNull();
    for (let index = 3; index <= 9; index++) {
      expect(getSessionState(`ses-cache-${index}`)).not.toBeNull();
    }
  });

  test("pages backward with wall-clock position when provider sequences collide", async () => {
    hydrateSessionHistorySnapshot({
      sessionId: "ses-history",
      status: "done",
      model: "grok",
      cwd: "/tmp/modus",
      additionalDirectories: [],
      loadProjectSettings: true,
      agentConfig: {
        toolStates: {}, model: "grok", provider: "grok-build",
        effort: "high", maxTurns: "", providerControls: {},
      },
      messages: [{ role: "user", seq: 1, text: "newer reused sequence", timestamp: 2000 }],
      lastSeq: 9,
      createdAt: 500,
      hasMoreHistory: true,
      oldestSeq: 1,
      oldestCreatedAt: 2000,
      oldestId: 42,
    });

    let requestedBeforeSeq: number | undefined;
    let requestedBeforeCreatedAt: number | undefined;
    let requestedBeforeId: number | undefined;
    const original = modus.getSessionHistorySnapshot;
    modus.getSessionHistorySnapshot = (async (_sessionId: string, options?: {
      beforeSeq?: number;
      beforeCreatedAt?: number;
      beforeId?: number;
    }) => {
      requestedBeforeSeq = options?.beforeSeq;
      requestedBeforeCreatedAt = options?.beforeCreatedAt;
      requestedBeforeId = options?.beforeId;
      return {
        sessionId: "ses-history",
        status: "done" as const,
        model: "grok",
        cwd: "/tmp/modus",
        additionalDirectories: [] as string[],
        loadProjectSettings: true,
        agentConfig: {
          toolStates: {}, model: "grok", provider: "grok-build",
          effort: "high", maxTurns: "", providerControls: {},
        },
        messages: [{ role: "user" as const, seq: 1, text: "older same sequence", timestamp: 1000 }],
        lastSeq: 9,
        createdAt: 500,
        hasMoreHistory: false,
        oldestSeq: 1,
        oldestCreatedAt: 1000,
        oldestId: 12,
      };
    }) as typeof modus.getSessionHistorySnapshot;

    try {
      await loadOlderSessionHistory("ses-history");
    } finally {
      modus.getSessionHistorySnapshot = original;
    }

    expect(requestedBeforeSeq).toBe(1);
    expect(requestedBeforeCreatedAt).toBe(2000);
    expect(requestedBeforeId).toBe(42);
    expect(getSessionState("ses-history")?.messages.map((message) => message.content)).toEqual([
      "older same sequence",
      "newer reused sequence",
    ]);
  });

  test("pages backward on wall clock alone when no loaded turn carries a sequence", async () => {
    hydrateSessionHistorySnapshot({
      sessionId: "ses-noseq",
      status: "done",
      model: "grok",
      cwd: "/tmp/modus",
      additionalDirectories: [],
      loadProjectSettings: true,
      agentConfig: {
        toolStates: {}, model: "grok", provider: "grok-build",
        effort: "high", maxTurns: "", providerControls: {},
      },
      messages: [{ role: "user", seq: 0, text: "unnumbered turn", timestamp: 2000 }],
      lastSeq: 0,
      createdAt: 500,
      hasMoreHistory: true,
      oldestSeq: null,
      oldestCreatedAt: 2000,
    });

    let requested = false;
    let requestedBeforeSeq: number | undefined;
    let requestedBeforeCreatedAt: number | undefined;
    const original = modus.getSessionHistorySnapshot;
    modus.getSessionHistorySnapshot = (async (_sessionId: string, options?: {
      beforeSeq?: number;
      beforeCreatedAt?: number;
    }) => {
      requested = true;
      requestedBeforeSeq = options?.beforeSeq;
      requestedBeforeCreatedAt = options?.beforeCreatedAt;
      return {
        sessionId: "ses-noseq",
        status: "done" as const,
        model: "grok",
        cwd: "/tmp/modus",
        additionalDirectories: [] as string[],
        loadProjectSettings: true,
        agentConfig: {
          toolStates: {}, model: "grok", provider: "grok-build",
          effort: "high", maxTurns: "", providerControls: {},
        },
        messages: [{ role: "user" as const, seq: 0, text: "older unnumbered turn", timestamp: 1000 }],
        lastSeq: 0,
        createdAt: 500,
        hasMoreHistory: false,
        oldestSeq: null,
        oldestCreatedAt: 1000,
      };
    }) as typeof modus.getSessionHistorySnapshot;

    try {
      await loadOlderSessionHistory("ses-noseq");
    } finally {
      modus.getSessionHistorySnapshot = original;
    }

    // The loader used to render and do nothing here: it required a sequence
    // that a transcript like this never supplies.
    expect(requested).toBe(true);
    expect(requestedBeforeSeq).toBeUndefined();
    expect(requestedBeforeCreatedAt).toBe(2000);
    expect(getSessionState("ses-noseq")?.messages.map((message) => message.content)).toEqual([
      "older unnumbered turn",
      "unnumbered turn",
    ]);
  });

  test("turn offset tracks the fetched page, not the accumulated messages", async () => {
    hydrateSessionHistorySnapshot({
      sessionId: "ses-offset",
      status: "done",
      model: "claude-sonnet",
      cwd: "/tmp/modus",
      additionalDirectories: [],
      loadProjectSettings: true,
      agentConfig: {
        toolStates: {}, model: "claude-sonnet", provider: "claude-code",
        effort: "high", maxTurns: "", providerControls: {},
      },
      messages: [{ role: "user", seq: 41, text: "turn forty-one", timestamp: 2000 }],
      lastSeq: 41,
      createdAt: 500,
      hasMoreHistory: true,
      oldestSeq: 41,
      oldestCreatedAt: 2000,
      olderTurnCount: 40,
    });

    expect(getSessionHistoryLoadState("ses-offset").olderTurnCount).toBe(40);

    const original = modus.getSessionHistorySnapshot;
    modus.getSessionHistorySnapshot = (async () => ({
      sessionId: "ses-offset",
      status: "done" as const,
      model: "claude-sonnet",
      cwd: "/tmp/modus",
      additionalDirectories: [] as string[],
      loadProjectSettings: true,
      agentConfig: {
        toolStates: {}, model: "claude-sonnet", provider: "claude-code",
        effort: "high", maxTurns: "", providerControls: {},
      },
      // One turn, two messages — an offset derived from what was prepended
      // cannot tell those apart, which is the drift this pins.
      messages: [
        { role: "user" as const, seq: 40, text: "turn forty", timestamp: 1000 },
        { role: "assistant" as const, seq: 40, text: "answer forty", timestamp: 1001 },
      ],
      lastSeq: 41,
      createdAt: 500,
      hasMoreHistory: true,
      oldestSeq: 40,
      oldestCreatedAt: 1000,
      olderTurnCount: 39,
    })) as typeof modus.getSessionHistorySnapshot;

    try {
      await loadOlderSessionHistory("ses-offset");
    } finally {
      modus.getSessionHistorySnapshot = original;
    }

    // The page reports where its own cutoff sits. Deriving the offset from the
    // client's message array instead would drift by one on every prepend.
    expect(getSessionState("ses-offset")?.messages).toHaveLength(3);
    expect(getSessionHistoryLoadState("ses-offset").olderTurnCount).toBe(39);
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

describe("sessionStore init rekey", () => {
  afterEach(() => {
    removeSession("pending-draft");
    removeSession("11111111-1111-4111-8111-111111111111");
    removeSession("fake-grok-session");
    unsubscribeAll();
  });

  test("does not replace a durable session id with a provider-native conversation id", () => {
    const modusId = "11111111-1111-4111-8111-111111111111";
    setSessionState(modusId, createInitialState(modusId));
    applyEvent(modusId, {
      type: "system",
      subtype: "init",
      session_id: "fake-grok-session",
      model: "grok-test",
    }, 1);
    expect(getSessionState(modusId)?.sessionId).toBe(modusId);
    expect(getSessionState("fake-grok-session")).toBeNull();
    expect(getStoreSessionIds()).toContain(modusId);
    expect(getStoreSessionIds()).not.toContain("fake-grok-session");
  });

  test("still rekeys a pending composer id from init", () => {
    setSessionState("pending-draft", createInitialState("pending-draft"));
    applyEvent("pending-draft", {
      type: "system",
      subtype: "init",
      session_id: "11111111-1111-4111-8111-111111111111",
      model: "grok-test",
    }, 1);
    expect(getSessionState("pending-draft")).toBeNull();
    expect(getSessionState("11111111-1111-4111-8111-111111111111")?.sessionId)
      .toBe("11111111-1111-4111-8111-111111111111");
  });
});
