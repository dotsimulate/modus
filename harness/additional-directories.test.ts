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
    pendingMessages: [],
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

    mock.module("@openai/codex-sdk", () => ({
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
});
