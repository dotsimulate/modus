import { afterEach, describe, expect, test } from "bun:test";
import { getSessionState, hydrateSessionHistorySnapshot, removeSession, unsubscribeAll } from "./src/sessionStore";

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
      cwd: "D:\\TOOLSHELF\\modus",
      additionalDirectories: ["D:\\TOOLSHELF\\modus\\TODO"],
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
  });
});
