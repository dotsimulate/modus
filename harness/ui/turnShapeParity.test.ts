/**
 * The two message pipelines must produce the same shape.
 *
 * A conversation is built twice: live, by `reduceEvent` folding SSE events as
 * they arrive, and on reload, by `reconstructSessionTurns` replaying the durable
 * events. Nothing forced those two to agree, and they didn't — the reducer
 * started a new assistant bubble as soon as any tool call completed, so a
 * sequential agent loop rendered as one bubble per tool live and as a single
 * turn after a reload. The same conversation had two different structures
 * depending on how you arrived at it.
 *
 * These tests pin the agreement. If a change to either pipeline breaks parity
 * here, that is the regression — not the test.
 */

import { describe, expect, test } from "bun:test";
import { createInitialState, reduceEvent } from "./src/eventReducer";
import { reconstructSessionTurns, type SessionHistoryEventRow } from "../session-history";

type Ev = { type: string; subtype?: string | null; data: Record<string, unknown> };

/** One comparable description of an assistant turn, from either pipeline. */
type Shape = { text: string; thinking: string; tools: string[] };

function live(events: Ev[]): Shape[] {
  let state = createInitialState("parity");
  events.forEach((e, index) => {
    state = reduceEvent(state, { ...e.data, type: e.type, subtype: e.subtype ?? e.data.subtype }, index + 1);
  });
  return state.messages
    .filter((m) => m.role === "assistant")
    .map((m) => ({
      text: m.content,
      thinking: m.thinking ?? "",
      tools: (m.toolCalls ?? []).map((tc) => tc.name),
    }));
}

function history(events: Ev[]): Shape[] {
  const rows: SessionHistoryEventRow[] = events.map((e, index) => ({
    seq: index + 1,
    type: e.type,
    subtype: e.subtype ?? null,
    data: JSON.stringify(e.data),
    created_at: 1_000 + index,
  }));
  return reconstructSessionTurns(rows)
    .filter((t) => t.role === "assistant")
    .map((t) => ({
      text: t.text,
      thinking: t.thinking ?? "",
      tools: (t.toolCalls ?? []).map((tc) => tc.name),
    }));
}

const prompt = (text: string): Ev => ({
  type: "user",
  subtype: "prompt",
  data: { subtype: "prompt", message: { content: [{ type: "text", text }] } },
});

const assistant = (blocks: unknown[]): Ev => ({
  type: "assistant",
  subtype: "message",
  data: { message: { content: blocks } },
});

const toolResult = (id: string, content: string): Ev => ({
  type: "user",
  subtype: "tool_result",
  data: { message: { content: [{ type: "tool_result", tool_use_id: id, content }] } },
});

const result = (): Ev => ({
  type: "result",
  subtype: "success",
  data: { subtype: "success", harness_duration_ms: 500 },
});

