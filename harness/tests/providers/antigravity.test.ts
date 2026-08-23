import { resolve as resolveTestSourceDir } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  antigravityAuthFromModelsResult,
  parseAntigravityModels,
  resolveAntigravityExecutable,
} from "../../providers/antigravity-cli-runtime";
import { antigravityPluginFiles } from "../../providers/antigravity-plugin";
import { buildAntigravityArgs, createAntigravityProvider } from "../../providers/antigravity";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeSession() {
  return {
    sessionId: `antigravity-test-${crypto.randomUUID()}`,
    tempId: "antigravity-test",
    providerSessionId: null,
    status: "starting",
    profile: undefined,
    provider: "antigravity",
    model: "Gemini 3.5 Flash",
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
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    additionalDirectories: [join(process.cwd(), "shared")],
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

function makeContext(session: any, events: any[], broadcasts: any[]) {
  return {
    session,
    opts: {
      prompt: session.initialContent,
      cwd: session.cwd,
      provider: "antigravity",
      model: session.model,
      additionalDirectories: session.additionalDirectories,
      permissionPolicy: "bypass",
    },
    profile: undefined,
    emitEvent(event: any) { events.push(event); },
    broadcastEvent(event: any) { broadcasts.push(event); },
    rekeySession(newId: string) { session.sessionId = newId; },
    setProviderSessionId(providerSessionId: string) { session.providerSessionId = providerSessionId; },
    notifyConfigChange() {},
    updateSessionDb(updates: any) { if (updates.status) session.status = updates.status; },
  } as any;
}

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error("test condition timed out");
}

describe("Antigravity CLI runtime", () => {
  test("resolves only an explicit agy executable override", () => {
    const dir = join(tmpdir(), `modus-agy-resolve-${crypto.randomUUID()}`);
    cleanup.push(dir);
    mkdirSync(dir, { recursive: true });
    const executable = join(dir, process.platform === "win32" ? "agy.exe" : "agy");
    writeFileSync(executable, "probe", "utf8");
    expect(resolveAntigravityExecutable({
      env: { ANTIGRAVITY_CLI_PATH: executable },
      which: () => null,
    })).toBe(executable);
  });

  test("finds the documented Windows user-local installation outside the active PATH", () => {
    const localAppData = join(tmpdir(), `modus-agy-local-${crypto.randomUUID()}`);
    cleanup.push(localAppData);
    const executable = join(localAppData, "agy", "bin", "agy.exe");
    mkdirSync(join(localAppData, "agy", "bin"), { recursive: true });
    writeFileSync(executable, "probe", "utf8");
    expect(resolveAntigravityExecutable({
      env: { LOCALAPPDATA: localAppData },
      platform: "win32",
      home: join(localAppData, "no-home-fallback"),
      which: () => null,
    })).toBe(executable);
  });

  test("distinguishes authenticated model output from sign-in output", () => {
    expect(antigravityAuthFromModelsResult({
      exitCode: 0,
      stdout: "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n",
      stderr: "",
      timedOut: false,
    })).toEqual({ authenticated: false, detail: "run `agy` once to sign in" });
    expect(antigravityAuthFromModelsResult({
      exitCode: 0,
      stdout: "Gemini 3.5 Flash\nGemini 3.1 Pro\n",
      stderr: "",
      timedOut: false,
    }).authenticated).toBe(true);
    expect(parseAntigravityModels("Gemini 3.5 Flash (default)\nGemini 3.1 Pro (high)\nGemini 3.1 Pro (low)\n").map((model) => model.id))
      .toEqual(["Gemini 3.5 Flash", "Gemini 3.1 Pro (high)", "Gemini 3.1 Pro (low)"]);
  });

  test("builds documented headless resume, model, directory, mode, and sandbox flags", () => {
    expect(buildAntigravityArgs({
      prompt: "continue",
      conversationId: "11111111-1111-4111-8111-111111111111",
      model: "Gemini 3.1 Pro",
      additionalDirectories: ["C:\\shared"],
      sandbox: true,
      mode: "plan",
      printTimeout: "2h",
    })).toEqual([
      "--print", "continue",
      "--print-timeout", "2h",
      "--conversation", "11111111-1111-4111-8111-111111111111",
      "--model", "Gemini 3.1 Pro",
      "--add-dir", "C:\\shared",
      "--mode", "plan",
      "--sandbox=true",
    ]);
  });

  test("generates a documented hooks and MCP plugin without Gemini OAuth reuse", () => {
    const files = antigravityPluginFiles({
      bunPath: process.platform === "win32" ? "C:\\Program Files\\Bun\\bun.exe" : "/usr/bin/bun",
      providersDir: process.platform === "win32" ? "C:\\modus\\providers" : "/modus/providers",
    });
    expect(Object.keys(files).sort()).toEqual(["hooks.json", "mcp_config.json", "plugin.json"]);
    expect(files["hooks.json"]).toContain("PreToolUse");
    expect(files["hooks.json"]).toContain("PostToolUse");
    expect(files["mcp_config.json"]).toContain("modus_profile_tools");
    expect(JSON.stringify(files)).not.toContain("oauth_creds.json");
  });

  test("does not inject a legacy profile-instructions file through PreInvocation", async () => {
    const ipcDir = join(tmpdir(), `modus-agy-hook-${crypto.randomUUID()}`);
    cleanup.push(ipcDir);
    mkdirSync(ipcDir, { recursive: true });
    writeFileSync(join(ipcDir, "profile-instructions.json"), JSON.stringify({ text: "Use the project conventions." }), "utf8");
    const proc = Bun.spawn({
      cmd: [process.execPath, join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "antigravity-hook.ts"), "pre-invocation"],
      env: { ...process.env, MODUS_ANTIGRAVITY_HOOK_DIR: ipcDir },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify({
      conversationId: "11111111-1111-4111-8111-111111111111",
      invocationNum: 0,
      initialNumSteps: 1,
    }));
    proc.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("starts the profile MCP fan-in bridge over stdio", async () => {
    const ipcDir = join(tmpdir(), `modus-agy-mcp-${crypto.randomUUID()}`);
    cleanup.push(ipcDir);
    mkdirSync(ipcDir, { recursive: true });
    const configPath = join(ipcDir, "mcp-servers.json");
    writeFileSync(configPath, "{}", "utf8");
    const client = new Client({ name: "modus-antigravity-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "antigravity-mcp-bridge.ts")],
      env: { ...process.env as Record<string, string>, MODUS_ANTIGRAVITY_MCP_CONFIG_PATH: configPath },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe("Antigravity provider", () => {
  test("does not advertise undocumented programmatic branch or workspace rewind", () => {
    const provider = createAntigravityProvider();
    expect(provider.previewWorkspaceRewind).toBeUndefined();
    expect(provider.applyWorkspaceRewind).toBeUndefined();
    expect((provider as any).branchSession).toBeUndefined();
  });

  test("maps the documented hook conversation ID and tool lifecycle into Modus events", async () => {
    const nativeId = "22222222-2222-4222-8222-222222222222";
    const captured: any[] = [];
    const provider = createAntigravityProvider({
      resolveExecutable: () => "agy-test",
      ensurePlugin: async () => {},
      hookPollMs: 5,
      spawn(options) {
        captured.push(options);
        const hookDir = options.env.MODUS_ANTIGRAVITY_HOOK_DIR;
        const hookEvents = [
          { kind: "pre-invocation", input: { conversationId: nativeId, invocationNum: 0 } },
          {
            kind: "pre-tool",
            requestId: "perm-test",
            input: { conversationId: nativeId, stepIdx: 1, toolCall: { name: "view_file", args: { AbsolutePath: "README.md" } } },
          },
          { kind: "post-tool", input: { conversationId: nativeId, stepIdx: 1, error: "" } },
          { kind: "stop", input: { conversationId: nativeId, fullyIdle: true } },
        ];
        writeFileSync(join(hookDir, "events.jsonl"), `${hookEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
        return { pid: 4242, stdout: textStream("done"), stderr: textStream(""), exited: Promise.resolve(0), kill() {} };
      },
    });
    const session = makeSession();
    const events: any[] = [];
    const broadcasts: any[] = [];
    provider.startTurn(makeContext(session, events, broadcasts));
    await waitFor(() => events.some((event) => event.type === "result"));

    expect(session.providerSessionId).toBe(nativeId);
    expect(session.sessionId).toStartWith("antigravity-test-");
    expect(session.status).toBe("idle");
    expect(events.some((event) => event.message?.content?.[0]?.type === "tool_use" && event.message.content[0].name === "view_file")).toBe(true);
    expect(events.some((event) => event.subtype === "tool_result")).toBe(true);
    expect(events.some((event) => event.type === "assistant" && event.message?.content?.[0]?.text === "done")).toBe(true);
    expect(captured[0].cmd).toContain("--print");
    expect(captured[0].cmd).toContain("--add-dir");
    expect(existsSync(captured[0].env.MODUS_ANTIGRAVITY_HOOK_DIR)).toBe(false);
  });

  test("interrupt kills the active agy process and returns the session to idle", async () => {
    let killed = false;
    let finish!: (code: number) => void;
    let closeStdout!: () => void;
    let closeStderr!: () => void;
    const exited = new Promise<number>((resolve) => { finish = resolve; });
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { closeStdout = () => controller.close(); } });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { closeStderr = () => controller.close(); } });
    const provider = createAntigravityProvider({
      resolveExecutable: () => "agy-test",
      ensurePlugin: async () => {},
      hookPollMs: 5,
      spawn() {
        return {
          pid: 4343,
          stdout,
          stderr,
          exited,
          kill() {
            if (killed) return;
            killed = true;
            closeStdout();
            closeStderr();
            finish(130);
          },
        };
      },
    });
    const session = makeSession();
    const events: any[] = [];
    provider.startTurn(makeContext(session, events, []));
    await waitFor(() => session._providerState?.proc != null);
    provider.abort(session);
    await waitFor(() => session.status === "idle" && events.some((event) => event.type === "done"));
    expect(killed).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  test("interrupt during plugin setup never launches agy", async () => {
    let finishSetup!: () => void;
    const setup = new Promise<void>((resolve) => { finishSetup = resolve; });
    let spawned = false;
    const provider = createAntigravityProvider({
      resolveExecutable: () => "agy-test",
      ensurePlugin: () => setup,
      spawn() {
        spawned = true;
        return { stdout: textStream(""), stderr: textStream(""), exited: Promise.resolve(0), kill() {} };
      },
    });
    const session = makeSession();
    const events: any[] = [];
    provider.startTurn(makeContext(session, events, []));
    await waitFor(() => session._providerState != null);
    provider.abort(session);
    finishSetup();
    await waitFor(() => session.status === "idle" && events.some((event) => event.type === "done"));
    expect(spawned).toBe(false);
  });
});
