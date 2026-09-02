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
import { shortPath, summarize, summaryShowsPath } from "../../ui/src/components/ToolCall";
import { isTodoTool, toolFamily } from "../../ui/src/tool-names";

describe("home shortening is cross-platform", () => {
  test("shortens a home path on every platform Modus ships to", () => {
    expect(shortPath("/home/dot/proj/a.ts")).toBe("~/proj/a.ts");
    expect(shortPath("/Users/dot/proj/a.ts")).toBe("~/proj/a.ts");
    expect(shortPath("C:\\Users\\dot\\proj\\a.ts")).toBe("~/proj\\a.ts");
    expect(shortPath("C:/Users/dot/proj/a.ts")).toBe("~/proj/a.ts");
  });

  test("leaves a non-home path alone", () => {
    expect(shortPath("D:/Work/app/a.ts")).toBe("D:/Work/app/a.ts");
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

  test("Grok file and shell names fold onto the same headlines", () => {
    expect(toolFamily("read_file")).toBe("read");
    expect(toolFamily("write_file")).toBe("write");
    expect(toolFamily("search_replace")).toBe("edit");
    expect(toolFamily("run_terminal_cmd")).toBe("shell");
    expect(toolFamily("run_terminal_command")).toBe("shell");
    expect(summarize("read_file", { target_file: "/tmp/a.ts", offset: 10, limit: 20 })).toBe("/tmp/a.ts :10-30");
    expect(summarize("write_file", { file_path: "/tmp/a.ts" })).toBe("/tmp/a.ts");
    expect(summarize("search_replace", { file_path: "/tmp/a.ts" })).toBe("/tmp/a.ts");
    expect(summarize("run_terminal_cmd", { command: "bun test" })).toBe("bun test");
    expect(summarize("run_terminal_command", { command: ["bash", "-lc", "ls"] })).toBe("bash -lc ls");
  });

  test("Grok grep_search and list_dir fold onto grep and list headlines", () => {
    expect(toolFamily("grep_search")).toBe("grep");
    expect(toolFamily("grep")).toBe("grep");
    expect(toolFamily("list_dir")).toBe("list");
    expect(summarize("grep_search", { pattern: "toolFamily", path: "/tmp/src" })).toBe("/toolFamily/ in src");
    expect(summarize("list_dir", { target_directory: "/tmp/src" })).toBe("/tmp/src");
    expect(summarize("open_page", { url: "https://example.com/a" })).toBe("https://example.com/a");
    expect(summarize("web_fetch", { url: "https://example.com/b" })).toBe("https://example.com/b");
  });
});

describe("path headline placement", () => {
  test("file operations preserve the filename end of long paths", () => {
    const path = "/workspace/a/very/long/provider/generated/path/to/ToolCall.tsx";
    expect(summaryShowsPath("Read", { file_path: path })).toBe(true);
    expect(summaryShowsPath("search_replace", { file_path: path })).toBe(true);
    expect(summaryShowsPath("run_terminal_command", { command: path })).toBe(false);
  });

  test("unknown provider path tools retain the full path for CSS truncation", () => {
    const path = `/workspace/${"nested/".repeat(12)}ToolCall.tsx`;
    const summary = summarize("provider_file_reader", { file_path: path });
    expect(summary).toBe(path);
    expect(summaryShowsPath("provider_file_reader", { file_path: path })).toBe(true);
  });

  test("search context paths do not right-align pattern headlines", () => {
    expect(summaryShowsPath("grep", { pattern: "ToolCall", path: "/workspace/src" })).toBe(false);
    expect(summaryShowsPath("glob", { pattern: "**/*.tsx", path: "/workspace/src" })).toBe(false);
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

describe("todo tool spelling", () => {
  const todos = [
    { content: "write the page", status: "in_progress" },
    { content: "link it", status: "pending" },
  ];

  test("Grok todo_write is the same tool as Claude TodoWrite", () => {
    expect(isTodoTool("TodoWrite")).toBe(true);
    expect(isTodoTool("todo_write")).toBe(true);
    expect(isTodoTool("todo-write")).toBe(true);
    expect(isTodoTool("read_file")).toBe(false);
    expect(summarize("todo_write", { todos })).toBe("1 active · 1 pending");
    expect(summarize("TodoWrite", { todos })).toBe("1 active · 1 pending");
  });
});
