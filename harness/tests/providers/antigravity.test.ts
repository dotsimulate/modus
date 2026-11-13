import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ANTIGRAVITY_STRIPPED_ENV,
  ANTIGRAVITY_VERIFICATION_MESSAGE,
  antigravityBaseModels,
  antigravityEnvironment,
  disableLegacyModusPlugin,
  isAntigravityVerificationNotice,
  legacyPluginEnabled,
  probeAntigravity,
  resetAntigravityProbeCacheForTests,
  resetLegacyPluginCleanupForTests,
  resolveAntigravityExecutable,
  resolveAntigravityModelId,
  type AntigravityCommandResult,
} from "../../providers/antigravity-runtime";
import {
  ANTIGRAVITY_CLI_MISSING,
  antigravityLaunchArgs,
  antigravityToolOutput,
  createAntigravityProvider,
  normalizeAntigravityToolCall,
} from "../../providers/antigravity";

const testRoot = mkdtempSync(join(tmpdir(), "modus-antigravity-provider-"));
const fixture = join(import.meta.dir, "..", "fixtures", "providers", "fake-agy-acp.ts");
const fixtureCommand = { executable: process.execPath, prefixArgs: [fixture] };
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Antigravity provider event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeHarness(options: {
  model?: string;
  effort?: string;
  permissionPolicy?: "ask" | "bypass";
  profile?: Record<string, unknown>;
  capture?: string;
}) {
  const provider = createAntigravityProvider({ command: fixtureCommand });
  const events: any[] = [];
  const updates: any[] = [];
  const configChanges: any[] = [];
  const session: any = {
    sessionId: `modus-antigravity-${crypto.randomUUID()}`,
    providerSessionId: null,
    status: "starting",
    provider: "antigravity",
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    costUsd: 0,
    numTurns: 0,
    exchangeCount: 0,
    error: null,
    preview: "test prompt",
    lastAssistantText: "",
    initialContent: "write the file",
    abortController: new AbortController(),
    pendingDispatch: [],
    turnStartedAt: Date.now(),
    cwd: testRoot,
    additionalDirectories: [],
    pendingPermissions: new Map(),
    sessionApprovals: new Set(),
    osPids: new Set(),
    _providerState: null,
    _configOverrides: {},
  };
  const ctx: any = {
    session,
    opts: {
      provider: "antigravity",
      cwd: testRoot,
      model: options.model,
      effort: options.effort,
      permissionPolicy: options.permissionPolicy ?? "ask",
    },
    profile: {
      description: "test",
      prompt: "",
      ...(options.profile ?? {}),
      env: options.capture ? { MODUS_AGY_CAPTURE: options.capture } : {},
    },
    emitEvent(event: any) { events.push(event); },
    broadcastEvent(event: any) { events.push(event); },
    setProviderSessionId(id: string) { session.providerSessionId = id; },
    notifyConfigChange(change: any) { configChanges.push(change); },
    updateSessionDb(update: any) { updates.push(update); },
  };
  return { provider, session, ctx, events, updates, configChanges };
}

