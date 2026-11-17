/**
 * Fake `agy acp` server. Message shapes follow transcripts recorded from
 * Antigravity CLI 1.5.7 (`agy acp`): models listed per thinking level, a
 * `model` config option with base names, `write_file` tool calls that carry a
 * diff, `allow`/`deny` permission options, MCP tools named `mcp_<server>_<tool>`
 * with an injected `toolSummary`, and the unverified-account notice.
 *
 * Also recorded from 1.5.7: `run_command` input (`CommandLine`, `BypassSandbox`)
 * and output (`rawOutput.output`), the sandbox start failure text, which tools
 * ask before running (commands and edits do; reads and MCP calls do not), and a
 * rejected call surfacing as a `failed` update with no output.
 *
 * Steering is modelled on Antigravity's ACP guide ("sending a prompt while a
 * turn runs steers that turn"), not a recording: a second `session/prompt`
 * during a `steerable` turn is folded into it and both requests settle when the
 * turn ends. During a `nosteer` turn it is refused at once.
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
let turnKind: "steerable" | "nosteer" | "loop" | null = null;
const steerIds: Array<string | number> = [];
let loopTimer: ReturnType<typeof setInterval> | null = null;
let loopRound = 0;
const permissionReplies = new Map<string, (allowed: boolean) => void>();

const PERMISSION_OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

function askPermission(id: string, toolCall: Record<string, unknown>, then: (allowed: boolean) => void): void {
  permissionReplies.set(id, then);
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: { sessionId: SESSION, toolCall: { ...toolCall, status: "pending" }, options: PERMISSION_OPTIONS },
  });
}

function commandCall(id: string, input: Record<string, unknown>) {
  return { toolCallId: id, name: "run_command", kind: "execute", title: String(input.CommandLine ?? ""), rawInput: input };
}

function commandResult(id: string, input: Record<string, unknown>, allowed: boolean, output: string): void {
  const call = commandCall(id, input);
  update(allowed
    ? { sessionUpdate: "tool_call_update", ...call, status: "completed", rawOutput: { output } }
    : { sessionUpdate: "tool_call_update", ...call, status: "failed" });
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(update: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update } });
}

function finish(stopReason = "end_turn"): void {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  turnKind = null;
  for (const id of steerIds.splice(0)) {
    send({ jsonrpc: "2.0", id, result: { stopReason, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
  }
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
  if (typeof message.id === "string" && permissionReplies.has(message.id) && message.result) {
    const then = permissionReplies.get(message.id)!;
    permissionReplies.delete(message.id);
    then(message.result?.outcome?.optionId === "allow");
    return;
  }
  if (message.method === "session/prompt" && pendingPromptId != null) {
    const text = String(message.params?.prompt?.[0]?.text ?? "");
    if (turnKind === "steerable") {
      steerIds.push(message.id);
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ` (steered: ${text})` } });
      finish();
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "a turn is already running" } });
    return;
  }
  if (message.method === "session/prompt") {
    pendingPromptId = message.id;
    const text = String(message.params?.prompt?.[0]?.text ?? "");
    if (text.includes("nosteer")) {
      turnKind = "nosteer";
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
      return;
    }
    if (text.includes("steerable")) {
      turnKind = "steerable";
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
      return;
    }
    if (text.includes("loop")) {
      // One read per round, with a thought between rounds, until cancelled.
      turnKind = "loop";
      loopRound = 0;
      loopTimer = setInterval(() => {
        loopRound += 1;
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `round ${loopRound}` } });
        const call = { toolCallId: `call-loop-${loopRound}`, name: "read_file", kind: "read", title: "note.txt", rawInput: { Path: "note.txt" } };
        update({ sessionUpdate: "tool_call", ...call, status: "in_progress" });
        update({ sessionUpdate: "tool_call_update", ...call, status: "completed" });
      }, 15);
      return;
    }
    if (text.includes("sandbox-fail")) {
      const input = { CommandLine: "cmd /c echo hi", WaitMsBeforeAsync: 5000 };
      update({ sessionUpdate: "tool_call", ...commandCall("call-sandbox", input), status: "in_progress" });
      commandResult("call-sandbox", input, true,
        "Created At: 2026-11-13T00:52:44-05:00\nCompleted At: 2026-11-13T00:52:46-05:00\n"
        + "Command failed to run: exebox: creating sandbox: CreateProcessSecurityEnvironment: The environment is incorrect..\n\nNo output from the command.");
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the sandbox failed" } });
      finish();
      return;
    }
    if (text.includes("read-unasked")) {
      const call = { toolCallId: "call-read", name: "read_file", kind: "read", title: "note.txt", rawInput: { Path: "note.txt" } };
      update({ sessionUpdate: "tool_call", ...call, status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", ...call, status: "completed" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "read it" } });
      finish();
      return;
    }
    if (text.includes("background") || text.includes("server")) {
      // run_command past WaitMsBeforeAsync: the reply ends with the call still
      // open. When the command finishes, agy completes that call and works on
      // with no prompt around it (agy 1.5.9 conversation record and worker log).
      const input = { CommandLine: text.includes("server") ? "npm run dev" : "voro lab look scene.voro", WaitMsBeforeAsync: 10000 };
      update({ sessionUpdate: "tool_call", ...commandCall("call-background", input), status: "in_progress" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "waiting for it to finish" } });
      finish();
      if (text.includes("server")) return;
      setTimeout(() => {
        commandResult("call-background", input, true, "look done");
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reviewing the look" } });
        const call = { toolCallId: "call-after-wake", name: "read_file", kind: "read", title: "look.png", rawInput: { Path: "look.png" } };
        update({ sessionUpdate: "tool_call", ...call, status: "in_progress" });
        update({ sessionUpdate: "tool_call_update", ...call, status: "completed" });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " then fixed the bark" } });
      }, 150);
      return;
    }
    if (text.includes("late-wake")) {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done for now" } });
      finish();
      setTimeout(() => {
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "a task finished" } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "picked it back up" } });
      }, 150);
      return;
    }
    if (text.includes("command") || text.includes("bypass")) {
      const input: Record<string, unknown> = { CommandLine: "cmd /c echo hi", WaitMsBeforeAsync: 5000 };
      if (text.includes("bypass")) input.BypassSandbox = true;
      update({ sessionUpdate: "tool_call", ...commandCall("call-command", input), status: "in_progress" });
      askPermission("permission-command", commandCall("call-command", input), (allowed) => {
        commandResult("call-command", input, allowed, "hi");
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "ran it" : "it was refused" } });
        finish();
      });
      return;
    }
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
