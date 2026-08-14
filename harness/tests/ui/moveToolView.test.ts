import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Message, ToolCall } from "../../sdk/index";
import {
  buildLatestMoveToolCallIds,
  clearMoveToolViewResolutionCache,
  moveApiInput,
  moveApiOp,
  moveApiToken,
  partitionToolRun,
  resolveMoveToolView,
  type MoveToolViewResolution,
} from "../../ui/src/move-tool-view";

function tool(id: string, token?: string, op = "play"): ToolCall {
  return {
    id,
    name: "mcp__modus__modus_submit",
    input: token ? { token, data: { op, square: "e4" } } : { query: id },
    status: "completed",
    startedAt: 1,
  };
}

const resolution: MoveToolViewResolution = {
  moveName: "chess",
  cwd: "C:/project",
  instanceId: "game-1",
  sessionId: "session-1",
  toolView: { component: "tool-view.tsx", ops: ["play"] },
};

beforeEach(() => clearMoveToolViewResolutionCache());

describe("move tool-view identity", () => {
  test("reads the reusable token, op, and handler payload from modus_submit input", () => {
    const call = tool("t1", "mapi-chess-game-1");
    expect(moveApiToken(call)).toBe("mapi-chess-game-1");
    expect(moveApiOp(call)).toBe("play");
    expect(moveApiInput(call)).toEqual({ op: "play", square: "e4" });
  });

  // modus-mcp.ts declares `data` as a string and widens three shapes server-side.
  // The transcript sees raw tool input, so it has to widen the same three.
  test("widens a JSON-string payload, the shape Claude Code actually sends", () => {
    const call: ToolCall = {
      ...tool("t2", "mapi-chess-game-1"),
      input: { token: "mapi-chess-game-1", data: '{"op":"play","square":"e4"}' },
    };
    expect(moveApiToken(call)).toBe("mapi-chess-game-1");
    expect(moveApiOp(call)).toBe("play");
    expect(moveApiInput(call)).toEqual({ op: "play", square: "e4" });
  });

  test("widens flat fields when data is absent, without leaking the token", () => {
    const call: ToolCall = {
      ...tool("t3", "mapi-chess-game-1"),
      input: { token: "mapi-chess-game-1", op: "play", square: "e4" },
    };
    expect(moveApiOp(call)).toBe("play");
    expect(moveApiInput(call)).toEqual({ op: "play", square: "e4" });
  });

  test("claims no op when the payload is unparseable or not an object", () => {
    const base = tool("t4", "mapi-chess-game-1");
    for (const data of ["{not json", '"a string"', "[1,2]"]) {
      const call: ToolCall = { ...base, input: { token: "mapi-chess-game-1", data } };
      expect(moveApiOp(call)).toBeNull();
      expect(moveApiInput(call)).toEqual({});
    }
  });

  test("does not claim ordinary tools or short-lived move tokens", () => {
    expect(moveApiToken(tool("read"))).toBeNull();
    expect(moveApiToken({ ...tool("short"), input: { token: "move-abc", data: { op: "x" } } })).toBeNull();
  });

  test("unwraps Grok Build use_tool → modus__modus_submit for token, op, and payload", () => {
    const call: ToolCall = {
      id: "grok-mcp",
      name: "use_tool",
      input: {
        tool_name: "modus__modus_submit",
        tool_input: {
          token: "mapi-html-6j2l3z5e",
          data: '{"op":"show","path":"D:\\\\proj\\\\a.html"}',
        },
      },
      status: "completed",
      startedAt: 1,
    };
    expect(moveApiToken(call)).toBe("mapi-html-6j2l3z5e");
    expect(moveApiOp(call)).toBe("show");
    expect(moveApiInput(call)).toEqual({ op: "show", path: "D:\\proj\\a.html" });
  });

  test("keeps Grok use_tool move rows out of collapsible core-tool groups", () => {
    const grokMove: ToolCall = {
      id: "m1",
      name: "use_tool",
      input: {
        tool_name: "modus__modus_submit",
        tool_input: { token: "mapi-html-1", data: { op: "show", path: "/x.html" } },
      },
      status: "completed",
      startedAt: 1,
    };
    const parts = partitionToolRun([
      tool("r1"),
      tool("r2"),
      grokMove,
      tool("r3"),
    ]);
    expect(parts.map((part) => ({ moveApi: part.moveApi, ids: part.tools.map((item) => item.id) }))).toEqual([
      { moveApi: false, ids: ["r1", "r2"] },
      { moveApi: true, ids: ["m1"] },
      { moveApi: false, ids: ["r3"] },
    ]);
  });

  test("tracks the latest top-level call independently for each token", () => {
    const messages: Message[] = [
      { id: "m1", role: "assistant", content: "", toolCalls: [tool("a1", "mapi-a-1"), tool("b1", "mapi-b-1")] },
      { id: "m2", role: "assistant", content: "", toolCalls: [tool("a2", "mapi-a-1")] },
    ];
    expect([...buildLatestMoveToolCallIds(messages)]).toEqual([
      ["mapi-a-1", "a2"],
      ["mapi-b-1", "b1"],
    ]);
  });
});

