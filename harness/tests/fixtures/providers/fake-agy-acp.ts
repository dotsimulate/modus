/**
 * Fake `agy acp` server. Message shapes follow transcripts recorded from
 * Antigravity CLI 1.5.7 (`agy acp`): models listed per thinking level, a
 * `model` config option with base names, `write_file` tool calls that carry a
 * diff, `allow`/`deny` permission options, MCP tools named `mcp_<server>_<tool>`
 * with an injected `toolSummary`, and the unverified-account notice.
 *
 * Every request is appended to $MODUS_AGY_CAPTURE (JSONL) when it is set.
 */
import { appendFileSync } from "fs";
import { createInterface } from "readline";

const SESSION = "fake-agy-session";
const capture = process.env.MODUS_AGY_CAPTURE;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pendingPromptId: string | number | null = null;
let permissionTool: "write" | null = null;

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(update: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update } });
}

function finish(stopReason = "end_turn"): void {
  if (pendingPromptId == null) return;
  send({
    jsonrpc: "2.0",
    id: pendingPromptId,
    result: {
      stopReason,
      usage: { inputTokens: 120, outputTokens: 30, cachedReadTokens: 50, cachedWriteTokens: 0, thoughtTokens: 12, totalTokens: 212 },
    },
  });
  pendingPromptId = null;
}

const sessionResult = {
  sessionId: SESSION,
  models: {
    availableModels: [
      { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
      { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
      { modelId: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
      { modelId: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)" },
      { modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
      { modelId: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)" },
      { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ],
    currentModelId: "gemini-4-argon-medium",
  },
  modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "accept-edits" }, { id: "auto" }, { id: "plan" }] },
  configOptions: [
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: "gemini-4-argon",
      options: [
        { value: "gemini-4-argon", name: "Gemini 4 Argon" },
        { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
        { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      ],
    },
  ],
  _meta: { antigravity: { tier: { name: "Google AI Pro", id: "g1-pro-tier" } } },
};

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (capture) appendFileSync(capture, `${JSON.stringify(message)}\n`);

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true } },
        agentInfo: { name: "Antigravity ACP Server", version: "fake" },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
      },
    });
    return;
  }
  if (message.method === "session/new" || message.method === "session/load") {
    send({ jsonrpc: "2.0", id: message.id, result: sessionResult });
    return;
  }
  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/set_mode") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    update({ sessionUpdate: "current_mode_update", currentModeId: message.params.modeId });
    return;
  }
  if (message.method === "session/cancel") {
    finish("cancelled");
    return;
  }
  if (message.method === "session/prompt") {
    pendingPromptId = message.id;
    const text = String(message.params?.prompt?.[0]?.text ?? "");
    if (text.includes("unverified")) {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n⚠ Verification Required\n" } });
      finish();
      return;
    }
    if (text.includes("slow")) {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Once upon a time" } });
      return;
    }
    if (text.includes("mcp")) {
      const call = {
        toolCallId: "call-mcp",
        name: "mcp_modus_modus_submit",
        kind: "other",
        title: "Run mcp_modus_modus_submit",
        rawInput: { token: "mapi-test-1", data: "{\"op\":\"show\"}", toolSummary: "Show the page" },
      };
      update({ sessionUpdate: "tool_call", ...call, status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", ...call, status: "completed" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "shown" } });
      finish();
      return;
    }
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "planning the write" } });
    const call = {
      toolCallId: "call-write",
      name: "write_file",
      kind: "edit",
      title: "File hello.txt",
      rawInput: { Content: "hydrogen", Overwrite: true, Path: "hello.txt" },
    };
    update({ sessionUpdate: "tool_call", ...call, status: "in_progress" });
    permissionTool = "write";
    send({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { ...call, status: "pending", content: [{ type: "diff", path: "hello.txt", newText: "hydrogen" }] },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    return;
  }
  if (message.id === "permission-1" && message.result && permissionTool === "write") {
    permissionTool = null;
    const allowed = message.result?.outcome?.optionId === "allow";
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-write",
      name: "write_file",
      kind: "edit",
      status: allowed ? "completed" : "failed",
      rawOutput: {},
      content: allowed ? [{ type: "diff", path: "hello.txt", newText: "hydrogen\n" }] : [],
    });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "Created " : "Denied " } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello.txt" } });
    finish();
  }
});
