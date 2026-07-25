import { describe, expect, test } from "bun:test";
import {
  maskMoveApiTokens,
  parseMessageText,
  userAuthoredMessageText,
} from "./src/move-context";

describe("move context message parsing", () => {
  test("separates injected context from the user-authored prompt", () => {
    const content = [
      "<!-- move:modus-brain -->",
      "Use token `mapi-brain-abc12345`.",
      "<!-- /move:modus-brain -->",
      "",
      "How do profiles work?",
    ].join("\n");

    expect(parseMessageText(content)).toEqual([
      {
        type: "move_context",
        moveName: "modus-brain",
        content: "Use token `mapi-brain-abc12345`.",
      },
      { type: "text", text: "How do profiles work?" },
    ]);
    expect(userAuthoredMessageText(content)).toBe("How do profiles work?");
  });

  test("supports multiple move blocks and preserves malformed markers as text", () => {
    const content = [
      "<!-- move:first -->",
      "one",
      "<!-- /move:first -->",
      "",
      "<!-- move:second -->",
      "two",
      "<!-- /move:second -->",
      "",
      "hello",
    ].join("\n");

    expect(parseMessageText(content).filter((part) => part.type === "move_context"))
      .toHaveLength(2);
    expect(userAuthoredMessageText(content)).toBe("hello");

    const malformed = "<!-- move:first -->\none\n<!-- /move:other -->\nhello";
    expect(parseMessageText(malformed)).toEqual([{ type: "text", text: malformed }]);
  });

  test("masks move capability tokens in expanded display text", () => {
    expect(maskMoveApiTokens("token mapi-brain-abc12345"))
      .toBe("token mapi-…2345");
  });
});