describe("move tool-view grouping", () => {
  test("keeps move calls outside adjacent collapsible core-tool runs", () => {
    const parts = partitionToolRun([
      tool("r1"),
      tool("r2"),
      tool("move", "mapi-chess-1"),
      tool("r3"),
    ]);
    expect(parts.map((part) => ({ moveApi: part.moveApi, ids: part.tools.map((item) => item.id) }))).toEqual([
      { moveApi: false, ids: ["r1", "r2"] },
      { moveApi: true, ids: ["move"] },
      { moveApi: false, ids: ["r3"] },
    ]);
  });
});

describe("move tool-view resolution cache", () => {
  test("deduplicates concurrent and subsequent lookup by token", async () => {
    let calls = 0;
    const load = async () => {
      calls++;
      return resolution;
    };
    const [first, second] = await Promise.all([
      resolveMoveToolView("mapi-chess-1", load),
      resolveMoveToolView("mapi-chess-1", load),
    ]);
    expect(first).toEqual({ resolution, error: null });
    expect(second).toEqual({ resolution, error: null });
    expect(await resolveMoveToolView("mapi-chess-1", load)).toEqual({ resolution, error: null });
    expect(calls).toBe(1);
  });

  test("turns lookup failures into a stable fallback result", async () => {
    const value = await resolveMoveToolView("mapi-missing-1", async () => {
      throw new Error("offline");
    });
    expect(value).toEqual({ resolution: null, error: "offline" });
  });

  test("names a declaration miss instead of silently returning null", async () => {
    expect(await resolveMoveToolView("mapi-deleted-1", async () => null)).toEqual({
      resolution: null,
      error: "token did not resolve to a declared tool view",
    });
  });

  test("retries a failed lookup once the negative window expires", async () => {
    let calls = 0;
    const load = async () => {
      calls++;
      if (calls === 1) throw new Error("backend restarting");
      return resolution;
    };

    setSystemTime(new Date("2026-08-06T00:00:00Z"));
    expect(await resolveMoveToolView("mapi-chess-2", load)).toEqual({
      resolution: null,
      error: "backend restarting",
    });
    // Inside the window the failure is shared rather than refetched per mount.
    expect(await resolveMoveToolView("mapi-chess-2", load)).toEqual({
      resolution: null,
      error: "backend restarting",
    });
    expect(calls).toBe(1);

    // A backend that came back must not stay invisible until a page reload.
    setSystemTime(new Date("2026-08-06T00:00:20Z"));
    expect(await resolveMoveToolView("mapi-chess-2", load)).toEqual({ resolution, error: null });
    expect(calls).toBe(2);
    setSystemTime();
  });
});
