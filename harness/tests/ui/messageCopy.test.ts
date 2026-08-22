import { describe, expect, test } from "bun:test";
import type { Message } from "../../sdk/index";
import { buildCopyText } from "../../ui/src/message-copy";

describe("message copy text", () => {
  test("preserves rendered block boundaries for a hydrated response", () => {
    const msg: Message = {
      id: "assistant-1",
      role: "assistant",
      content: "First update.Second update.Done.",
      contentBlocks: [
        { type: "text", text: "First update." },
        { type: "text", text: "Second update." },
        { type: "text", text: "Done." },
      ],
    };

    expect(buildCopyText(msg, "text")).toBe("First update.\n\nSecond update.\n\nDone.");
    expect(buildCopyText(msg, "full")).toBe("First update.\n\nSecond update.\n\nDone.");
  });

  test("repairs an already-settled live response carrying the old flat cache", () => {
    const msg: Message = {
      id: "assistant-hot",
      role: "assistant",
      content: "First update.Second update.",
      contentBlocks: [
        { type: "text", text: "First update." },
        { type: "text", text: "Second update." },
      ],
      turnCopy: { text: "First update.Second update." },
    };

    expect(buildCopyText(msg, "full")).toBe("First update.\n\nSecond update.");
  });

  test("keeps thinking and response sections visibly separate", () => {
    const msg: Message = {
      id: "assistant-2",
      role: "assistant",
      content: "Done.",
      contentBlocks: [
        { type: "thinking", thinking: "Check one." },
        { type: "thinking", thinking: "Check two." },
        { type: "text", text: "Done." },
      ],
    };

    expect(buildCopyText(msg, "thinking")).toBe(
      "<thinking>\nCheck one.\n\nCheck two.\n</thinking>\n\nDone.",
    );
  });
});
