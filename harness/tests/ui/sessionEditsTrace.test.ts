import { beforeAll, describe, expect, test } from "bun:test";
import type { Message, TouchRecord } from "../../sdk/index";

let mergeSessionEdits: typeof import("../../ui/src/sessionEditsModel").mergeSessionEdits;
let countChanges: typeof import("../../ui/src/components/FileChanges").countChanges;
let extractFileEdits: typeof import("../../ui/src/components/FileChanges").extractFileEdits;

beforeAll(async () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  });
  ({ mergeSessionEdits } = await import("../../ui/src/sessionEditsModel"));
  ({ countChanges, extractFileEdits } = await import("../../ui/src/components/FileChanges"));
});

function touch(filePath: string, op: "write" | "edit"): TouchRecord {
  return {
    sessionId: "session-1",
    seq: 10,
    timestamp: 1_800_000_000_000,
    provider: "claude-code",
    cwd: "D:\\repo",
    filePath,
    fileKind: "code",
    op,
    confidence: "explicit",
    toolName: op === "write" ? "Write" : "Edit",
  };
}

describe("session edits trace model", () => {
  test("shows the complete trace file set when chat tool payloads are deferred", () => {
    const grouped = mergeSessionEdits([], [
      touch("D:\\repo\\src\\one.ts", "edit"),
      touch("D:\\repo\\src\\two.ts", "write"),
    ], "D:\\repo");

    expect([...grouped.keys()]).toEqual([
      "D:\\repo\\src\\one.ts",
      "D:\\repo\\src\\two.ts",
    ]);
    expect(countChanges([...grouped.values()].flat())).toEqual({ additions: 0, deletions: 0 });
  });

  test("uses loaded tool details to enrich a matching trace file", () => {
    const messages = [{
      id: "assistant-1",
      role: "assistant",
      content: "done",
      toolCalls: [{
        id: "tool-1",
        name: "Edit",
        status: "completed",
        input: {
          file_path: "src\\one.ts",
          old_string: "old",
          new_string: "new\nline",
        },
      }],
    }] as Message[];

    const grouped = mergeSessionEdits(
      messages,
      [touch("D:\\repo\\src\\one.ts", "edit")],
      "D:\\repo",
    );

    expect([...grouped.keys()]).toEqual(["D:\\repo\\src\\one.ts"]);
    expect(countChanges([...grouped.values()].flat())).toEqual({ additions: 2, deletions: 1 });
  });
});

describe("Grok file tool names in extractFileEdits", () => {
  test("search_replace and write_file land as edit/write the way Claude Edit/Write do", () => {
    const edits = extractFileEdits([
      {
        id: "1",
        name: "search_replace",
        status: "completed",
        input: { file_path: "src/a.ts", old_string: "old", new_string: "new" },
      },
      {
        id: "2",
        name: "write_file",
        status: "completed",
        input: { target_file: "src/b.ts", contents: "hello" },
      },
    ] as any);
    expect(edits).toEqual([
      { filePath: "src/a.ts", type: "edit", oldString: "old", newString: "new" },
      { filePath: "src/b.ts", type: "write", content: "hello" },
    ]);
  });
});