function capturedRequests(path: string): any[] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("Antigravity runtime", () => {
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

  test("finds the Windows user-local installation outside the active PATH", () => {
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

  test("keeps inherited Google API keys and Modus credentials out of the child", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HARNESS_TOKEN: "supervisor-token",
      GEMINI_API_KEY: "stray-gemini-key",
      GOOGLE_API_KEY: "stray-google-key",
      GOOGLE_GENAI_API_KEY: "stray-genai-key",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json",
    };
    const env = antigravityEnvironment(undefined, base);
    for (const name of [...ANTIGRAVITY_STRIPPED_ENV, "HARNESS_TOKEN"]) expect(env[name]).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
    // A key the profile sets deliberately is not "stray" and is passed through.
    expect(antigravityEnvironment({ GEMINI_API_KEY: "profile-key" }, base).GEMINI_API_KEY).toBe("profile-key");
  });

  test("picks the ACP model variant for a base model and Modus effort", () => {
    const available = [
      "gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high",
      "gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh",
      "gpt-oss-120b-medium",
    ].map((modelId) => ({ modelId }));
    expect(resolveAntigravityModelId(available, "gemini-4-hydrogen", undefined)).toBe("gemini-4-hydrogen-medium");
    expect(resolveAntigravityModelId(available, "gemini-4-hydrogen", "high")).toBe("gemini-4-hydrogen-high");
    expect(resolveAntigravityModelId(available, "gemini-4-hydrogen", "max")).toBe("gemini-4-hydrogen-xhigh");
    expect(resolveAntigravityModelId(available, "gemini-4-argon", "max")).toBe("gemini-4-argon-high");
    expect(resolveAntigravityModelId(available, "gemini-4-argon", "off")).toBe("gemini-4-argon-low");
    expect(resolveAntigravityModelId(available, "gemini-4-hydrogen-low", undefined)).toBe("gemini-4-hydrogen-low");
    expect(resolveAntigravityModelId(available, "gemini-4-hydrogen-low", "high")).toBe("gemini-4-hydrogen-high");
    expect(resolveAntigravityModelId(available, "gpt-oss-120b-medium", "high")).toBe("gpt-oss-120b-medium");
    expect(resolveAntigravityModelId(available, "gemini-4-carbon", "high")).toBeUndefined();
    expect(resolveAntigravityModelId(available, undefined, "high")).toBeUndefined();
  });

  test("lists base model names from the ACP model config option", () => {
    expect(antigravityBaseModels({
      configOptions: [{ id: "model", options: [{ value: "gemini-4-argon" }, { value: "gemini-4-hydrogen" }] }],
      models: { availableModels: [{ modelId: "gemini-4-argon-medium" }] },
    }).map((model) => model.id)).toEqual(["gemini-4-argon", "gemini-4-hydrogen"]);
    expect(antigravityBaseModels({
      models: { availableModels: [{ modelId: "gemini-4-argon-medium" }, { modelId: "gemini-4-argon-medium" }] },
    }).map((model) => model.id)).toEqual(["gemini-4-argon-medium"]);
  });

  test("recognizes Google's unverified-account notice and nothing else", () => {
    expect(isAntigravityVerificationNotice("\n⚠ Verification Required\n")).toBe(true);
    expect(isAntigravityVerificationNotice("Verification Required")).toBe(true);
    expect(isAntigravityVerificationNotice("The docs say Verification Required is shown when...")).toBe(false);
  });

  test("disables the legacy Modus agy plugin once, and only when it is enabled", async () => {
    const calls: string[][] = [];
    const run = (enabled: boolean) => async (_executable: string, args: string[]): Promise<AntigravityCommandResult> => {
      calls.push(args);
      const stdout = args[1] === "list"
        ? JSON.stringify([{ name: "modus-provider", enabled }, { name: "someone-elses", enabled: true }])
        : "";
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    };
    expect(legacyPluginEnabled(JSON.stringify([{ name: "modus-provider", enabled: true }]))).toBe(true);
    expect(legacyPluginEnabled(JSON.stringify([{ name: "modus-provider", enabled: false }]))).toBe(false);
    expect(legacyPluginEnabled("not json")).toBe(false);

    resetLegacyPluginCleanupForTests();
    await disableLegacyModusPlugin("agy", run(true));
    await disableLegacyModusPlugin("agy", run(true));
    expect(calls).toEqual([["plugin", "list", "--json"], ["plugin", "disable", "modus-provider"]]);

    calls.length = 0;
    resetLegacyPluginCleanupForTests();
    await disableLegacyModusPlugin("agy", run(false));
    expect(calls).toEqual([["plugin", "list", "--json"]]);
    resetLegacyPluginCleanupForTests();
  });

  test("probes sign-in, plan tier, and base models through one throwaway ACP session", async () => {
    resetAntigravityProbeCacheForTests();
    const capture = join(testRoot, `probe-${crypto.randomUUID()}.jsonl`);
    const previous = process.env.MODUS_AGY_CAPTURE;
    process.env.MODUS_AGY_CAPTURE = capture;
    try {
      const probe = await probeAntigravity(fixtureCommand);
      expect(probe).toMatchObject({ authenticated: true, detail: "signed in (Google AI Pro)", tier: "Google AI Pro" });
      expect(probe.models.map((model) => model.id)).toEqual(["gemini-4-argon", "gemini-4-hydrogen", "gpt-oss-120b-medium"]);
      expect(await probeAntigravity(fixtureCommand)).toBe(probe);
      const methods = capturedRequests(capture).map((request) => request.method);
      expect(methods).toEqual(["initialize", "session/new", "session/close"]);
    } finally {
      if (previous === undefined) delete process.env.MODUS_AGY_CAPTURE;
      else process.env.MODUS_AGY_CAPTURE = previous;
      resetAntigravityProbeCacheForTests();
    }
  });
});

