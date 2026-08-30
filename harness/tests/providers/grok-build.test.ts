import { resolve as resolveTestSourceDir } from "node:path";
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
    const { grokBuildEnvironment, selectGrokBuildAuthMethod } = await import("../../providers/grok-build-runtime");
    const initialized = {
      authMethods: [{ id: "cached_token" }, { id: "xai.api_key" }],
      _meta: { defaultAuthMethodId: "cached_token" },
    };
    const env = grokBuildEnvironment({ XAI_API_KEY: "profile-only-key" });
    expect(selectGrokBuildAuthMethod(initialized, env)).toBe("xai.api_key");
    expect(selectGrokBuildAuthMethod(initialized, {})).toBe("cached_token");
  });

  test("resolves MCP secret references without exposing the configured marker", async () => {
    const { resolveGrokBuildMcpValue } = await import("../../providers/grok-build");
    const variable = "MODUS_GROK_MCP_TEST_CANARY";
    const resolver = (name: string) => name === variable ? "resolved-secret-value" : undefined;
    expect(resolveGrokBuildMcpValue(`$${variable}`, resolver)).toBe("resolved-secret-value");
    expect(resolveGrokBuildMcpValue("literal-value", resolver)).toBe("literal-value");
    expect(resolveGrokBuildMcpValue("$MODUS_GROK_MCP_MISSING_CANARY", resolver)).toBeUndefined();
  });

  test("distinguishes an aborted Grok client generation from its replacement", async () => {
    const { ownsGrokClientGeneration } = await import("../../providers/grok-build");
    const oldClient = {};
    const replacementClient = {};
    const oldAbort = new AbortController();
    const replacementAbort = new AbortController();
    expect(ownsGrokClientGeneration(oldClient, oldAbort, oldClient, oldAbort)).toBe(true);
    expect(ownsGrokClientGeneration(replacementClient, replacementAbort, oldClient, oldAbort)).toBe(false);
  });

  test("normalizes use_tool modus_submit into a Claude-shaped tool call", async () => {
    const { normalizeGrokToolCall } = await import("../../providers/grok-build");
    expect(normalizeGrokToolCall({
      toolCallId: "c1",
      name: "use_tool",
      rawInput: {
        tool_name: "modus__modus_submit",
        tool_input: { token: "mapi-html-1", data: '{"op":"show","path":"a.html"}' },
      },
    })).toEqual({
      name: "modus_submit",
      input: { token: "mapi-html-1", data: '{"op":"show","path":"a.html"}' },
    });
    expect(normalizeGrokToolCall({
      toolCallId: "c2",
      name: "read_file",
      rawInput: { target_file: "x.ts" },
    })).toEqual({
      name: "read_file",
      input: { target_file: "x.ts" },
    });
  });

  test("peels MCP OkayOutput and byte-array Bash envelopes from tool results", async () => {
    const { normalizeGrokToolOutput } = await import("../../providers/grok-build");
    expect(normalizeGrokToolOutput({
      type: "MCP",
      tool_name: "modus_submit",
      output: { OkayOutput: "Opening a.html\n```json\n{\n  \"path\": \"a.html\"\n}\n```" },
    })).toBe("Opening a.html\n```json\n{\n  \"path\": \"a.html\"\n}\n```");
    expect(normalizeGrokToolOutput({
      type: "Bash",
      output: [104, 105, 10],
    })).toBe("hi\n");
  });

  test("reports a missing CLI as a durable error rather than a live-only result", async () => {
    const { createGrokBuildProvider, GROK_BUILD_CLI_MISSING } = await import("../../providers/grok-build");
    const provider = createGrokBuildProvider({ resolveCommand: () => null });
    const emitted: any[] = [];
    const broadcast: any[] = [];
    const session: any = {
      sessionId: "modus-grok-missing-cli",
      status: "starting",
      error: null,
      abortController: new AbortController(),
    };
    const ctx: any = {
      session,
      opts: {},
      profile: undefined,
      emitEvent(event: any) { emitted.push(event); },
      broadcastEvent(event: any) { broadcast.push(event); },
    };

    provider.startTurn(ctx);

    // `type: "error"` is the shape the session manager promotes to a persisted
    // system message; a `result`/`error` pair would reach live subscribers only,
    // and a pre-flight failure has none yet.
    expect(broadcast).toEqual([{ type: "error", error: GROK_BUILD_CLI_MISSING }]);
    expect(emitted.some((event) => event.type === "result")).toBe(false);
    expect(emitted.at(-1)).toEqual({ type: "done" });
    expect(session.status).toBe("error");
    expect(session.error).toBe(GROK_BUILD_CLI_MISSING);
    // The remedy for the common cause — a PATH the running app has not picked
    // up yet — has to be in the text, since this string is the whole diagnosis.
    expect(GROK_BUILD_CLI_MISSING).toContain("restart Modus");
    expect(GROK_BUILD_CLI_MISSING).toContain("MODUS_GROK_CLI");
  });

  test("is registered and discovers models through ACP initialization", async () => {
    const fixture = join(import.meta.dir, "..", "fixtures", "providers", "fake-grok-acp.ts");
    const command = { executable: process.execPath, prefixArgs: [fixture] };
    const [{ isKnownProvider, listProviders, getProviderCapabilities }, { probeGrokBuildModels }] = await Promise.all([
      import("../../providers/registry"),
      import("../../providers/grok-build-runtime"),
    ]);
    expect(isKnownProvider("grok-build")).toBe(true);
    expect(listProviders()).toContain("grok-build");
    expect(getProviderCapabilities("grok-build")).toMatchObject({ name: "grok-build", family: "grok-build", supportsMcp: true });
    expect(await probeGrokBuildModels(command)).toEqual([
      { id: "grok-test", owned_by: "xai", contextSource: "provider-default" },
    ]);
  });

  test("streams a turn, bridges permission approval, and records usage", async () => {
    const { createGrokBuildProvider } = await import("../../providers/grok-build");
    const fixture = join(import.meta.dir, "..", "fixtures", "providers", "fake-grok-acp.ts");
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
    const init = events.find((event) => event.subtype === "init");
    expect(init?.session_id).toBe("modus-test-session");
    expect(init?.session_id).not.toBe(session.providerSessionId);
    expect(events.some((event) => event.type === "stream_event" && event.fullText === "hello world")).toBe(true);
    expect(events.some((event) => event.message?.content?.[0]?.type === "thinking")).toBe(true);
    expect(events.some((event) => event.message?.content?.[0]?.type === "tool_use")).toBe(true);
    expect(events.some((event) => event.subtype === "tool_result")).toBe(true);
    const result = events.find((event) => event.type === "result" && event.subtype === "success");
    expect(result).toMatchObject({ result: "hello world", input_tokens: 11, output_tokens: 7, total_tokens: 18, total_cost_usd: 0.001 });
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "idle", costUsd: 0.001, lastResponse: "hello world" });
    expect(session.status).toBe("idle");

    await provider.dispose?.(session);
    await waitFor(() => session.osPids.size === 0);
  });
});
