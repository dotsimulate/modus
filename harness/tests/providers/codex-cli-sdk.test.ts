import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { Readable } from "stream";

const spawnCalls: Array<{ cwd?: string; args: string[] }> = [];
let nextExitCode = 0;
const TEST_WORKSPACE = "/tmp/modus-test-workspace";

class MockReadable extends Readable {
  constructor() {
    super({ encoding: "utf8" });
  }

  override _read() {
    this.push(null);
  }
}

class MockWritable extends EventEmitter {
  write() {
    return true;
  }

  end() {
    this.emit("finish");
  }
}

class MockChild extends EventEmitter {
  pid = 12345;
  stdin = new MockWritable();
  stdout = new MockReadable();
  stderr = new EventEmitter();
  killed = false;

  kill() {
    this.killed = true;
    return true;
  }
}

describe("Codex CLI SDK", () => {
  const spawnOverride = (_command: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ cwd: options.cwd as string | undefined, args });
    const child = new MockChild();
    queueMicrotask(() => child.emit("exit", nextExitCode, null));
    return child as any;
  };

  async function importSdk() {
    return import(`../../providers/codex-cli-sdk.ts?test=${Date.now()}-${Math.random()}`);
  }

  test("distinguishes transient reconnect progress from terminal stream errors", async () => {
    const { parseCodexReconnectNotice } = await importSdk();
    expect(parseCodexReconnectNotice("Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)"))
      .toMatchObject({ attempt: 2, maxAttempts: 5 });
    expect(parseCodexReconnectNotice("stream disconnected before completion: websocket closed by server"))
      .toBeNull();
    expect(parseCodexReconnectNotice("Reconnecting... 5/5 (stream disconnected before completion: websocket closed by server before response.completed)"))
      .toMatchObject({ attempt: 5, maxAttempts: 5 });
    expect(parseCodexReconnectNotice("Reconnecting... 2/5 (unexpected status 404 Not Found: Unknown error, url: wss://chatgpt.com/backend-api/codex/responses)"))
      .toMatchObject({ attempt: 2, maxAttempts: 5 });
    expect(parseCodexReconnectNotice("Reconnecting... 2/5 without a reason"))
      .toBeNull();
  });

  test("spawns Codex in the requested working directory", async () => {
    spawnCalls.length = 0;
    nextExitCode = 0;

    const { Codex } = await importSdk();
    const codex = new Codex({ codexPathOverride: "codex", spawnOverride });
    const thread = codex.startThread({ workingDirectory: TEST_WORKSPACE });

    const { events } = await thread.runStreamed("hello");
    for await (const _event of events) {
      // no-op
    }

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.cwd).toBe(TEST_WORKSPACE);
    expect(spawnCalls[0]?.args).toContain("--cd");
    expect(spawnCalls[0]?.args).toContain(TEST_WORKSPACE);
  });

  test("passes enabled feature flags to Codex", async () => {
    spawnCalls.length = 0;
    nextExitCode = 0;

    const { Codex } = await importSdk();
    const codex = new Codex({ codexPathOverride: "codex", spawnOverride });
    const thread = codex.startThread({ enableFeatures: ["goals"] });

    const { events } = await thread.runStreamed("hello");
    for await (const _event of events) {
      // no-op
    }

    expect(spawnCalls[0]?.args).toContain("--enable");
    expect(spawnCalls[0]?.args).toContain("goals");
  });

  test("reports child process spawn and exit hooks", async () => {
    const observed: string[] = [];
    nextExitCode = 0;

    const { Codex } = await importSdk();
    const codex = new Codex({
      codexPathOverride: "codex",
      spawnOverride,
      onSpawn: (pid: number) => observed.push(`spawn:${pid}`),
      onExit: (pid: number) => observed.push(`exit:${pid}`),
    });
    const thread = codex.startThread({ workingDirectory: TEST_WORKSPACE });

    const { events } = await thread.runStreamed("hello");
    for await (const _event of events) {
      // no-op
    }

    expect(observed).toEqual(["spawn:12345", "exit:12345"]);
  });

  test("passes local image inputs to Codex CLI", async () => {
    spawnCalls.length = 0;
    nextExitCode = 0;

    const { Codex } = await importSdk();
    const codex = new Codex({ codexPathOverride: "codex", spawnOverride });
    const thread = codex.startThread({ workingDirectory: TEST_WORKSPACE });

    const { events } = await thread.runStreamed([
      { type: "text", text: "describe this" },
      { type: "local_image", path: "C:\\tmp\\image.png" },
    ]);
    for await (const _event of events) {
      // no-op
    }

    expect(spawnCalls[0]?.args).toContain("--image");
    expect(spawnCalls[0]?.args).toContain("C:\\tmp\\image.png");
  });

  test("surfaces signal abortion as AbortError", async () => {
    nextExitCode = 1;

    const { Codex } = await importSdk();
    const codex = new Codex({ codexPathOverride: "codex", spawnOverride });
    const thread = codex.startThread({ workingDirectory: TEST_WORKSPACE });
    const abortController = new AbortController();
    abortController.abort();

    const { events } = await thread.runStreamed("hello", { signal: abortController.signal });

    await expect((async () => {
      for await (const _event of events) {
        // no-op
      }
    })()).rejects.toMatchObject({ name: "AbortError" });
  });
});
