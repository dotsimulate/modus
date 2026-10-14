/**
 * A canned `muse serve` host speaking the Muse Session Protocol: newline-
 * delimited JSON-RPC 2.0 over stdio. Frame shapes follow the MSP golden
 * transcripts (session-start, text-run-single-turn, approval-round-trip,
 * cancel-mid-turn). Every client frame is appended to MODUS_MUSE_CAPTURE.
 */
import { appendFileSync } from "fs";
import { createInterface } from "readline";

const SESSION_ID = "fake-muse-session";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let approvalMode = "promptUnmatched";
let cursor = 0;
let activeTurn: string | null = null;

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

/** Several frames in one stdout write, the way a busy host flushes. */
function sendBatch(messages: Record<string, unknown>[]): void {
  process.stdout.write(messages.map((message) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`).join(""));
}

function view(method: string, params: Record<string, unknown>): Record<string, unknown> {
  cursor += 1;
  return { method, params: { sessionId: SESSION_ID, viewCursor: `v:${SESSION_ID}:${cursor}`, ...params }, emittedAtMs: Date.now() };
}

function session(modelId: string) {
  return {
    sessionId: SESSION_ID,
    status: "idle",
    turnCount: 0,
    modelId,
    approvalMode: { mode: approvalMode, source: "startup", lastCommandId: null },
    activeTurnId: null,
  };
}

const toolCall = (turnId: string, status: string, extra: Record<string, unknown> = {}) => ({
  itemId: "tool-item-1", kind: "toolCall", turnId, revision: status === "inProgress" ? 1 : 2, status,
  tool: "read_file", callId: "call_1", args: "{\"path\":\"README.md\"}", ...extra,
});

function finishTurn(turnId: string): void {
  sendBatch([
    view("item/completed", { item: toolCall(turnId, "completed", { visibleOutput: "fixture output", truncated: false }) }),
    view("item/started", { item: { itemId: "reason-2", kind: "reasoning", turnId, revision: 1, status: "inProgress" } }),
    view("item/delta", { itemId: "reason-2", field: "summary.0", delta: "second thought" }),
    view("item/completed", { item: { itemId: "reason-2", kind: "reasoning", turnId, revision: 2, status: "completed", summary: ["second thought"] } }),
    view("item/started", { item: { itemId: "msg-1", kind: "agentMessage", turnId, revision: 1, status: "inProgress", text: "" } }),
    view("item/delta", { itemId: "msg-1", field: "text", delta: "hello " }),
    view("item/delta", { itemId: "msg-1", field: "text", delta: "world" }),
    view("item/completed", { item: { itemId: "msg-1", kind: "agentMessage", turnId, revision: 2, status: "completed", text: "hello world" } }),
    view("turn/completed", {
      turnId, terminal: "completed", durationMs: 5,
      usage: { inputTokens: 11, outputTokens: 7, cachedTokens: 0, reasoningTokens: 0 },
    }),
  ]);
  activeTurn = null;
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.MODUS_MUSE_CAPTURE) appendFileSync(process.env.MODUS_MUSE_CAPTURE, `${line}\n`);
  const { id, method, params } = message;

  if (method === "initialize") {
    const requested: string[] = params?.capabilities?.requestedCapabilities ?? [];
    send({ id, result: {
      serverInfo: { name: "muse-session-server", version: "0.0.0-fixture" },
      userAgent: "muse-session-server/0.0.0-fixture",
      museHome: "/fixture/.muse",
      platformFamily: "unix",
      platformOs: "linux",
      schema: { version: 1, fingerprint: "sha256:fixture" },
      grantedCapabilities: requested.filter((name) => name === "sessionMcp"),
      experimentalApi: false,
      sessionDurability: "durable",
    } });
    return;
  }
  if (method === "model/list") {
    send({ id, result: { providerId: "muse", profileId: null, source: "fakeCatalog", models: [
      { modelId: "muse-test", displayLabel: "Muse Test", providerId: "muse", profileId: null, releaseDate: null,
        description: null, contextLimit: 1_000_000, outputLimit: 64_000, cost: null, isActive: false, isDefault: true },
    ] } });
    return;
  }
  if (method === "session/start") {
    approvalMode = params.approvalMode ?? approvalMode;
    const started = session(params.modelId ?? "muse-test");
    send(view("session/started", { session: started }));
    send({ id, result: { session: started, viewCursor: `v:${SESSION_ID}:${cursor}` } });
    return;
  }
  if (method === "session/resume") {
    send({ id, result: { session: session("muse-test"), viewCursor: `v:${SESSION_ID}:${cursor}`,
      history: { mode: "none", items: null, snapshot: null }, pendingRequests: [] } });
    return;
  }
  if (method === "session/setModel" || method === "session/setApprovalMode") {
    if (method === "session/setApprovalMode") approvalMode = params.mode;
    send({ id, result: { commandId: params.commandId, status: "accepted" } });
    return;
  }
  if (method === "turn/start") {
    const turnId = params.commandId as string;
    activeTurn = turnId;
    const prompt = (params.input ?? []).map((part: any) => part.text ?? "").join("");
    sendBatch([
      { id, result: { commandId: turnId, status: "accepted", turnId, startedNewTurn: true, disposition: "started" } },
      view("turn/started", { turnId, commandId: turnId }),
      view("item/completed", { item: { itemId: "user-1", kind: "userMessage", turnId, revision: 1, status: "completed", text: prompt } }),
      view("item/started", { item: { itemId: "reason-1", kind: "reasoning", turnId, revision: 1, status: "inProgress" } }),
      view("item/delta", { itemId: "reason-1", field: "summary.0", delta: "fixture thought" }),
      view("item/completed", { item: { itemId: "reason-1", kind: "reasoning", turnId, revision: 2, status: "completed", summary: ["fixture thought"] } }),
      view("item/started", { item: toolCall(turnId, "inProgress", { approvalId: "approval-1" }) }),
    ]);
    if (prompt.includes("hang")) return;
    if (approvalMode === "allowAll") {
      finishTurn(turnId);
      return;
    }
    const request = {
      approvalId: "approval-1", turnId, itemId: "tool-item-1", toolCallId: "call_1", toolName: "read_file",
      rawArgs: "{\"path\":\"README.md\"}", subject: { kind: "fileAccess", toolName: "read_file", access: "read" },
      currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "allow_once", label: "Allow once", decision: "approved", scope: "once" },
        { choiceId: "allow_session", label: "Allow for session", decision: "approvedForSession", scope: "session" },
        { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
      ],
    };
    send(view("approval/requested", request));
    send({ id: "approval-rpc-1", ...view("approval/request", request) });
    return;
  }
  if (method === "approval/decide") {
    send({ id, result: { commandId: params.commandId, status: "accepted", approvalId: params.approvalId, terminal: true } });
    send(view("approval/resolved", { approvalId: params.approvalId, decision: "approved", resolvedBy: "user" }));
    if (activeTurn) finishTurn(activeTurn);
    return;
  }
  if (method === "turn/steer") {
    send({ id, result: { commandId: params.commandId, status: "accepted", turnId: params.expectedTurnId } });
    return;
  }
  if (method === "turn/cancel") {
    const turnId = params.turnId ?? activeTurn;
    sendBatch([
      { id, result: { commandId: params.commandId, status: "accepted", turnId } },
      view("item/completed", { item: toolCall(turnId, "cancelled", { failureReason: "turn cancelled" }) }),
      view("turn/completed", { turnId, terminal: "cancelled", reason: "cancelled during tool execution" }),
    ]);
    activeTurn = null;
  }
});
