import { describe, expect, test } from "bun:test";
import { createInitialState, reduceEvent } from "./src/eventReducer";

describe("eventReducer stream replacement semantics", () => {
  test("keeps Codex reconnect progress non-terminal", () => {
    let state = createInitialState("ses-test");
    state.status = "running";
    state = reduceEvent(state, {
      type: "system",
      subtype: "provider_reconnecting",
      provider: "codex",
      attempt: 2,
      maxAttempts: 5,
    }, 1);

    expect(state.status).toBe("running");
    expect(state.messages.at(-1)?.role).toBe("system");
    expect(state.messages.at(-1)?.content).toBe("Codex is reconnecting (2/5). The turn is still running.");
  });

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
