import { describe, expect, test } from "bun:test";
import hljs from "../../ui/node_modules/highlight.js/lib/core";
import { highlightCode } from "../../ui/src/syntax-highlight";

describe("cached highlighting", () => {
  test("preserves grammar output and separates identical text in different languages", () => {
    const code = "const value = 42; // <tag>";
    for (const language of ["typescript", "javascript", "python", "powershell", "json"]) {
      const expected = hljs.highlight(code, { language }).value;
      expect(highlightCode(code, language)).toBe(expected);
      expect(highlightCode(code, language)).toBe(expected);
    }
  });

  test("keeps unknown fences escaped and includes exact code in cache identity", () => {
    expect(highlightCode("<script>&", null)).toBe("&lt;script&gt;&amp;");
    expect(highlightCode("<script>&", "unknown-fixture")).toBe("&lt;script&gt;&amp;");
    expect(highlightCode("let a = 1", "js")).not.toBe(highlightCode("let a = 2", "js"));
    expect(highlightCode("", "js")).toBe("");
  });
});