describe("Antigravity provider", () => {
  test("is registered as a standalone provider", async () => {
    const [{ isKnownProvider, listProviders, getProviderCapabilities }, { providerCliName }, { ProfileSchema }] = await Promise.all([
      import("../../providers/registry"),
      import("../../providers/provider-cli-names"),
      import("../../profile-schemas"),
    ]);
    expect(isKnownProvider("antigravity")).toBe(true);
    expect(listProviders()).toContain("antigravity");
    expect(providerCliName("antigravity")).toBe("agy");
    expect(getProviderCapabilities("antigravity")).toMatchObject({
      name: "antigravity",
      family: "antigravity",
      supportsMcp: true,
      messageDelivery: "next-turn",
    });
    expect(ProfileSchema.safeParse({
      provider: "antigravity",
      prompt: "",
      description: "Antigravity profile",
      model: "gemini-4-hydrogen",
      providerControls: { antigravity: { mode: "auto", sandbox: true } },
    }).success).toBe(true);
  });

  test("launches agy acp, adding --sandbox only when requested", () => {
    expect(antigravityLaunchArgs({})).toEqual(["acp"]);
    expect(antigravityLaunchArgs({ sandbox: true })).toEqual(["acp", "--sandbox"]);
  });

  test("normalizes MCP tool names and drops Antigravity's toolSummary", () => {
    expect(normalizeAntigravityToolCall({
      name: "mcp_modus_modus_submit",
      rawInput: { token: "mapi-x", data: "{}", toolSummary: "Show it" },
    })).toEqual({ name: "modus_submit", input: { token: "mapi-x", data: "{}" } });
    expect(normalizeAntigravityToolCall({
      name: "mcp_echo_echo",
      rawInput: { text: "ping", toolSummary: "Echo" },
    })).toEqual({ name: "mcp_echo_echo", input: { text: "ping" } });
    expect(normalizeAntigravityToolCall({
      name: "write_file",
      rawInput: { Path: "a.txt", Content: "x" },
    })).toEqual({ name: "write_file", input: { Path: "a.txt", Content: "x" } });
  });

  test("renders edit diffs as tool output and falls back to a status line", () => {
    expect(antigravityToolOutput({
      status: "completed",
      rawOutput: {},
      content: [{ type: "diff", path: "hello.txt", newText: "hydrogen\n" }],
    })).toBe("hello.txt\nhydrogen\n");
    expect(antigravityToolOutput({ status: "completed" })).toBe("tool call completed");
    expect(antigravityToolOutput({ status: "failed" })).toBe("tool call failed");
  });

  test("streams a turn, appends the profile prompt, selects the model, and bridges approval", async () => {
    const capture = join(testRoot, `turn-${crypto.randomUUID()}.jsonl`);
    const harness = makeHarness({
      model: "gemini-4-hydrogen",
      effort: "high",
      capture,
      profile: { prompt: "Keep answers concise.", promptMode: "append", providerControls: { antigravity: { mode: "default" } } },
    });
    const { provider, session, ctx, events, updates, configChanges } = harness;
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.subtype === "permission_request"));
    const request = events.find((event) => event.subtype === "permission_request");
    expect(request).toMatchObject({ toolName: "write_file", input: { Path: "hello.txt", Content: "hydrogen" } });
    session.pendingPermissions.get(request.requestId).resolve({ behavior: "allow" });
    await waitFor(() => events.some((event) => event.type === "result"));

    const requests = capturedRequests(capture);
    const created = requests.find((entry) => entry.method === "session/new");
    expect(created.params._meta).toEqual({ antigravity: { systemPrompt: { append: "Keep answers concise." } } });
    expect(created.params.mcpServers).toBeArray();
    expect(requests.find((entry) => entry.method === "session/set_mode")?.params.modeId).toBe("default");
    expect(requests.find((entry) => entry.method === "session/set_model")?.params.modelId).toBe("gemini-4-hydrogen-high");
    expect(requests.some((entry) => entry.method === "authenticate")).toBe(false);
    expect(requests.find((entry) => entry.id === "permission-1")?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });

    expect(session.providerSessionId).toBe("fake-agy-session");
    expect(events.find((event) => event.subtype === "init")).toMatchObject({
      session_id: session.sessionId,
      model: "gemini-4-hydrogen-high",
      config: { provider: "antigravity" },
    });
    expect(configChanges).toContainEqual({ providerControls: { antigravity: { mode: "default" } } });
    const durable = events
      .filter((event) => event.type === "assistant")
      .map((event) => {
        const block = event.message.content[0];
        return block.type === "thinking" ? `thinking:${block.thinking}` : block.type === "text" ? `text:${block.text}` : block.type;
      });
    expect(durable).toEqual(["thinking:planning the write", "tool_use", "text:Created hello.txt"]);
    const toolResult = events.find((event) => event.subtype === "tool_result");
    expect(toolResult.message.content[0]).toMatchObject({ tool_use_id: "call-write", content: "hello.txt\nhydrogen\n", is_error: false });
    expect(events.find((event) => event.type === "result")).toMatchObject({
      subtype: "success",
      result: "Created hello.txt",
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 212,
      total_cost_usd: 0,
    });
    expect(updates.at(-1)).toMatchObject({ status: "idle", lastResponse: "Created hello.txt" });
    expect(session.status).toBe("idle");

    await provider.dispose?.(session);
    await waitFor(() => session.osPids.size === 0);
  });

  test("auto-approves under a bypass policy without asking the user", async () => {
    const capture = join(testRoot, `bypass-${crypto.randomUUID()}.jsonl`);
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass", capture });
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    expect(events.some((event) => event.subtype === "permission_request")).toBe(false);
    expect(capturedRequests(capture).find((entry) => entry.id === "permission-1")?.result?.outcome?.optionId).toBe("allow");
    expect(capturedRequests(capture).some((entry) => entry.method === "session/set_model")).toBe(false);
    await provider.dispose?.(session);
  });

  test("passes Modus move calls through as modus_submit", async () => {
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass" });
    session.initialContent = "use the mcp tool";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    const toolUse = events.find((event) => event.message?.content?.[0]?.type === "tool_use")?.message.content[0];
    expect(toolUse).toMatchObject({ name: "modus_submit", input: { token: "mapi-test-1", data: "{\"op\":\"show\"}" } });
    expect(toolUse.input.toolSummary).toBeUndefined();
    await provider.dispose?.(session);
  });

  test("turns Google's unverified-account notice into an actionable error", async () => {
    const { provider, session, ctx, events } = makeHarness({});
    session.initialContent = "hello from an unverified account";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    expect(events.find((event) => event.type === "result")).toMatchObject({ subtype: "error", error: ANTIGRAVITY_VERIFICATION_MESSAGE });
    expect(session.status).toBe("error");
    expect(session.error).toBe(ANTIGRAVITY_VERIFICATION_MESSAGE);
    await provider.dispose?.(session);
  });

  test("reports a model the account does not offer instead of running another", async () => {
    const { provider, session, ctx, events } = makeHarness({ model: "gemini-4-carbon" });
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    const result = events.find((event) => event.type === "result");
    expect(result.subtype).toBe("error");
    expect(result.error).toContain('does not offer model "gemini-4-carbon"');
    expect(result.error).toContain("gemini-4-hydrogen-high");
    await provider.dispose?.(session);
    await waitFor(() => session.osPids.size === 0);
  });

  test("rejects a custom (replacement) profile prompt it cannot deliver", async () => {
    const { provider, session, ctx, events } = makeHarness({ profile: { prompt: "Replace everything.", promptMode: "custom" } });
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    expect(events.find((event) => event.type === "result").error).toContain("cannot deliver a custom profile prompt");
    await provider.dispose?.(session);
  });

  test("cancels a running turn through session/cancel and returns to idle", async () => {
    const capture = join(testRoot, `cancel-${crypto.randomUUID()}.jsonl`);
    const { provider, session, ctx, events } = makeHarness({ capture });
    session.initialContent = "a slow story";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "stream_event"));
    provider.abort(session);
    await waitFor(() => events.some((event) => event.type === "done"));
    expect(session.status).toBe("idle");
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(capturedRequests(capture).some((entry) => entry.method === "session/cancel")).toBe(true);
    await provider.dispose?.(session);
  });

  test("reports a missing CLI as a durable error rather than a live-only result", () => {
    const provider = createAntigravityProvider({ resolveCommand: () => null });
    const emitted: any[] = [];
    const broadcast: any[] = [];
    const session: any = { sessionId: "modus-antigravity-missing-cli", status: "starting", error: null, abortController: new AbortController() };
    provider.startTurn({
      session,
      opts: {},
      profile: undefined,
      emitEvent(event: any) { emitted.push(event); },
      broadcastEvent(event: any) { broadcast.push(event); },
    } as any);
    expect(broadcast).toEqual([{ type: "error", error: ANTIGRAVITY_CLI_MISSING }]);
    expect(emitted.at(-1)).toEqual({ type: "done" });
    expect(session.status).toBe("error");
    expect(ANTIGRAVITY_CLI_MISSING).toContain("restart Modus");
    expect(ANTIGRAVITY_CLI_MISSING).toContain("ANTIGRAVITY_CLI_PATH");
  });
});
