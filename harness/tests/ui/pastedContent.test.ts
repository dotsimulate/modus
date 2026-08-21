import { describe, expect, test } from "bun:test";
import { parsePastedContent } from "../../ui/src/pasted-content";

describe("pasted message content", () => {
  test("keeps authored text outside a staged paste", () => {
    const content = [
      "<pasted>",
      "19 tool calls",
      "9 read_file · 6 run_terminal_command",
      "</pasted>",
      "",
      "also getting this",
      "",
      "not to pile it on fix requests",
    ].join("\n");

    expect(parsePastedContent(content)).toEqual([
      { type: "paste", text: "19 tool calls\n9 read_file · 6 run_terminal_command" },
      { type: "text", text: "\nalso getting this\n\nnot to pile it on fix requests" },
    ]);
  });

  test("separates multiple paste cards and restores escaped source text", () => {
    const content = [
      "<pasted>",
      "&lt;div&gt;one &amp; two&lt;/div&gt;",
      "</pasted>",
      "",
      "<pasted>",
      "&amp;lt; remains an entity",
      "</pasted>",
      "",
      "finish",
    ].join("\n");

    expect(parsePastedContent(content)).toEqual([
      { type: "paste", text: "<div>one & two</div>" },
      { type: "paste", text: "&lt; remains an entity" },
      { type: "text", text: "\nfinish" },
    ]);
  });

  test("leaves ordinary and malformed marker text untouched", () => {
    expect(parsePastedContent("ordinary **Markdown**")).toEqual([
      { type: "text", text: "ordinary **Markdown**" },
    ]);
    const malformed = "<pasted>\nmissing close";
    expect(parsePastedContent(malformed)).toEqual([{ type: "text", text: malformed }]);
  });
});
