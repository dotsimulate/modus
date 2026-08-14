import { expect, test } from "bun:test";
import { addEvent, getSessionMessage, sessionHasMoveContext, upsertSession } from "../db";

test("getSessionMessage reconstructs only the requested completed or interrupted turn", () => {
  const sessionId = `single-turn-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "single turn test", messageCount: 0, costUsd: 0 });

  addEvent(sessionId, 1, "user", "prompt", JSON.stringify({
    message: { content: [{ type: "text", text: "inspect it" }] },
  }));
  addEvent(sessionId, 2, "assistant", "message", JSON.stringify({
    uuid: "assistant-one",
    message: { content: [
      { type: "thinking", thinking: "checking" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.ts" } },
    ] },
  }));
  addEvent(sessionId, 3, "user", "message", JSON.stringify({
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "contents" }] },
  }));
  addEvent(sessionId, 4, "assistant", "message", JSON.stringify({
    message: { content: [{ type: "text", text: "done" }] },
  }));
  addEvent(sessionId, 5, "result", "success", JSON.stringify({ subtype: "success" }));

  expect(getSessionMessage(sessionId, 1)).toMatchObject({ role: "user", seq: 1, text: "inspect it" });
  expect(getSessionMessage(sessionId, 5)).toMatchObject({
    role: "assistant",
    seq: 5,
    text: "done",
    thinking: "checking",
    toolCalls: [{ name: "Read", input: { file_path: "a.ts" }, result: "contents" }],
  });

  addEvent(sessionId, 6, "user", "prompt", JSON.stringify({
    message: { content: [{ type: "text", text: "one more" }] },
  }));
  addEvent(sessionId, 7, "assistant", "message", JSON.stringify({
    message: { content: [{ type: "tool_use", id: "tool-2", name: "Grep", input: { pattern: "TODO" } }] },
  }));

  expect(getSessionMessage(sessionId, 7)).toMatchObject({
    role: "assistant",
    seq: 7,
    toolCalls: [{ name: "Grep", input: { pattern: "TODO" } }],
  });
});

test("sessionHasMoveContext detects a move injected on an earlier logical turn", () => {
  const sessionId = `move-context-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "move context test", messageCount: 0, costUsd: 0 });
  addEvent(sessionId, 1, "user", "prompt", JSON.stringify({
    subtype: "prompt",
    message: {
      content: "<!-- move:modus-brain -->\nbrain instructions\n<!-- /move:modus-brain -->\n\nhello",
    },
  }));

  expect(sessionHasMoveContext(sessionId, "modus-brain")).toBe(true);
  expect(sessionHasMoveContext(sessionId, "another-move")).toBe(false);
});
