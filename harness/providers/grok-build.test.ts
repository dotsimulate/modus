import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testRoot = mkdtempSync(join(tmpdir(), "modus-grok-provider-"));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Grok provider event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Grok Build ACP provider", () => {
  test("selects profile-supplied XAI auth over a cached login", async () => {
    const { grokBuildEnvironment, selectGrokBuildAuthMethod } = await import("./grok-build-runtime");
    const initialized = {
      authMethods: [{ id: "cached_token" }, { id: "xai.api_key" }],
      _meta: { defaultAuthMethodId: "cached_token" },
    };
    const env = grokBuildEnvironment({ XAI_API_KEY: "profile-only-key" });
    expect(selectGrokBuildAuthMethod(initialized, env)).toBe("xai.api_key");
    expect(selectGrokBuildAuthMethod(initialized, {})).toBe("cached_token");
  });

  test("resolves MCP secret references without exposing the configured marker", async () => {
    const { resolveGrokBuildMcpValue } = await import("./grok-build");
    const variable = "MODUS_GROK_MCP_TEST_CANARY";
    const resolver = (name: string) => name === variable ? "resolved-secret-value" : undefined;
    expect(resolveGrokBuildMcpValue(`$${variable}`, resolver)).toBe("resolved-secret-value");
    expect(resolveGrokBuildMcpValue("literal-value", resolver)).toBe("literal-value");
    expect(resolveGrokBuildMcpValue("$MODUS_GROK_MCP_MISSING_CANARY", resolver)).toBeUndefined();
  });

  test("distinguishes an aborted Grok client generation from its replacement", async () => {
    const { ownsGrokClientGeneration } = await import("./grok-build");
    const oldClient = {};
    const replacementClient = {};
    const oldAbort = new AbortController();
    const replacementAbort = new AbortController();
    expect(ownsGrokClientGeneration(oldClient, oldAbort, oldClient, oldAbort)).toBe(true);
    expect(ownsGrokClientGeneration(replacementClient, replacementAbort, oldClient, oldAbort)).toBe(false);
  });

  test("is registered and discovers models through ACP initialization", async () => {
    const fixture = join(import.meta.dir, "fixtures", "fake-grok-acp.ts");
    const command = { executable: process.execPath, prefixArgs: [fixture] };
    const [{ isKnownProvider, listProviders, getProviderCapabilities }, { probeGrokBuildModels }] = await Promise.all([
      import("./registry"),
      import("./grok-build-runtime"),
    ]);
    expect(isKnownProvider("grok-build")).toBe(true);
    expect(listProviders()).toContain("grok-build");
    expect(getProviderCapabilities("grok-build")).toMatchObject({ name: "grok-build", family: "grok-build", supportsMcp: true });
    expect(await probeGrokBuildModels(command)).toEqual([
      { id: "grok-test", owned_by: "xai", contextSource: "provider-default" },
    ]);
  });

  test("streams a turn, bridges permission approval, and records usage", async () => {
    const { createGrokBuildProvider } = await import("./grok-build");
    const fixture = join(import.meta.dir, "fixtures", "fake-grok-acp.ts");
    const provider = createGrokBuildProvider({ command: { executable: process.execPath, prefixArgs: [fixture] } });
    const events: any[] = [];
    const updates: any[] = [];
    const session: any = {
      sessionId: "modus-test-session",
      tempId: "modus-test-session",
      providerSessionId: null,
      status: "starting",
      profile: undefined,
      provider: "grok-build",
      model: "grok-test",
      seq: 0,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      costUsd: 0,
      numTurns: 0,
      exchangeCount: 0,
      error: null,
      preview: "test prompt",
      lastAssistantText: "",
      liveStream: { text: "", thinking: "", feed: "", seq: 0 },
      pendingAssistantTurn: null,
      initialPrompt: "test prompt",
      initialContent: "test prompt",
      subscribers: new Set(),
      abortController: new AbortController(),
      dispatchState: "idle",
      pendingDispatch: [],
      turnStartedAt: Date.now(),
      cwd: testRoot,
      additionalDirectories: [],
      pauseRequested: false,
      pauseResolver: null,
      pendingPermissions: new Map(),
      sessionApprovals: new Set(),
      watchers: new Set(),
      osPids: new Set(),
      _provider: provider,
      _providerState: null,
      _configOverrides: {},
    };
    const ctx: any = {
      session,
      opts: {
        prompt: "test prompt",
        provider: "grok-build",
        model: "grok-test",
        cwd: testRoot,
        permissionPolicy: "ask",
      },
      profile: undefined,
      emitEvent(event: any) { events.push(event); },
      broadcastEvent(event: any) { events.push(event); },
      rekeySession() {},
      setProviderSessionId(id: string) { session.providerSessionId = id; },
      notifyConfigChange() {},
      updateSessionDb(update: any) { updates.push(update); },
    };

    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.subtype === "permission_request"));
    const request = events.find((event) => event.subtype === "permission_request");
    session.sessionApprovals.add(request.toolName);
    session.pendingPermissions.get(request.requestId).resolve({ behavior: "allow" });
    await waitFor(() => events.some((event) => event.type === "result" && event.subtype === "success"));

    expect(session.providerSessionId).toBe("fake-grok-session");
    expect(events.some((event) => event.type === "stream_event" && event.fullText === "hello world")).toBe(true);
    expect(events.some((event) => event.message?.content?.[0]?.type === "thinking")).toBe(true);
    expect(events.some((event) => event.message?.content?.[0]?.type === "tool_use")).toBe(true);
    expect(events.some((event) => event.subtype === "tool_result")).toBe(true);
    const result = events.find((event) => event.type === "result" && event.subtype === "success");
    expect(result).toMatchObject({ result: "hello world", input_tokens: 11, output_tokens: 7, total_tokens: 18, total_cost_usd: 0.001 });
    expect(updates.at(-1)).toMatchObject({ status: "idle", costUsd: 0.001, lastResponse: "hello world" });
    expect(session.status).toBe("idle");

    await provider.dispose?.(session);
    await waitFor(() => session.osPids.size === 0);
  });
});
