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
      previousSeq: 10,
      nextSeq: 30,
      nextIsLatest: true,
    });
    expect(resolveTurnNavigation(entries, turnWithBlocks([], 3, 30))).toEqual({
      current: 3,
      total: 3,
      previousSeq: 20,
      nextSeq: null,
      nextIsLatest: false,
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
