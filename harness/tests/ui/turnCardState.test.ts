import { describe, expect, test } from "bun:test";
import {
  accumulateTurnScrollThrough,
  buildTurnNavigationEntries,
  canConsumeDirectionalScroll,
  describeTurnActivity,
  isNearTurnBottom,
  resolveTurnNavigation,
  shouldAutoScrollTurn,
} from "../../ui/src/turn-card-state";
import type { ChatTurn } from "../../ui/src/turn-segments";
import type { Message, SessionTurnIndexEntry, ToolCall } from "../../sdk/index";

function tool(
  name: string,
  status: ToolCall["status"],
  input: Record<string, unknown> = {},
): ToolCall {
  return { id: `${name}-${status}`, name, status, input };
}

function turnWithBlocks(
  contentBlocks: NonNullable<Message["contentBlocks"]>,
  number = 2,
  seq = 20,
): ChatTurn {
  return {
    number,
    seq,
    key: `turn-${number}`,
    prompt: null,
    body: [{
      id: `assistant-${number}`,
      role: "assistant",
      content: "",
      contentBlocks,
    } as Message],
  };
}

function indexEntry(number: number, seq = number * 10): SessionTurnIndexEntry {
  return { number, seq, timestamp: number, promptWeight: number };
}

describe("describeTurnActivity", () => {
  test("uses session state before the first response block exists", () => {
    expect(describeTurnActivity(null, "starting")).toEqual({
      phase: "thinking",
      label: "Starting agent",
    });
    expect(describeTurnActivity(turnWithBlocks([]), "running")).toEqual({
      phase: "thinking",
      label: "Thinking",
    });
  });

  test("tracks whether the newest ordered block is thinking or prose", () => {
    expect(describeTurnActivity(turnWithBlocks([
      { type: "thinking", thinking: "checking" },
    ]), "running")?.label).toBe("Thinking");
    expect(describeTurnActivity(turnWithBlocks([
      { type: "thinking", thinking: "checking" },
      { type: "text", text: "The answer is" },
    ]), "running")?.label).toBe("Writing response");
  });

  test("names an active file operation without exposing its full path", () => {
    const activity = describeTurnActivity(turnWithBlocks([{
      type: "tool_call",
      toolCall: tool("Edit", "running", { file_path: "C:\\repo\\src\\App.tsx" }),
    }]), "running");
    expect(activity).toMatchObject({ phase: "tool", label: "Editing", detail: "App.tsx" });
  });

  test("Grok file and shell names use the same activity labels", () => {
    expect(describeTurnActivity(turnWithBlocks([{
      type: "tool_call",
      toolCall: tool("read_file", "running", { target_file: "C:\\repo\\src\\App.tsx" }),
    }]), "running")).toMatchObject({ phase: "tool", label: "Reading", detail: "App.tsx" });
    expect(describeTurnActivity(turnWithBlocks([{
      type: "tool_call",
      toolCall: tool("search_replace", "running", { file_path: "/work/a.ts" }),
    }]), "running")).toMatchObject({ phase: "tool", label: "Editing", detail: "a.ts" });
    expect(describeTurnActivity(turnWithBlocks([{
      type: "tool_call",
      toolCall: tool("write_file", "completed", { file_path: "/work/report.md" }),
    }]), "running")).toMatchObject({ phase: "recent", label: "Wrote", detail: "report.md" });
    expect(describeTurnActivity(turnWithBlocks([{
      type: "tool_call",
      toolCall: tool("run_terminal_cmd", "running", { command: "bun test" }),
    }]), "running")).toMatchObject({ phase: "tool", label: "Running command", detail: "bun test" });
    expect(describeTurnActivity(turnWithBlocks([{
      type: "tool_call",
      toolCall: tool("grep_search", "running", { pattern: "foo", path: "/work/src" }),
    }]), "running")).toMatchObject({ phase: "tool", label: "Searching project", detail: "src" });
    expect(describeTurnActivity(turnWithBlocks([{
      type: "tool_call",
      toolCall: tool("list_dir", "running", { target_directory: "/work/src" }),
    }]), "running")).toMatchObject({ phase: "tool", label: "Inspecting folder", detail: "src" });
  });

  test("keeps the latest completed action visible while the agent continues", () => {
    const activity = describeTurnActivity(turnWithBlocks([{
      type: "tool_call",
      toolCall: tool("Write", "completed", { path: "/work/report.md" }),
    }]), "running");
    expect(activity).toMatchObject({ phase: "recent", label: "Wrote", detail: "report.md" });
  });

  test("uses Codex's structured MCP identity for integration activity", () => {
    const activity = describeTurnActivity(turnWithBlocks([{
      type: "tool_call",
      toolCall: tool("MCPToolCall", "running", { server: "figma", tool: "inspect_file" }),
    }]), "running");
    expect(activity).toMatchObject({
      phase: "tool",
      label: "Calling integration",
      detail: "figma/inspect_file",
    });
  });

  test("shows parallel work as one action plus a count", () => {
    const activity = describeTurnActivity(turnWithBlocks([
      { type: "tool_call", toolCall: tool("Read", "running", { path: "one.ts" }) },
      { type: "tool_call", toolCall: tool("Grep", "running", { pattern: "needle" }) },
    ]), "running");
    expect(activity).toMatchObject({
      phase: "tool",
      label: "Searching project",
      detail: "needle",
      activeCount: 2,
    });
  });

  test("disappears when the session is no longer active", () => {
    const current = turnWithBlocks([{ type: "text", text: "done" }]);
    expect(describeTurnActivity(current, "idle")).toBeNull();
    expect(describeTurnActivity(current, undefined)).toBeNull();
  });
});

