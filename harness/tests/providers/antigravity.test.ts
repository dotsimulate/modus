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
  ANTIGRAVITY_SANDBOX_FAILURE_NOTICE,
  ANTIGRAVITY_WAKE_PROMPT,
  antigravityLaunchArgs,
  antigravityReadImage,
  antigravityToolOutput,
  createAntigravityProvider,
  isSandboxStartFailure,
  normalizeAntigravityToolCall,
  requestsSandboxBypass,
  sandboxRequested,
  toolDecision,
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
  holdLimitMs?: number;
}) {
  const transcript = join(testRoot, `transcript-${crypto.randomUUID()}.jsonl`);
  const provider = createAntigravityProvider({
    command: fixtureCommand,
    holdLimitMs: options.holdLimitMs,
    holdPollMs: 20,
    transcriptLagMs: 200,
    idleWatchMs: 20,
    transcriptPath: () => transcript,
  });
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
      env: { MODUS_AGY_TRANSCRIPT: transcript, ...(options.capture ? { MODUS_AGY_CAPTURE: options.capture } : {}) },
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
      messageDelivery: "steer",
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

  test("serves HTTP MCP servers from a per-session worker, as the ACP guide requires", () => {
    expect(antigravityLaunchArgs({}, [{ type: "stdio" }])).toEqual(["acp"]);
    expect(antigravityLaunchArgs({}, [{ type: "stdio" }, { type: "http" }])).toEqual(["acp", "--process-per-session"]);
    expect(antigravityLaunchArgs({ sandbox: true }, [{ type: "sse" }])).toEqual(["acp", "--sandbox", "--process-per-session"]);
  });

  test("reads a Claude-named tools list through Antigravity's tool names", () => {
    const { ctx } = makeHarness({ permissionPolicy: "bypass", profile: { tools: ["Read", "Bash", "WebSearch"] } });
    expect(toolDecision(ctx, "run_command")).toBe("allow");
    expect(toolDecision(ctx, "manage_task")).toBe("allow");
    expect(toolDecision(ctx, "read_file")).toBe("allow");
    expect(toolDecision(ctx, "search_web")).toBe("allow");
    expect(toolDecision(ctx, "write_file")).toBe("deny");
    expect(toolDecision(ctx, "edit_file")).toBe("deny");
    // MCP tools are outside the built-in allowlist, as on Claude Code.
    expect(toolDecision(ctx, "mcp_echo_echo")).toBe("allow");
    expect(toolDecision(ctx, "modus_submit")).toBe("allow");
    // Native names work too, and a tool switched on overrides the list.
    ctx.session._configOverrides.toolStates = { write_file: "on", Bash: "off" };
    expect(toolDecision(ctx, "write_file")).toBe("allow");
    expect(toolDecision(ctx, "run_command")).toBe("deny");
  });

  test("applies disallowedTools and a mid-session permission policy by shared names", () => {
    const { ctx } = makeHarness({ permissionPolicy: "bypass", profile: { disallowedTools: ["Write", "mcp__echo"] } });
    expect(toolDecision(ctx, "write_file")).toBe("deny");
    expect(toolDecision(ctx, "mcp_echo_echo")).toBe("deny");
    expect(toolDecision(ctx, "mcp_other_tool")).toBe("allow");
    expect(toolDecision(ctx, "run_command")).toBe("allow");
    ctx.session._configOverrides.permissionPolicy = { default: "approve", requireApproval: ["Bash"] };
    expect(toolDecision(ctx, "run_command")).toBe("ask");
    expect(toolDecision(ctx, "read_file")).toBe("allow");
  });

  test("tells the user and the transcript why Modus blocked a tool", async () => {
    const capture = join(testRoot, `blocked-${crypto.randomUUID()}.jsonl`);
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass", capture, profile: { tools: ["Read", "Write", "Edit"] } });
    session.initialContent = "run a command";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    expect(events.some((event) => event.subtype === "permission_request")).toBe(false);
    expect(capturedRequests(capture).find((entry) => entry.id === "permission-command")?.result?.outcome?.optionId).toBe("deny");
    const notices = events.filter((event) => event.subtype === "provider_message");
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain("Modus blocked `run_command`");
    expect(notices[0].content).toContain("Read, Write, Edit");
    expect(notices[0].content).toContain("Bash or PowerShell");
    await provider.dispose?.(session);
  });

  test("reports a restricted tool Antigravity ran without asking Modus", async () => {
    const { provider, session, ctx, events } = makeHarness({
      permissionPolicy: "bypass",
      profile: { tools: ["Bash"], providerControls: { antigravity: { mode: "default" } } },
    });
    session.initialContent = "read-unasked";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    const notice = events.find((event) => event.subtype === "provider_message");
    expect(notice?.content).toContain("Antigravity ran `read_file` without asking Modus");
    expect(notice?.content).toContain("In default mode Antigravity only asks before commands and file edits.");
    await provider.dispose?.(session);
  });

  test("names a sandbox that cannot start, once per session", async () => {
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass" });
    session.initialContent = "sandbox-fail";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    provider.sendMessage(ctx, "sandbox-fail again");
    await waitFor(() => events.filter((event) => event.type === "result").length === 2);
    const notices = events.filter((event) => event.subtype === "provider_message");
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain(ANTIGRAVITY_SANDBOX_FAILURE_NOTICE);
    expect(isSandboxStartFailure({ output: "Command failed to run: exebox: creating sandbox: x" })).toBe(true);
    expect(isSandboxStartFailure("exit code 1")).toBe(false);
    await provider.dispose?.(session);
  });

  test("asks before a sandbox escape even under a bypass policy", async () => {
    const capture = join(testRoot, `escape-${crypto.randomUUID()}.jsonl`);
    const { provider, session, ctx, events } = makeHarness({
      permissionPolicy: "bypass",
      capture,
      profile: { providerControls: { antigravity: { sandbox: true } } },
    });
    session.initialContent = "bypass the sandbox";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.subtype === "permission_request"));
    const request = events.find((event) => event.subtype === "permission_request");
    expect(request).toMatchObject({ toolName: "run_command", input: { BypassSandbox: true }, interactive: true });
    session.pendingPermissions.get(request.requestId).resolve({ behavior: "deny" });
    await waitFor(() => events.some((event) => event.type === "result"));
    expect(capturedRequests(capture).find((entry) => entry.id === "permission-command")?.result?.outcome?.optionId).toBe("deny");
    expect(requestsSandboxBypass({ BypassSandbox: true })).toBe(true);
    expect(sandboxRequested({ mode: "auto" })).toBe(true);
    expect(sandboxRequested({ mode: "default" })).toBe(false);
    await provider.dispose?.(session);
  });

  test("ends a turn at maxTurns with error_max_turns", async () => {
    const capture = join(testRoot, `max-turns-${crypto.randomUUID()}.jsonl`);
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass", capture });
    ctx.opts.maxTurns = 2;
    session.initialContent = "loop forever";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    expect(events.find((event) => event.type === "result")).toMatchObject({ subtype: "error_max_turns", stop_reason: "max_turns", num_turns: 2 });
    expect(capturedRequests(capture).some((entry) => entry.method === "session/cancel")).toBe(true);
    expect(session.status).toBe("idle");
    await provider.dispose?.(session);
  });

  test("steers a running turn with a mid-turn message", async () => {
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass" });
    session.initialContent = "a steerable task";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "stream_event"));
    expect(await provider.steerMessage!(ctx, "also check the tests")).toBe(true);
    await waitFor(() => events.some((event) => event.type === "result"));
    expect(events.find((event) => event.type === "result")).toMatchObject({
      subtype: "success",
      result: "working (steered: also check the tests)",
      input_tokens: 130,
      output_tokens: 35,
    });
    expect(session.status).toBe("idle");
    expect(await provider.steerMessage!(ctx, "after the turn")).toBe(false);
    await provider.dispose?.(session);
  });

  test("falls back to the queue when Antigravity refuses a steer", async () => {
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass" });
    session.initialContent = "a nosteer task";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "stream_event"));
    expect(await provider.steerMessage!(ctx, "too late")).toBe(false);
    expect(events.some((event) => event.subtype === "provider_message")).toBe(false);
    provider.abort(session);
    await waitFor(() => events.some((event) => event.type === "done"));
    await provider.dispose?.(session);
  });

  test("prompts agy when it wakes from a background command, so its stalled work lands in the same turn", async () => {
    const capture = join(testRoot, `wake-${crypto.randomUUID()}.jsonl`);
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass", capture });
    session.initialContent = "look in the background";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.subtype === "provider_message"));
    expect(events.find((event) => event.subtype === "provider_message").content).toContain("`voro lab look scene.voro`");
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(session.status).toBe("running");
    await waitFor(() => events.some((event) => event.type === "result"));
    const results = events.filter((event) => event.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ subtype: "success", result: "waiting for it to finish then fixed the bark", input_tokens: 240 });
    const resultFor = (id: string) => events.findIndex((event) => event.subtype === "tool_result"
      && event.message.content[0].tool_use_id === id);
    // The command's result comes from agy's record, since no stream was open when it finished.
    expect(events[resultFor("call-background")].message.content[0].content).toBe("Command exited with code 0.\n\nlook done");
    const woke = events.findIndex((event) => event.subtype === "provider_message" && event.content.includes(ANTIGRAVITY_WAKE_PROMPT));
    expect(woke).toBeGreaterThan(resultFor("call-background"));
    expect(resultFor("call-after-wake")).toBeGreaterThan(woke);
    expect(events.indexOf(results[0])).toBeGreaterThan(resultFor("call-after-wake"));
    const prompts = capturedRequests(capture).filter((entry) => entry.method === "session/prompt");
    expect(prompts.map((entry) => entry.params.prompt[0].text)).toEqual(["look in the background", ANTIGRAVITY_WAKE_PROMPT]);
    expect(session.status).toBe("idle");
    await provider.dispose?.(session);
  });

  test("prompts agy when a background command's finish arrives over ACP before agy records its wake", async () => {
    const capture = join(testRoot, `wake-acp-${crypto.randomUUID()}.jsonl`);
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass", capture });
    session.initialContent = "look in the background, report over acp";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    const results = events.filter((event) => event.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ subtype: "success", result: "waiting for it to finish then fixed the bark" });
    const prompts = capturedRequests(capture).filter((entry) => entry.method === "session/prompt");
    expect(prompts.map((entry) => entry.params.prompt[0].text)).toEqual(["look in the background, report over acp", ANTIGRAVITY_WAKE_PROMPT]);
    expect(events.filter((event) => event.subtype === "tool_result"
      && event.message.content[0].tool_use_id === "call-background")).toHaveLength(1);
    const notice = events.find((event) => event.subtype === "provider_message" && event.content.includes(ANTIGRAVITY_WAKE_PROMPT));
    expect(notice.content).toContain("`voro lab look scene.voro` finished in the background");
    expect(session.status).toBe("idle");
    await provider.dispose?.(session);
  });

  test("holds on the command agy is still running, not on a finish it took in earlier in the turn", async () => {
    const capture = join(testRoot, `replay-${crypto.randomUUID()}.jsonl`);
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass", capture });
    session.initialContent = "replay the lost end";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    const resultsFor = (id: string) => events.filter((event) => event.subtype === "tool_result"
      && event.message.content[0].tool_use_id === id);
    // The three-line command gets its own output, never the earlier command's.
    expect(resultsFor("call-142")).toHaveLength(1);
    expect(resultsFor("call-142")[0].message.content[0].content).toBe("Command exited with code 0.\n\nCommand output:\n{\n \"ok\": true\n}");
    expect(resultsFor("call-75")).toHaveLength(1);
    expect(resultsFor("call-75")[0].message.content[0].content).toContain("GraphNotLoaded");
    const notices = events.filter((event) => event.subtype === "provider_message").map((event) => event.content);
    expect(notices[0]).toContain("voro lab disconnect stage/gallery.voro");
    expect(notices[0]).not.toContain("examples/09");
    expect(notices.some((content) => content.includes(ANTIGRAVITY_WAKE_PROMPT))).toBe(true);
    const prompts = capturedRequests(capture).filter((entry) => entry.method === "session/prompt");
    expect(prompts.map((entry) => entry.params.prompt[0].text)).toEqual(["replay the lost end", ANTIGRAVITY_WAKE_PROMPT]);
    const results = events.filter((event) => event.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      subtype: "success",
      result: "Waiting for 10 to render its first look. The look rendered; committed it.",
    });
    expect(session.status).toBe("idle");
    await provider.dispose?.(session);
  });

  test("opens a turn when agy wakes after Modus stopped waiting on it", async () => {
    const capture = join(testRoot, `late-${crypto.randomUUID()}.jsonl`);
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass", capture, holdLimitMs: 300 });
    session.initialContent = "look in the background after the hold";
    provider.startTurn(ctx);
    await waitFor(() => events.filter((event) => event.type === "result").length === 2);
    const results = events.filter((event) => event.type === "result");
    expect(results.map((event) => event.result)).toEqual(["waiting for it to finish", " then fixed the bark"]);
    const reopened = events.findIndex((event) => event.subtype === "provider_message"
      && event.content.startsWith("Antigravity started working again after the last turn ended"));
    expect(reopened).toBeGreaterThan(events.indexOf(results[0]));
    expect(events[reopened + 1]).toMatchObject({ type: "user", subtype: "prompt", message: { content: ANTIGRAVITY_WAKE_PROMPT } });
    const prompts = capturedRequests(capture).filter((entry) => entry.method === "session/prompt");
    expect(prompts.map((entry) => entry.params.prompt[0].text)).toEqual(["look in the background after the hold", ANTIGRAVITY_WAKE_PROMPT]);
    expect(session.status).toBe("idle");
    await provider.dispose?.(session);
  });

  test("asks the user about a write agy makes after it wakes", async () => {
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "ask" });
    session.initialContent = "look in the background";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.subtype === "permission_request"));
    expect(events.find((event) => event.subtype === "permission_request").toolName).toBe("write_file");
    const [pending] = [...session.pendingPermissions.values()];
    pending.resolve({ behavior: "allow" });
    await waitFor(() => events.some((event) => event.type === "result"));
    expect(events.find((event) => event.type === "result").result).toBe("waiting for it to finish then fixed the bark");
    await provider.dispose?.(session);
  });

  test("ends a turn held on a background command at the hold limit", async () => {
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass", holdLimitMs: 300 });
    session.initialContent = "start the server";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"), 5_000);
    const notices = events.filter((event) => event.subtype === "provider_message").map((event) => event.content);
    expect(notices.some((content) => content.startsWith("Modus stopped waiting on `npm run dev`"))).toBe(true);
    expect(events.find((event) => event.type === "result")).toMatchObject({ subtype: "success", result: "waiting for it to finish" });
    expect(session.status).toBe("idle");
    await provider.dispose?.(session);
  });

  test("a queued message ends the wait on a background command that never finishes", async () => {
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass" });
    session.initialContent = "start the server";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.subtype === "provider_message"));
    provider.sendMessage(ctx, "read-unasked");
    await waitFor(() => events.filter((event) => event.type === "result").length === 2);
    expect(events.filter((event) => event.type === "result").map((event) => event.result))
      .toEqual(["waiting for it to finish", "read it"]);
    expect(session.status).toBe("idle");
    await provider.dispose?.(session);
  });

  test("stopping a turn held on a background command returns it to idle", async () => {
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass" });
    session.initialContent = "start the server";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.subtype === "provider_message"));
    provider.abort(session);
    await waitFor(() => events.some((event) => event.type === "done"));
    expect(session.status).toBe("idle");
    expect(events.some((event) => event.type === "result")).toBe(false);
    await provider.dispose?.(session);
  });

  test("applies tool and turn-limit changes without relaunching agy", async () => {
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass" });
    session.initialContent = "read-unasked";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    provider.updateConfig!(session, { tools: ["Read"], toolStates: { Bash: "off" }, maxTurns: 3 });
    expect(session._providerState.restartBeforeNextTurn).toBe(false);
    provider.updateConfig!(session, { providerControls: { antigravity: { sandbox: true } } });
    expect(session._providerState.restartBeforeNextTurn).toBe(true);
    await provider.dispose?.(session);
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

  test("shows the picture agy read, which ACP does not send", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
    writeFileSync(join(testRoot, "look.png"), png);
    const { provider, session, ctx, events } = makeHarness({ permissionPolicy: "bypass" });
    session.initialContent = "read-image";
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    const result = events.find((event) => event.subtype === "tool_result"
      && event.message.content[0].tool_use_id === "call-read-image");
    expect(result.message.content[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
    ]);
    await provider.dispose?.(session);
  });

  test("loads only image files within the size limit for a read", () => {
    const dir = mkdtempSync(join(testRoot, "read-image-"));
    writeFileSync(join(dir, "a.JPG"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    writeFileSync(join(dir, "notes.txt"), "text");
    writeFileSync(join(dir, "big.png"), Buffer.alloc(64, 1));
    expect(antigravityReadImage({ Path: join(dir, "a.JPG") }, testRoot)).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64") },
    });
    expect(antigravityReadImage({ Path: "a.JPG" }, dir)).not.toBeNull();
    expect(antigravityReadImage({ Path: join(dir, "notes.txt") }, dir)).toBeNull();
    expect(antigravityReadImage({ Path: join(dir, "missing.png") }, dir)).toBeNull();
    expect(antigravityReadImage({ Path: join(dir, "big.png") }, dir, 32)).toBeNull();
    expect(antigravityReadImage({}, dir)).toBeNull();
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
