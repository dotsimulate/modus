import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testRoot = mkdtempSync(join(tmpdir(), "modus-muse-provider-"));
const fixture = join(import.meta.dir, "..", "fixtures", "providers", "fake-muse-msp.ts");
const command = { executable: process.execPath, prefixArgs: [fixture] };

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Muse provider event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function frames(capture: string): any[] {
  if (!existsSync(capture)) return [];
  return readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function harness(provider: any, name: string, opts: Record<string, unknown>, profile?: any) {
  const events: any[] = [];
  const updates: any[] = [];
  const session: any = {
    sessionId: `modus-muse-${name}`,
    providerSessionId: null,
    status: "starting",
    provider: "muse-code",
    costUsd: 0,
    numTurns: 0,
    exchangeCount: 0,
    error: null,
    preview: "test prompt",
    lastAssistantText: "",
    initialContent: opts.prompt ?? "test prompt",
    abortController: new AbortController(),
    pendingDispatch: [],
    turnStartedAt: Date.now(),
    lastEventAt: Date.now(),
    cwd: testRoot,
    additionalDirectories: [],
    pendingPermissions: new Map(),
    sessionApprovals: new Set(),
    osPids: new Set(),
    _provider: provider,
    _providerState: null,
    _configOverrides: {},
  };
  const ctx: any = {
    session,
    opts: { cwd: testRoot, ...opts },
    profile,
    emitEvent(event: any) { events.push(event); },
    broadcastEvent(event: any) { events.push(event); },
    rekeySession() {},
    setProviderSessionId(id: string) { session.providerSessionId = id; },
    notifyConfigChange() {},
    updateSessionDb(update: any) { updates.push(update); },
  };
  return { events, updates, session, ctx };
}

describe("Muse Code MSP provider", () => {
  test("mints UUIDv7 command ids", async () => {
    const { museCommandId } = await import("../../providers/muse-code-runtime");
    const id = museCommandId(0x0198f0ab9999);
    expect(id).toMatch(/^0198f0ab-9999-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(museCommandId()).not.toBe(museCommandId());
  });

  test("maps Modus effort onto the MSP reasoning tiers", async () => {
    const { museReasoningEffort } = await import("../../providers/muse-code");
    expect(museReasoningEffort("off")).toBe("none");
    expect(museReasoningEffort("xhigh")).toBe("xhigh");
    expect(museReasoningEffort("max")).toBe("max");
    expect(museReasoningEffort(undefined)).toBeUndefined();
  });

  test("is registered, steerable, and lists models without opening a session", async () => {
    const capture = join(testRoot, "models.ndjson");
    process.env.MODUS_MUSE_CAPTURE = capture;
    const [{ isKnownProvider, listProviders, getProviderCapabilities }, { probeMuseCodeModels }] = await Promise.all([
      import("../../providers/registry"),
      import("../../providers/muse-code-runtime"),
    ]);
    try {
      expect(isKnownProvider("muse-code")).toBe(true);
      expect(listProviders()).toContain("muse-code");
      expect(getProviderCapabilities("muse-code")).toMatchObject({
        name: "muse-code", family: "muse-code", supportsMcp: true, messageDelivery: "steer",
      });
      expect(await probeMuseCodeModels(command)).toEqual([
        { id: "muse-test", owned_by: "meta", contextWindow: 1_000_000, maxOutputTokens: 64_000, contextSource: "api" },
      ]);
      expect(frames(capture).map((frame) => frame.method)).toEqual(["initialize", "initialized", "model/list"]);
    } finally {
      delete process.env.MODUS_MUSE_CAPTURE;
    }
  }, 30_000);

  test("reports a missing CLI as a durable error rather than a live-only result", async () => {
    const { createMuseCodeProvider, MUSE_CODE_CLI_MISSING } = await import("../../providers/muse-code");
    const provider = createMuseCodeProvider({ resolveCommand: () => null });
    const { events, session, ctx } = harness(provider, "missing-cli", {});
    provider.startTurn(ctx);
    expect(events[0]).toEqual({ type: "error", error: MUSE_CODE_CLI_MISSING });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(session.status).toBe("error");
    expect(MUSE_CODE_CLI_MISSING).toContain("MODUS_MUSE_CLI");
  });

  test("refuses a profile prompt it has no channel to deliver", async () => {
    const { createMuseCodeProvider } = await import("../../providers/muse-code");
    const provider = createMuseCodeProvider({ command });
    const { events, session, ctx } = harness(provider, "prompt", {}, { prompt: "Be terse.", promptMode: "append" });
    provider.startTurn(ctx);
    expect(session.status).toBe("error");
    expect(events[0].error).toContain("cannot deliver a append profile prompt");
    expect(session._providerState).toBeNull();
  });

  test("streams a turn, bridges MSP approvals, and records usage", async () => {
    const { createMuseCodeProvider } = await import("../../providers/muse-code");
    const capture = join(testRoot, "turn.ndjson");
    const provider = createMuseCodeProvider({ command });
    const { events, updates, session, ctx } = harness(provider, "turn", {
      model: "muse-test",
      effort: "high",
      permissionPolicy: "ask",
      mcpServers: { local: { command: process.execPath, args: ["never-run.ts"], env: { LOCAL_KEY: "pw" } } },
    }, { env: { MODUS_MUSE_CAPTURE: capture } });

    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.subtype === "permission_request"));
    const request = events.find((event) => event.subtype === "permission_request");
    expect(request).toMatchObject({ toolName: "read_file", input: { path: "README.md" }, interactive: true });
    session.sessionApprovals.add(request.toolName);
    session.pendingPermissions.get(request.requestId).resolve({ behavior: "allow" });
    await waitFor(() => events.some((event) => event.type === "result"));

    const sent = frames(capture);
    expect(sent[0]).toMatchObject({
      method: "initialize",
      params: { clientInfo: { name: "modus" }, capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: false } },
    });
    expect(sent[1]).toEqual({ jsonrpc: "2.0", method: "initialized" });
    const start = sent.find((frame) => frame.method === "session/start");
    expect(start.params).toMatchObject({
      modelId: "muse-test",
      approvalMode: "promptUnmatched",
      config: { mcpServers: { local: {
        transport: "stdio", command: process.execPath, args: ["never-run.ts"], env: { LOCAL_KEY: "pw" }, mode: "optional",
      } } },
    });
    const turn = sent.find((frame) => frame.method === "turn/start");
    expect(turn.params).toMatchObject({
      sessionId: "fake-muse-session",
      reasoningEffort: "high",
      input: [{ type: "text", text: "test prompt" }],
    });
    expect(turn.params.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    // The approval request is acknowledged, then decided by command with the
    // session-scoped choice because the user approved the tool for the session.
    expect(sent.some((frame) => frame.id === "approval-rpc-1" && frame.result)).toBe(true);
    expect(sent.find((frame) => frame.method === "approval/decide").params).toMatchObject({
      approvalId: "approval-1",
      requirementId: { approvalId: "approval-1", sourceIndex: 0 },
      choiceId: "allow_session",
    });

    expect(session.providerSessionId).toBe("fake-muse-session");
    const init = events.find((event) => event.subtype === "init");
    expect(init?.session_id).toBe("modus-muse-turn");
    expect(events.some((event) => event.type === "stream_event" && event.fullText === "hello world")).toBe(true);
    const durable = events
      .filter((event) => event.type === "assistant")
      .map((event) => {
        const block = event.message.content[0];
        return block.type === "thinking" ? `thinking:${block.thinking}` : block.type === "text" ? `text:${block.text}` : block.type;
      });
    expect(durable).toEqual(["thinking:fixture thought", "tool_use", "thinking:second thought", "text:hello world"]);
    const toolResult = events.find((event) => event.subtype === "tool_result");
    expect(toolResult.message.content[0]).toMatchObject({ tool_use_id: "tool-item-1", content: "fixture output", is_error: false });
    expect(events.find((event) => event.type === "result")).toMatchObject({
      subtype: "success", result: "hello world", input_tokens: 11, output_tokens: 7, total_tokens: 18,
    });
    expect(updates.at(-1)).toMatchObject({ status: "idle", lastResponse: "hello world" });
    expect(session.status).toBe("idle");

    // The host stays warm: a follow-up reuses the session and only issues commands.
    events.length = 0;
    provider.updateConfig?.(session, { model: "muse-other" });
    provider.sendMessage(ctx, "follow up");
    // read_file was approved for the session, so Modus answers the host itself.
    await waitFor(() => events.some((event) => event.type === "result"));
    expect(events.some((event) => event.subtype === "permission_request")).toBe(false);
    expect(frames(capture).filter((frame) => frame.method === "approval/decide").at(-1).params.choiceId).toBe("allow_once");
    const methods = frames(capture).map((frame) => frame.method).filter(Boolean);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
    expect(methods.filter((method) => method === "session/start")).toHaveLength(1);
    expect(frames(capture).find((frame) => frame.method === "session/setModel").params.model).toEqual({ modelId: "muse-other" });

    await provider.dispose?.(session);
    await waitFor(() => session.osPids.size === 0);
  }, 30_000);

  test("starts in allowAll when Modus has nothing to enforce", async () => {
    const { createMuseCodeProvider } = await import("../../providers/muse-code");
    const capture = join(testRoot, "allow-all.ndjson");
    const provider = createMuseCodeProvider({ command });
    const { events, session, ctx } = harness(provider, "allow-all", {}, { env: { MODUS_MUSE_CAPTURE: capture } });
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.type === "result"));
    expect(frames(capture).find((frame) => frame.method === "session/start").params.approvalMode).toBe("allowAll");
    expect(events.some((event) => event.subtype === "permission_request")).toBe(false);
    expect(events.find((event) => event.type === "result").subtype).toBe("success");
    await provider.dispose?.(session);
    await waitFor(() => session.osPids.size === 0);
  }, 30_000);

  test("steers the running turn and cancels it over MSP", async () => {
    const { createMuseCodeProvider } = await import("../../providers/muse-code");
    const capture = join(testRoot, "cancel.ndjson");
    const provider = createMuseCodeProvider({ command });
    const { events, session, ctx } = harness(provider, "cancel", { prompt: "hang" }, { env: { MODUS_MUSE_CAPTURE: capture } });
    provider.startTurn(ctx);
    await waitFor(() => events.some((event) => event.message?.content?.[0]?.type === "tool_use"));

    expect(await provider.steerMessage!(ctx, "also check the docs")).toBe(true);
    const steer = frames(capture).find((frame) => frame.method === "turn/steer");
    const turnId = frames(capture).find((frame) => frame.method === "turn/start").params.commandId;
    expect(steer.params).toMatchObject({ expectedTurnId: turnId, input: [{ type: "text", text: "also check the docs" }] });

    session.status = "interrupting";
    provider.abort(session);
    await waitFor(() => events.some((event) => event.type === "done"));
    expect(frames(capture).find((frame) => frame.method === "turn/cancel").params.turnId).toBe(turnId);
    expect(session.status).toBe("idle");
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(await provider.steerMessage!(ctx, "too late")).toBe(false);

    await provider.dispose?.(session);
    await waitFor(() => session.osPids.size === 0);
  }, 30_000);
});
