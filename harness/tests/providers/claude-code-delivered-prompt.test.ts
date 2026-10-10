import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * The CLI does not echo the messages it is given, and the harness writes only a
 * queue-time row, so a follow-up the provider pushes into a live subprocess has
 * no transcript turn unless the provider records it.
 */

afterEach(() => {
  mock.restore();
});

function makeSession() {
  return {
    sessionId: "ses-delivered-prompt",
    tempId: "ses-delivered-prompt",
    providerSessionId: null,
    status: "starting",
    provider: "claude-code",
    seq: 0,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    costUsd: 0,
    numTurns: 0,
    exchangeCount: 0,
    error: null,
    preview: "first",
    lastAssistantText: "",
    liveStream: { text: "", thinking: "", feed: "", seq: 0 },
    pendingAssistantTurn: null,
    initialPrompt: "first",
    initialContent: "first",
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

function makeTurnContext(session: any, events: any[]) {
  return {
    session,
    opts: { prompt: "first", cwd: session.cwd, additionalDirectories: [], provider: session.provider },
    profile: undefined,
    emitEvent(event: any) { events.push(event); },
    broadcastEvent() {},
    rekeySession(newId: string) { session.sessionId = newId; },
    setProviderSessionId(providerSessionId: string) { session.providerSessionId = providerSessionId; },
    notifyConfigChange() {},
    updateSessionDb() {},
  } as any;
}

/**
 * One warm subprocess answering two messages. The first turn's result waits for
 * `finishFirst`, so a message can arrive while that turn is still running.
 */
async function startSession() {
  let finishFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => { finishFirst = resolve; });

  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query({ prompt }: any) {
      const iterator = prompt[Symbol.asyncIterator]();
      const stream = (async function* () {
        await iterator.next();
        yield { type: "system", subtype: "init", session_id: "claude-session", model: "claude-sonnet" };
        yield { type: "assistant", message: { content: [{ type: "text", text: "one" }] } };
        await firstDone;
        yield { type: "result", subtype: "success", result: "one", total_cost_usd: 0, num_turns: 1 };
        await iterator.next();
        yield { type: "assistant", message: { content: [{ type: "text", text: "two" }] } };
        yield { type: "result", subtype: "success", result: "two", total_cost_usd: 0, num_turns: 1 };
        await iterator.next();
      })();
      return Object.assign(stream, { close() {} });
    },
  }));

  const { createClaudeCodeProvider } = await import("../../providers/claude-code");
  const session = makeSession();
  const events: any[] = [];
  const provider = createClaudeCodeProvider({ which: () => "test-claude" });
  const ctx = makeTurnContext(session, events);
  provider.startTurn(ctx);
  for (let i = 0; i < 100 && !events.some((event) => event.type === "assistant"); i++) await Bun.sleep(10);
  return { provider, session, events, ctx, finishFirst };
}

/** The event stream as the reconstructor reads it. */
function timeline(events: any[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "user" && event.subtype === "prompt") return [`prompt:${event.message.content}`];
    if (event.type === "assistant") return [`assistant:${event.message.content[0].text}`];
    if (event.type === "result") return [`result:${event.result}`];
    return [];
  });
}

async function waitForResults(events: any[], count: number) {
  for (let i = 0; i < 200 && events.filter((event) => event.type === "result").length < count; i++) await Bun.sleep(10);
}

describe("claude-code delivered prompts", () => {
  test("records a follow-up pushed into the idle subprocess", async () => {
    const { provider, session, events, ctx, finishFirst } = await startSession();
    finishFirst();
    for (let i = 0; i < 100 && session.status !== "idle"; i++) await Bun.sleep(10);
    expect(session.status).toBe("idle");

    provider.sendMessage(ctx, "second");
    await waitForResults(events, 2);

    expect(timeline(events)).toEqual([
      "prompt:first", "assistant:one", "result:one",
      "prompt:second", "assistant:two", "result:two",
    ]);
  }, 15_000);

  test("records a message queued mid-turn after the result it is flushed on", async () => {
    const { provider, session, events, ctx, finishFirst } = await startSession();
    expect(session.status).toBe("running");

    provider.sendMessage(ctx, "second");
    expect(session.pendingDispatch).toHaveLength(1);
    finishFirst();
    await waitForResults(events, 2);

    expect(timeline(events)).toEqual([
      "prompt:first", "assistant:one", "result:one",
      "prompt:second", "assistant:two", "result:two",
    ]);
  }, 15_000);
});