/** The shape that used to differ: every result lands before the next call. */
function sequentialLoop(toolCount: number): Ev[] {
  const events: Ev[] = [prompt("do the thing")];
  for (let i = 0; i < toolCount; i++) {
    events.push(assistant([
      ...(i === 0 ? [{ type: "text", text: "starting" }] : []),
      { type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/x/${i}.ts` } },
    ]));
    events.push(toolResult(`t${i}`, "ok"));
  }
  events.push(assistant([{ type: "text", text: "done" }]));
  events.push(result());
  return events;
}

describe("live and reloaded turns have the same shape", () => {
  test("a sequential tool loop is one turn in both pipelines", () => {
    const events = sequentialLoop(6);
    const liveShape = live(events);

    expect(liveShape).toHaveLength(1);
    expect(liveShape[0]!.tools).toHaveLength(6);
    expect(liveShape).toEqual(history(events));
  });

  test("parallel tool calls in one round agree too", () => {
    const events: Ev[] = [
      prompt("go"),
      assistant([
        { type: "text", text: "reading both" },
        { type: "tool_use", id: "a", name: "Read", input: {} },
        { type: "tool_use", id: "b", name: "Grep", input: {} },
      ]),
      toolResult("a", "ok"),
      toolResult("b", "ok"),
      assistant([{ type: "text", text: "done" }]),
      result(),
    ];
    expect(live(events)).toEqual(history(events));
  });

  test("thinking, text and tools interleaved across rounds agree", () => {
    const events: Ev[] = [
      prompt("go"),
      assistant([
        { type: "thinking", thinking: "let me look" },
        { type: "text", text: "checking" },
        { type: "tool_use", id: "a", name: "Read", input: {} },
      ]),
      toolResult("a", "ok"),
      assistant([
        { type: "thinking", thinking: "now edit" },
        { type: "tool_use", id: "b", name: "Edit", input: {} },
      ]),
      toolResult("b", "ok"),
      assistant([{ type: "text", text: "finished" }]),
      result(),
    ];
    const liveShape = live(events);
    expect(liveShape).toEqual(history(events));
    // Text from every round survives rather than the last one winning.
    expect(liveShape[0]!.text).toBe("checkingfinished");
    expect(liveShape[0]!.thinking).toBe("let me looknow edit");
    expect(liveShape[0]!.tools).toEqual(["Read", "Edit"]);
  });

  test("consecutive turns stay separate in both pipelines", () => {
    const events = [...sequentialLoop(2), ...sequentialLoop(3)];
    const liveShape = live(events);
    expect(liveShape).toHaveLength(2);
    expect(liveShape.map((s) => s.tools.length)).toEqual([2, 3]);
    expect(liveShape).toEqual(history(events));
  });

  test("a turn with no tools at all agrees", () => {
    const events: Ev[] = [prompt("hi"), assistant([{ type: "text", text: "hello" }]), result()];
    expect(live(events)).toEqual(history(events));
  });
});

describe("streaming into a merged turn", () => {
  const delta = (text: string): Ev => ({
    type: "stream_event",
    data: { event: { type: "content_block_delta", delta: { type: "text_delta", text } } },
  });

  test("a later round's stream does not erase earlier rounds", () => {
    // Round 1 streams and is confirmed, a tool runs, then round 2 streams.
    // Mid-stream of round 2 the bubble must still show round 1's text.
    let state = createInitialState("parity");
    let seq = 0;
    const step = (e: Ev) => {
      state = reduceEvent(state, { ...e.data, type: e.type, subtype: e.subtype ?? e.data.subtype }, ++seq);
    };

    step(prompt("go"));
    step(delta("start"));
    step(delta("ing"));
    step(assistant([
      { type: "text", text: "starting" },
      { type: "tool_use", id: "a", name: "Read", input: {} },
    ]));
    step(toolResult("a", "ok"));
    step(delta("fin"));

    const assistantMsgs = state.messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]!.content).toBe("startingfin");
  });

  test("the settled turn matches history once the round is confirmed", () => {
    const events: Ev[] = [
      prompt("go"),
      delta("start"),
      delta("ing"),
      assistant([
        { type: "text", text: "starting" },
        { type: "tool_use", id: "a", name: "Read", input: {} },
      ]),
      toolResult("a", "ok"),
      delta("fin"),
      delta("ished"),
      assistant([{ type: "text", text: "finished" }]),
      result(),
    ];
    // History never sees stream events; the durable rows are the same minus deltas.
    const durable = events.filter((e) => e.type !== "stream_event");
    expect(live(events)).toEqual(history(durable));
  });
});

/**
 * Provider failures are turns too.
 *
 * The reducer gained a case for terminal `error` events, but the durable half
 * was never wired: the event reached live subscribers only, was never persisted,
 * and `reconstructSessionTurns` had no branch for it. So a failed send showed a
 * reason live and reconstructed as a silent session — the session list went red
 * with nothing behind it. These pin the halves together.
 */
function liveNotices(events: Ev[]): string[] {
  let state = createInitialState("parity");
  events.forEach((e, index) => {
    state = reduceEvent(state, { ...e.data, type: e.type, subtype: e.subtype ?? e.data.subtype }, index + 1);
  });
  return state.messages.filter((m) => m.role === "system").map((m) => m.content);
}

function historyNotices(events: Ev[]): string[] {
  const rows: SessionHistoryEventRow[] = events.map((e, index) => ({
    seq: index + 1,
    type: e.type,
    subtype: e.subtype ?? null,
    data: JSON.stringify(e.data),
    created_at: 1_000 + index,
  }));
  return reconstructSessionTurns(rows).filter((t) => t.role === "system").map((t) => t.text);
}

const failure = (data: Record<string, unknown>): Ev => ({ type: "error", data });

describe("provider failures survive a reload", () => {
  test("a spawn failure before any output reads the same in both pipelines", () => {
    const events: Ev[] = [prompt("go"), failure({ error: "cursor-agent exited with code 1" })];
    expect(liveNotices(events)).toEqual(["cursor-agent exited with code 1"]);
    expect(liveNotices(events)).toEqual(historyNotices(events));
  });

  test("a failure mid-turn keeps the assistant work and the reason, in both", () => {
    const events: Ev[] = [
      prompt("go"),
      assistant([
        { type: "text", text: "starting" },
        { type: "tool_use", id: "a", name: "Read", input: {} },
      ]),
      toolResult("a", "ok"),
      failure({ error: "provider died" }),
    ];
    expect(live(events)).toEqual(history(events));
    expect(liveNotices(events)).toEqual(["provider died"]);
    expect(liveNotices(events)).toEqual(historyNotices(events));
  });

  test("the {message} shape reads identically to the {error} shape", () => {
    // Providers broadcast `error`; the session manager's delivery failures use
    // `message`. The reducer read only `error`, so this shape lost its reason.
    const viaMessage: Ev[] = [prompt("go"), failure({ message: "Message delivery failed: boom" })];
    expect(liveNotices(viaMessage)).toEqual(["Message delivery failed: boom"]);
    expect(liveNotices(viaMessage)).toEqual(historyNotices(viaMessage));
  });

  test("an error carrying no text still renders a notice rather than an empty one", () => {
    const events: Ev[] = [prompt("go"), failure({})];
    expect(liveNotices(events)[0]).toBeTruthy();
    expect(liveNotices(events)).toEqual(historyNotices(events));
  });
});
