import { afterEach, describe, expect, mock, test } from "bun:test";

afterEach(() => {
  mock.restore();
});

function makeSession() {
  return {
    sessionId: "ses-live-config",
    tempId: "ses-live-config",
    providerSessionId: null,
    status: "starting",
    profile: undefined,
    provider: "claude-code",
    model: undefined,
    seq: 0,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    costUsd: 0,
    numTurns: 0,
    exchangeCount: 0,
    error: null,
    preview: "hello",
    lastAssistantText: "",
    liveStream: { text: "", thinking: "", feed: "", seq: 0 },
    pendingAssistantTurn: null,
    initialPrompt: "hello",
    initialContent: "hello",
    subscribers: new Set(),
    abortController: new AbortController(),
    dispatchState: "idle",
    pendingDispatch: [],
    turnStartedAt: Date.now(),
    cwd: "/tmp/workspace",
    additionalDirectories: [],
    pauseRequested: false,
    pauseResolver: null,
    pendingPermissions: new Map(),
    sessionApprovals: new Set(),
    osPids: new Set(),
    watchers: new Set(),
    _provider: {} as any,
    _providerState: null,
    _configOverrides: {},
  } as any;
}

function makeTurnContext(session: any, opts: Record<string, unknown> = {}) {
  return {
    session,
    opts: {
      prompt: "hello",
      cwd: session.cwd,
      additionalDirectories: [],
      provider: session.provider,
      loadProjectSettings: true,
      ...opts,
    },
    profile: undefined,
    emitEvent() {},
    broadcastEvent() {},
    rekeySession(newId: string) {
      session.sessionId = newId;
    },
    setProviderSessionId(providerSessionId: string) {
      session.providerSessionId = providerSessionId;
    },
    notifyConfigChange() {},
    updateSessionDb() {},
  } as any;
}

/** Starts a turn whose subprocess stays warm after its result, as the real CLI does. */
async function startWarmSession(opts: Record<string, unknown> = {}) {
  const calls: { setModel: (string | undefined)[]; flagSettings: Record<string, unknown>[] } = {
    setModel: [],
    flagSettings: [],
  };

  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query({ prompt, options }: any) {
      const iterator = prompt[Symbol.asyncIterator]();
      const stream = (async function* () {
        await iterator.next();
        yield { type: "system", subtype: "init", session_id: options.sessionId ?? "claude-session", model: "claude-sonnet" };
        yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0, num_turns: 1 };
        // Stay alive waiting for the next pushed message.
        await iterator.next();
      })();
      return Object.assign(stream, {
        async setModel(model?: string) { calls.setModel.push(model); },
        async applyFlagSettings(settings: Record<string, unknown>) { calls.flagSettings.push(settings); },
        close() {},
      });
    },
  }));

  const { createClaudeCodeProvider } = await import("../../providers/claude-code");
  const session = makeSession();
  const provider = createClaudeCodeProvider({ which: () => "test-claude" });
  provider.startTurn(makeTurnContext(session, opts));
  for (let i = 0; i < 100 && session.status !== "idle"; i++) await Bun.sleep(10);
  expect(session.status).toBe("idle");
  expect((session._providerState as any)?.drainActive).toBe(true);
  return { provider, session, calls };
}

describe("claude-code live config", () => {
  test("applies an effort change to the warm subprocess between turns", async () => {
    const { provider, session, calls } = await startWarmSession({ effort: "high" });

    provider.updateConfig!(session, { effort: "low" });
    expect(calls.flagSettings).toEqual([{ effortLevel: "low" }]);

    provider.updateConfig!(session, { effort: "off" });
    expect(calls.flagSettings).toEqual([{ effortLevel: "low" }, { effortLevel: null }]);
  });

  test("applies a model change to the warm subprocess between turns", async () => {
    const { provider, session, calls } = await startWarmSession();

    provider.updateConfig!(session, { model: "claude-opus-5-5" });
    expect(calls.setModel).toEqual(["claude-opus-5-5"]);
  });

  test("does not send live controls when nothing changed", async () => {
    const { provider, session, calls } = await startWarmSession({ effort: "high", model: "claude-opus-5-5" });

    provider.updateConfig!(session, { effort: "high", model: "claude-opus-5-5", maxTurns: 5 });
    expect(calls.flagSettings).toEqual([]);
    expect(calls.setModel).toEqual([]);
  });
});