describe("turn card navigation", () => {
  test("merges unloaded history with loaded turns and prefers loaded seqs", () => {
    const loaded = turnWithBlocks([], 2, 21);
    expect(buildTurnNavigationEntries(
      [indexEntry(1), indexEntry(2), indexEntry(3)],
      [loaded],
    )).toEqual([
      { number: 1, seq: 10 },
      { number: 2, seq: 21 },
      { number: 3, seq: 30 },
    ]);
  });

  test("resolves adjacent turns and marks a step back onto the live edge", () => {
    const entries = [
      { number: 1, seq: 10 },
      { number: 2, seq: 20 },
      { number: 3, seq: 30 },
    ];
    expect(resolveTurnNavigation(entries, turnWithBlocks([], 2, 20))).toEqual({
      current: 2,
      total: 3,
      previous: { number: 1, seq: 10 },
      next: { number: 3, seq: 30 },
      nextIsLatest: true,
    });
    expect(resolveTurnNavigation(entries, turnWithBlocks([], 3, 30))).toEqual({
      current: 3,
      total: 3,
      previous: { number: 2, seq: 20 },
      next: null,
      nextIsLatest: false,
    });
  });

  test("uses turn number when a resumed provider reuses sequence values", () => {
    const entries = [
      { number: 7, seq: 1 },
      { number: 8, seq: 4 },
      { number: 9, seq: 1 },
      { number: 10, seq: 4 },
      { number: 11, seq: 7 },
    ];
    expect(resolveTurnNavigation(entries, turnWithBlocks([], 10, 4))).toEqual({
      current: 10,
      total: 11,
      previous: { number: 9, seq: 1 },
      next: { number: 11, seq: 7 },
      nextIsLatest: true,
    });
  });
});

describe("latest turn scrolling", () => {
  test("follows only an overflowing latest turn while the reader stays near the bottom", () => {
    expect(shouldAutoScrollTurn(true, true, 400, 700)).toBe(true);
    expect(shouldAutoScrollTurn(false, true, 400, 700)).toBe(false);
    expect(shouldAutoScrollTurn(true, false, 400, 700)).toBe(false);
    expect(shouldAutoScrollTurn(true, true, 400, 400)).toBe(false);
  });

  test("stops following once the reader moves beyond the bottom threshold", () => {
    expect(isNearTurnBottom(252, 400, 700)).toBe(true);
    expect(isNearTurnBottom(200, 400, 700)).toBe(false);
  });
});

describe("scroll-through turn navigation", () => {
  const options = {
    atTop: false,
    atBottom: true,
    canPrevious: true,
    canNext: true,
  };

  test("requires a deliberate overscroll threshold at the turn edge", () => {
    const first = accumulateTurnScrollThrough(
      { direction: null, distance: 0 },
      120,
      options,
    );
    expect(first).toMatchObject({ navigate: null, consumed: true });

    const second = accumulateTurnScrollThrough(first.progress, 99, options);
    expect(second.navigate).toBeNull();
    expect(second.progress.distance).toBe(219);

    const crossed = accumulateTurnScrollThrough(second.progress, 1, options);
    expect(crossed).toEqual({
      progress: { direction: null, distance: 0 },
      navigate: "next",
      consumed: true,
    });
  });

  test("ordinary scrolling and unavailable adjacent turns do not accrue", () => {
    expect(accumulateTurnScrollThrough(
      { direction: "next", distance: 200 },
      30,
      { ...options, atBottom: false },
    )).toEqual({
      progress: { direction: null, distance: 0 },
      navigate: null,
      consumed: false,
    });
    expect(accumulateTurnScrollThrough(
      { direction: null, distance: 0 },
      300,
      { ...options, canNext: false },
    ).navigate).toBeNull();
  });

  test("reversing direction starts a fresh gesture at the opposite edge", () => {
    const reversed = accumulateTurnScrollThrough(
      { direction: "next", distance: 180 },
      -80,
      { ...options, atTop: true, atBottom: false },
    );
    expect(reversed).toEqual({
      progress: { direction: "previous", distance: 80 },
      navigate: null,
      consumed: true,
    });
  });

  test("a freshly rendered turn can earn another crossing from continued momentum", () => {
    const first = accumulateTurnScrollThrough(
      { direction: null, distance: 0 },
      220,
      options,
    );
    expect(first.navigate).toBe("next");

    const nextTurn = accumulateTurnScrollThrough(first.progress, 220, options);
    expect(nextTurn.navigate).toBe("next");
  });

  test("a nested scroll surface owns the wheel until it reaches the directional edge", () => {
    expect(canConsumeDirectionalScroll({ scrollTop: 40, clientHeight: 200, scrollHeight: 600 }, -20)).toBe(true);
    expect(canConsumeDirectionalScroll({ scrollTop: 0, clientHeight: 200, scrollHeight: 600 }, -20)).toBe(false);
    expect(canConsumeDirectionalScroll({ scrollTop: 399, clientHeight: 200, scrollHeight: 600 }, 20)).toBe(false);
    expect(canConsumeDirectionalScroll({ scrollTop: 300, clientHeight: 200, scrollHeight: 600 }, 20)).toBe(true);
    expect(canConsumeDirectionalScroll({ scrollTop: 40, clientHeight: 200, scrollHeight: 600 }, 0)).toBe(false);
  });
});
