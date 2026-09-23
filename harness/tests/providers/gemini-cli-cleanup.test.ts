import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "modus-gemini-cleanup-"));
const environment = Object.fromEntries(
  ["MODUS_HOME", "HARNESS_SECRETS_FILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "GEMINI_API_KEY"]
    .map((key) => [key, process.env[key]]),
);
process.env.MODUS_HOME = join(root, "home");
process.env.HARNESS_SECRETS_FILE = join(root, "secrets.json");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CACHE_HOME = join(root, "cache");

const { createGeminiCliProvider, initializeGeminiConfig } = await import("../../providers/gemini-cli");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function context() {
  const session = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    cwd: root,
    projectRoot: root,
    abortController: new AbortController(),
    initialContent: "hello",
    pendingDispatch: [],
    pendingPermissions: new Map(),
    status: "starting",
    turnStartedAt: Date.now(),
    numTurns: 0,
    costUsd: 0,
    lastAssistantText: "",
    preview: "hello",
  } as any;
  const events: any[] = [];
  const ctx = {
    session,
    opts: { model: "test-model", loadProjectSettings: false },
    profile: undefined,
    setProviderSessionId: () => {},
    rekeySession: () => {},
    emitEvent: (event: any) => { events.push(event); },
    broadcastEvent: () => {},
    updateSessionDb: () => {},
  } as any;
  return { session, ctx, events };
}

function fakeConfig(options: {
  initialize?: () => Promise<void>;
  dispose?: () => Promise<void>;
  stream?: () => AsyncGenerator<never>;
} = {}) {
  const client = {
    isInitialized: () => true,
    sendMessageStream: options.stream ?? (async function* () {}),
    dispose: () => {},
  };
  const bus = { subscribe: () => {}, unsubscribe: () => {}, on: () => {}, off: () => {} };
  return {
    initialize: options.initialize ?? (async () => {}),
    dispose: options.dispose ?? (async () => {}),
    getMessageBus: () => bus,
    refreshAuth: async () => {},
    getGeminiClient: () => client,
    getToolRegistry: () => ({ getAllToolNames: () => [] }),
  } as any;
}

afterAll(() => {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("Gemini SDK cleanup", () => {
  test("restores both console methods after initialization failure", async () => {
    const log = console.log;
    const warn = console.warn;
    try {
      await expect(initializeGeminiConfig({ initialize: async () => { throw new Error("fake init failure"); } } as any))
        .rejects.toThrow("fake init failure");
      expect(console.log).toBe(log);
      expect(console.warn).toBe(warn);
    } finally {
      console.log = log;
      console.warn = warn;
    }
  });

  test("awaits Config disposal after failed setup and leaves no console wrappers", async () => {
    const { ctx, session, events } = context();
    const closed = deferred();
    let disposals = 0;
    const log = console.log;
    const warn = console.warn;
    const provider = createGeminiCliProvider(() => fakeConfig({
      initialize: async () => { throw new Error("fake init failure"); },
      dispose: async () => { disposals++; await closed.promise; },
    }));
    provider.startTurn(ctx);
    await Bun.sleep(10);
    expect(disposals).toBe(1);
    expect(console.log).toBe(log);
    expect(console.warn).toBe(warn);
    expect(events.some((event) => event.type === "result")).toBe(false);
    closed.resolve();
    await session._providerState.turnCompletion;
    expect(disposals).toBe(1);
    expect(events.some((event) => event.type === "result" && event.subtype === "error")).toBe(true);
  });

  test("does not create a follow-up generation until prior MCP cleanup finishes", async () => {
    process.env.GEMINI_API_KEY = "synthetic-test-canary";
    const { ctx, session } = context();
    const closing = deferred();
    const closed = deferred();
    let generations = 0;
    let disposals = 0;
    const provider = createGeminiCliProvider(() => {
      generations++;
      return fakeConfig({ dispose: async () => { disposals++; closing.resolve(); await closed.promise; } });
    });
    provider.startTurn(ctx);
    await closing.promise;
    expect(session.status).toBe("idle");
    provider.sendMessage(ctx, "next");
    await Bun.sleep(10);
    expect(generations).toBe(1);
    const disposed = provider.dispose!(session);
    closed.resolve();
    await disposed;
    expect(generations).toBe(1);
    expect(disposals).toBe(1);
    expect(session._providerState).toBeNull();
  });

  test("session disposal waits for in-flight initialization then closes Config once", async () => {
    const { ctx, session } = context();
    const initializing = deferred();
    const initialized = deferred();
    let disposals = 0;
    const provider = createGeminiCliProvider(() => fakeConfig({
      initialize: async () => { initializing.resolve(); await initialized.promise; },
      dispose: async () => { disposals++; },
    }));
    provider.startTurn(ctx);
    await initializing.promise;
    const disposed = provider.dispose!(session);
    initialized.resolve();
    await disposed;
    expect(disposals).toBe(1);
    expect(session._providerState).toBeNull();
  });

  test("abort closes Config after the in-flight stream exits", async () => {
    process.env.GEMINI_API_KEY = "synthetic-test-canary";
    const { ctx, session } = context();
    const streaming = deferred();
    const leaveStream = deferred();
    let disposals = 0;
    const provider = createGeminiCliProvider(() => fakeConfig({
      stream: async function* () {
        streaming.resolve();
        await leaveStream.promise;
      },
      dispose: async () => { disposals++; },
    }));
    provider.startTurn(ctx);
    await streaming.promise;
    provider.abort(session);
    leaveStream.resolve();
    await session._providerState.turnCompletion;
    expect(disposals).toBe(1);
    await provider.dispose!(session);
    expect(disposals).toBe(1);
  });
});
