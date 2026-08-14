import { createInterface } from "readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pendingPromptId: string | number | null = null;

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(update: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-grok-session", update } });
}

function finishPrompt(): void {
  if (pendingPromptId == null) return;
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    title: "read_file",
    status: "completed",
    rawOutput: { text: "fixture output" },
  });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } });
  send({
    jsonrpc: "2.0",
    id: pendingPromptId,
    result: {
      stopReason: "end_turn",
      _meta: { usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, totalCostUsd: 0.001 } },
    },
  });
  pendingPromptId = null;
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        authMethods: [{ id: "cached_token", name: "Cached login" }],
        _meta: {
          defaultAuthMethodId: "cached_token",
          modelState: {
            currentModelId: "grok-test",
            availableModels: [{ modelId: "grok-test", name: "Grok Test" }],
          },
        },
      },
    });
    return;
  }
  if (message.method === "authenticate") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-grok-session" } });
    return;
  }
  if (message.method === "session/load") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/set_mode" || message.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    pendingPromptId = message.id;
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "fixture thought" } });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "read_file",
      kind: "read",
      status: "pending",
      rawInput: { path: "README.md" },
    });
    send({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "fake-grok-session",
        toolCall: { toolCallId: "tool-1", title: "read_file", rawInput: { path: "README.md" } },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow for session", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    return;
  }
  if (message.id === "permission-1" && message.result) {
    finishPrompt();
  }
});
