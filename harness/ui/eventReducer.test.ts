import { describe, expect, test } from "bun:test";
import { createInitialState, reduceEvent } from "./src/eventReducer";

describe("eventReducer user prompt dedup", () => {
  /** What move-runner injects: the gathered block, then a blank line, then the prompt. */
  const withMoveContext = (move: string, context: string, prompt: string) =>
    `<!-- move:${move} -->\n${context}\n<!-- /move:${move} -->\n\n${prompt}`;

  test("folds the echoed turn into the optimistic message when a move is attached", () => {
    let state = createInitialState("ses-test");
    // The composer inserts exactly what the user typed.
    state.messages.push({ id: "optimistic", role: "user", content: "how do profiles work?", timestamp: 1 });

    state = reduceEvent(state, {
      type: "user",
      subtype: "prompt",
      message: { content: withMoveContext("modus-brain", "brain instructions", "how do profiles work?") },
    }, 2);

    const userMessages = state.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.id).toBe("optimistic");
    // Adopted the injected content so the move disclosure renders on it.
    expect(userMessages[0]!.content).toContain("<!-- move:modus-brain -->");
    expect(userMessages[0]!.content).toContain("how do profiles work?");
  });

  test("still dedups a plain turn with no injected context", () => {
    let state = createInitialState("ses-test");
    state.messages.push({ id: "optimistic", role: "user", content: "hello", timestamp: 1, seq: 1 });

    state = reduceEvent(state, { type: "user", subtype: "prompt", message: { content: "hello" } }, 2);

    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  test("appends a genuinely different prompt", () => {
    let state = createInitialState("ses-test");
    state.messages.push({ id: "optimistic", role: "user", content: "hello", timestamp: 1, seq: 1 });

    state = reduceEvent(state, {
      type: "user",
      subtype: "prompt",
      message: { content: withMoveContext("modus-brain", "brain instructions", "a different question") },
    }, 2);

    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(2);
  });
});

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

  test("preserves finalized provider text and tool order", () => {
    let state = createInitialState("ses-test");
    state = reduceEvent(state, {
      type: "assistant",
      message: { content: [{ type: "text", text: "before" }] },
    }, 1);
    state = reduceEvent(state, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.ts" } }] },
    }, 2);

    expect(state.messages.at(-1)?.contentBlocks?.map((block) => block.type)).toEqual([
      "text",
      "tool_call",
    ]);
  });
});
