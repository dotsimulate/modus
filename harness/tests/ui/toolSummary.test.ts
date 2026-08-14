/**
 * Tool-call headlines.
 *
 * `summarize` was an enumerated switch over ~15 tool names out of ~50 in the
 * catalog, so anything it did not know rendered as a bare tool name with no
 * detail. It cannot be fixed by enumerating harder: antigravity and gemini-cli
 * pass their provider's own tool names straight through and cursor derives names
 * from its wire keys, so the set is open-ended. These pin the two halves of the
 * fix — one case per tool regardless of spelling, and a generic fallback that
 * reads the input when the name means nothing.
 */

import { describe, expect, test } from "bun:test";
import { shortPath, summarize } from "../../ui/src/components/ToolCall";

describe("home shortening is cross-platform", () => {
  test("shortens a home path on every platform Modus ships to", () => {
    expect(shortPath("/home/dot/proj/a.ts")).toBe("~/proj/a.ts");
    expect(shortPath("/Users/dot/proj/a.ts")).toBe("~/proj/a.ts");
    expect(shortPath("C:\\Users\\dot\\proj\\a.ts")).toBe("~/proj\\a.ts");
    expect(shortPath("C:/Users/dot/proj/a.ts")).toBe("~/proj/a.ts");
  });

  test("leaves a non-home path alone", () => {
    expect(shortPath("D:/TOOLSHELF/modus/a.ts")).toBe("D:/TOOLSHELF/modus/a.ts");
    expect(shortPath("/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("one case per tool, whatever the spelling", () => {
  test("casing and separators fold together", () => {
    expect(summarize("Read", { file_path: "/tmp/a.ts" })).toBe("/tmp/a.ts");
    expect(summarize("read", { file_path: "/tmp/a.ts" })).toBe("/tmp/a.ts");
    expect(summarize("WebSearch", { query: "modus" })).toBe("modus");
    expect(summarize("web_search", { query: "modus" })).toBe("modus");
  });

  test("PowerShell summarizes like every other shell", () => {
    // It sits beside Bash in the catalog but had no case, so every shell call
    // on Windows rendered with no command text at all.
    expect(summarize("PowerShell", { command: "Get-ChildItem" })).toBe("Get-ChildItem");
    expect(summarize("Bash", { command: "bun test" })).toBe("bun test");
    expect(summarize("shell", { command: ["bash", "-lc", "bun test"] })).toBe("bash -lc bun test");
  });

  test("a read range still reads as a range", () => {
    expect(summarize("Read", { file_path: "/tmp/a.ts", offset: 40, limit: 50 })).toBe("/tmp/a.ts :40-90");
  });
});

describe("unknown tools still say something", () => {
  test("an unrecognised name falls back to its most useful argument", () => {
    // Whatever a pass-through provider happens to call its tools.
    expect(summarize("edit_file_by_replace", { file_path: "/home/dot/x.ts" })).toBe("~/x.ts");
    expect(summarize("someProviderTool", { command: "ls -la" })).toBe("ls -la");
    expect(summarize("weird_thing", { url: "https://example.com" })).toBe("https://example.com");
  });

  test("an argument with no recognised key is still labelled", () => {
    expect(summarize("mystery", { target: "the-thing" })).toBe("target: the-thing");
  });

  test("nothing usable yields nothing rather than noise", () => {
    expect(summarize("mystery", {})).toBe("");
    expect(summarize("mystery", { count: 3, flag: true })).toBe("");
  });

  test("mcp tools keep their server/tool shape", () => {
    expect(summarize("mcp__modus__modus_submit", {})).toBe("modus/modus_submit");
  });
});
