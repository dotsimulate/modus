import { describe, expect, test } from "bun:test";
import { createInitialState, reduceEvent } from "./src/eventReducer";

describe("eventReducer stream replacement semantics", () => {
  test("uses fullText snapshots instead of appending repeated cumulative text", () => {
    let state = createInitialState("ses-test");
    state = reduceEvent(state, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hel" },
      },
      provider: "codex",
      fullText: "Hel",
    }, 1);

    state = reduceEvent(state, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
      provider: "codex",
      fullText: "Hello",
    }, 2);

    expect(state._streamingText).toBe("Hello");
    expect(state.messages.at(-1)?.content).toBe("Hello");
  });

  test("still appends plain text deltas when no fullText snapshot is present", () => {
    let state = createInitialState("ses-test");
    state = reduceEvent(state, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hel" },
      },
      provider: "claude-code",
    }, 1);

    state = reduceEvent(state, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "lo" },
      },
      provider: "claude-code",
    }, 2);

    expect(state._streamingText).toBe("Hello");
    expect(state.messages.at(-1)?.content).toBe("Hello");
  });
});
