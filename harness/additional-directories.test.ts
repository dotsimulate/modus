import { afterEach, describe, expect, mock, test } from "bun:test";
import { validate, ProfileSchema } from "./profile-schemas";
import {
  CreateSessionRequestSchema,
  UpdateSessionConfigRequestSchema,
} from "./session-schemas";

afterEach(() => {
  mock.restore();
});

function makeSession(additionalDirectories: string[]) {
  return {
    sessionId: "ses-test",
    tempId: "ses-test",
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
    initialPrompt: "hello",
    initialContent: "hello",
    subscribers: new Set(),
    abortController: new AbortController(),
    dispatchState: "idle",
    pendingDispatch: [],
    turnStartedAt: Date.now(),
    cwd: "/tmp/workspace",
    additionalDirectories,
    pauseRequested: false,
    pauseResolver: null,
    pendingPermissions: new Map(),
    sessionApprovals: new Set(),
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
      additionalDirectories: session.additionalDirectories,
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
    notifyConfigChange() {},
    updateSessionDb() {},
  } as any;
}

describe("additionalDirectories", () => {
  test("accepts profile and session request schema fields", () => {
    const profile = validate(ProfileSchema, {
      prompt: "You are helpful",
      description: "test profile",
      additionalDirectories: ["/tmp/shared"],
    });
    expect(profile.ok).toBe(true);

    const createReq = validate(CreateSessionRequestSchema, {
      prompt: "hello",
      cwd: "/tmp/workspace",
      additionalDirectories: ["/tmp/shared"],
    });
    expect(createReq.ok).toBe(true);

    const configReq = validate(UpdateSessionConfigRequestSchema, {
      additionalDirectories: ["/tmp/shared", "/tmp/other"],
    });
    expect(configReq.ok).toBe(true);
  });

  test("passes additional directories to Claude Code launch options", async () => {
    let capturedOptions: any;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query({ options }: any) {
        capturedOptions = options;
        return (async function* () {
          yield { type: "system", subtype: "init", session_id: "claude-session", model: "claude-sonnet" };
          yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0, num_turns: 1 };
        })();
      },
    }));

    const { createClaudeCodeProvider } = await import("./providers/claude-code");
    const session = makeSession(["/tmp/shared", "/tmp/other"]);
    const provider = createClaudeCodeProvider();
    provider.startTurn(makeTurnContext(session));

    await Bun.sleep(0);

    expect(capturedOptions.additionalDirectories).toEqual(["/tmp/shared", "/tmp/other"]);
  });

  test("passes additional directories to Codex thread options", async () => {
    let capturedThreadOptions: any;

    mock.module("./providers/codex-cli-sdk", () => ({
      Codex: class {
        startThread(options: any) {
          capturedThreadOptions = options;
          return {
            async runStreamed() {
              return {
                events: (async function* () {
                  yield { type: "thread.started", thread_id: "codex-thread" };
                  yield { type: "turn.started" };
                  yield {
                    type: "turn.completed",
                    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
                  };
                })(),
              };
            },
          };
        }

        resumeThread(id: string, options: any) {
          capturedThreadOptions = options;
          return this.startThread(options);
        }
      },
    }));

    const { createCodexProvider } = await import("./providers/codex");
    const session = makeSession(["/tmp/shared"]);
    session.provider = "codex";
    const provider = createCodexProvider();
    provider.startTurn(makeTurnContext(session, { provider: "codex" }));

    await Bun.sleep(0);

    expect(capturedThreadOptions.additionalDirectories).toEqual(["/tmp/shared"]);
  });

  test("starts a fresh Codex thread when persisted rollout state is missing", async () => {
    const calls: string[] = [];
    let capturedThreadOptions: any;

    mock.module("./db", () => ({
      getSession(id: string) {
        return id === "stale-thread" ? { id, message_count: 0 } : null;
      },
      updateSessionStatus() {},
      getMaxSeq() {
        return 0;
      },
    }));

    mock.module("./activity", () => ({
      logActivity() {},
    }));

    mock.module("./secrets", () => ({
      resolveSecret() {
        return undefined;
      },
    }));

    mock.module("./profiles", () => ({
      getGlobalConfig() {
        return {};
      },
      getProfile() {
        return undefined;
      },
      resolveProfilePrompt() {
        return undefined;
      },
    }));

    mock.module("./providers/codex-model-cache", () => ({
      getCodexSeedModel() {
        return "gpt-5.4";
      },
    }));

    mock.module("./providers/codex-cli-sdk", () => ({
      canResumeCodexThread(id: string) {
        calls.push(`canResume:${id}`);
        return false;
      },
      Thread: class {},
      Codex: class {
        startThread(options: any) {
          capturedThreadOptions = options;
          calls.push("startThread");
          return {
            async runStreamed() {
              return {
                events: (async function* () {
                  yield { type: "thread.started", thread_id: "fresh-thread" };
                  yield { type: "turn.started" };
                  yield {
                    type: "turn.completed",
                    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
                  };
                })(),
              };
            },
          };
        }

        resumeThread() {
          calls.push("resumeThread");
          throw new Error("resumeThread should not be called without local rollout state");
        }
      },
    }));

    const { createCodexProvider } = await import("./providers/codex");
    const session = makeSession(["/tmp/shared"]);
    session.provider = "codex";
    session.sessionId = "stale-thread";
    session.tempId = "stale-thread";
    const provider = createCodexProvider();
    provider.startTurn(makeTurnContext(session, { provider: "codex", sessionId: "stale-thread" }));

    await Bun.sleep(10);

    expect(calls).toContain("canResume:stale-thread");
    expect(calls).toContain("startThread");
    expect(calls).not.toContain("resumeThread");
    expect(capturedThreadOptions.additionalDirectories).toEqual(["/tmp/shared"]);
    expect(session.sessionId).toBe("fresh-thread");
    expect(session.status).toBe("idle");
  });
});
