import { describe, expect, test } from "bun:test";
import { createInitialState, reduceEvent, splitToolResultContent, TOOL_RESULT_STORE_LIMIT } from "./src/eventReducer";

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

describe("tool result content", () => {
  const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("lifts base64 images out of the result instead of stringifying them", () => {
    const { text, images } = splitToolResultContent([
      { type: "text", text: "here is the screenshot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } },
    ]);

    expect(images).toEqual([{ type: "image", mediaType: "image/png", data: PIXEL }]);
    // The regression this whole change exists for: the base64 must not reach
    // the text, where it was inlined by JSON.stringify and then cut mid-payload.
    expect(text).toBe("here is the screenshot");
    expect(text).not.toContain(PIXEL);
  });

  test("passes a plain string result through untouched", () => {
    expect(splitToolResultContent("ok")).toEqual({ text: "ok", images: [] });
  });

  test("defaults a missing media type rather than dropping the image", () => {
    const { images } = splitToolResultContent([
      { type: "image", source: { type: "base64", data: PIXEL } },
    ]);
    expect(images[0]?.mediaType).toBe("image/png");
  });

  test("keeps unknown block kinds visible as text", () => {
    const { text } = splitToolResultContent([{ type: "resource", uri: "file://x" }]);
    expect(text).toContain("file://x");
  });

  test("handles empty and nullish content without throwing", () => {
    expect(splitToolResultContent(null)).toEqual({ text: "", images: [] });
    expect(splitToolResultContent([])).toEqual({ text: "", images: [] });
    expect(splitToolResultContent({ a: 1 }).text).toBe('{"a":1}');
  });

  test("an image-only result yields no text at all", () => {
    const { text, images } = splitToolResultContent([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: PIXEL } },
    ]);
    expect(text).toBe("");
    expect(images).toHaveLength(1);
  });

  test("a tool_result event reaches the tool call as images, not base64 text", () => {
    let state = createInitialState("ses-img");
    state = reduceEvent(state, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Screenshot", input: {} }] },
    }, 1);
    state = reduceEvent(state, {
      type: "user",
      isSynthetic: true,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            { type: "text", text: "captured" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } },
          ],
        }],
      },
    }, 2);

    const tool = state.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === "t1");
    expect(tool?.result).toBe("captured");
    expect(tool?.images).toHaveLength(1);
    expect(tool?.result).not.toContain(PIXEL);
  });

  test("ordinary output survives well past the old 2000-character cap", () => {
    const long = "x".repeat(50_000);
    let state = createInitialState("ses-long");
    state = reduceEvent(state, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] },
    }, 1);
    state = reduceEvent(state, {
      type: "user",
      isSynthetic: true,
      message: { content: [{ type: "tool_result", tool_use_id: "t2", content: long }] },
    }, 2);

    const tool = state.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === "t2");
    expect(tool?.result).toHaveLength(50_000);
    // Nothing was dropped, so nothing should claim it was.
    expect(tool?.resultFullLength).toBeUndefined();
  });

  test("records the true size when the store limit does bite", () => {
    const huge = "y".repeat(TOOL_RESULT_STORE_LIMIT + 1234);
    let state = createInitialState("ses-huge");
    state = reduceEvent(state, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: {} }] },
    }, 1);
    state = reduceEvent(state, {
      type: "user",
      isSynthetic: true,
      message: { content: [{ type: "tool_result", tool_use_id: "t3", content: huge }] },
    }, 2);

    const tool = state.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === "t3");
    expect(tool?.result).toHaveLength(TOOL_RESULT_STORE_LIMIT);
    expect(tool?.resultFullLength).toBe(TOOL_RESULT_STORE_LIMIT + 1234);
  });
});
