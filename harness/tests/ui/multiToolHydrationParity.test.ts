import { afterEach, describe, expect, test } from "bun:test";
import type { Message, SessionHistorySnapshot, ToolCall, TurnContent } from "../../sdk/index";
import { reconstructSessionTurns, summarizeContentBlocks, type SessionHistoryEventRow } from "../../session-history";
import { createInitialState, reduceEvent } from "../../ui/src/eventReducer";
import {
  buildLatestMoveToolCallIds,
  partitionToolRun,
} from "../../ui/src/move-tool-view";
import {
  getSessionState,
  hydrateSessionHistorySnapshot,
  loadSessionMessageDetails,
  removeSession,
} from "../../ui/src/sessionStore";
import { modus } from "../../ui/src/modusClient";

const SESSION_ID = "multi-tool-hydration-parity";
type EventFixture = { type: string; subtype?: string; data: Record<string, unknown> };

const events: EventFixture[] = [
  {
    type: "user",
    subtype: "prompt",
    data: { subtype: "prompt", message: { content: [{ type: "text", text: "run the board" }] } },
  },
  {
    type: "assistant",
    subtype: "message",
    data: { message: { content: [
      { type: "text", text: "before" },
      { type: "tool_use", id: "core-a", name: "Read", input: { path: "a.ts" } },
      {
        type: "tool_use", id: "move-a", name: "mcp__modus__modus_submit",
        input: { token: "mapi-board-instance1", data: { op: "advance", step: 1 } },
      },
      { type: "tool_use", id: "core-b", name: "Edit", input: { path: "b.ts" } },
      {
        type: "tool_use", id: "move-b", name: "mcp__modus__modus_submit",
        input: { token: "mapi-board-instance1", data: { op: "advance", step: 2 } },
      },
    ] } },
  },
  {
    type: "user",
    subtype: "tool_result",
    data: { message: { content: [
      { type: "tool_result", tool_use_id: "core-a", content: "read" },
      { type: "tool_result", tool_use_id: "move-a", content: "invalid", is_error: true },
      { type: "tool_result", tool_use_id: "core-b", content: "edited" },
      { type: "tool_result", tool_use_id: "move-b", content: "advanced" },
    ] } },
  },
  {
    type: "assistant",
    subtype: "message",
    data: { message: { content: [{ type: "text", text: "after" }] } },
  },
  { type: "result", subtype: "success", data: { subtype: "success" } },
];

function eventRows(): SessionHistoryEventRow[] {
  return events.map((event, index) => ({
    seq: index + 1,
    type: event.type,
    subtype: event.subtype ?? null,
    data: JSON.stringify(event.data),
    created_at: 1_000 + index,
  }));
}

function liveAssistant(): Message {
  let state = createInitialState(SESSION_ID);
  events.forEach((event, index) => {
    state = reduceEvent(state, {
      ...event.data,
      type: event.type,
      subtype: event.subtype ?? event.data.subtype,
    }, index + 1);
  });
  return state.messages.find((message) => message.role === "assistant")!;
}

function toolShape(tools: ToolCall[] | undefined) {
  return (tools ?? []).map((tool) => ({ id: tool.id, name: tool.name, status: tool.status }));
}

function partitionShape(tools: ToolCall[]) {
  return partitionToolRun(tools).map((part) => ({
    moveApi: part.moveApi,
    ids: part.tools.map((tool) => tool.id),
  }));
}

afterEach(() => removeSession(SESSION_ID));

describe("multi-tool live, reload, and deferred hydration parity", () => {
  test("preserves tool order, grouping, status, and latest-call identity", async () => {
    const live = liveAssistant();
    const full = reconstructSessionTurns(eventRows())
      .find((turn): turn is TurnContent => turn.role === "assistant")!;
    const summaryBlocks = summarizeContentBlocks(full.contentBlocks!);
    const snapshot: SessionHistorySnapshot = {
      sessionId: SESSION_ID,
      status: "done",
      model: "test",
      cwd: "C:/project",
      additionalDirectories: [],
      loadProjectSettings: true,
      agentConfig: {
        toolStates: {}, model: "test", provider: "codex", effort: "high",
        maxTurns: "", providerControls: {},
      },
      messages: [{
        role: "assistant",
        seq: full.seq,
        text: full.text,
        timestamp: full.timestamp,
        contentBlocks: summaryBlocks,
        detailsDeferred: true,
        deferredToolCallCount: full.toolCalls!.length,
      }],
      lastSeq: events.length,
      createdAt: 1_000,
    };

    hydrateSessionHistorySnapshot(snapshot);
    const deferred = getSessionState(SESSION_ID)!.messages[0]!;
    expect(deferred.detailsDeferred).toBe(true);
    expect(deferred.contentBlocks?.map((block) => block.type)).toEqual(["text", "deferred", "text"]);

    const originalGetMessages = modus.getMessages;
    modus.getMessages = async () => full;
    try {
      await loadSessionMessageDetails(SESSION_ID, full.seq);
    } finally {
      modus.getMessages = originalGetMessages;
    }

    const hydrated = getSessionState(SESSION_ID)!.messages[0]!;
    expect(hydrated.detailsDeferred).toBe(false);
    expect(toolShape(hydrated.toolCalls)).toEqual(toolShape(live.toolCalls));

    const livePartitions = partitionShape(live.toolCalls!);
    const orderedHydratedTools = hydrated.contentBlocks!
      .filter((block): block is Extract<typeof block, { type: "tool_call" }> => block.type === "tool_call")
      .map((block) => block.toolCall);
    expect(partitionShape(orderedHydratedTools)).toEqual(livePartitions);
    expect(livePartitions).toEqual([
      { moveApi: false, ids: ["core-a"] },
      { moveApi: true, ids: ["move-a"] },
      { moveApi: false, ids: ["core-b"] },
      { moveApi: true, ids: ["move-b"] },
    ]);
    expect(buildLatestMoveToolCallIds([hydrated]).get("mapi-board-instance1")).toBe("move-b");
  });
});
