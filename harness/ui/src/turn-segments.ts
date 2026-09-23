/**
 * The turn model, shared by every surface that renders a conversation.
 *
 * Two shapes live here, both pure:
 *
 * - `segmentContentBlocks` walks one message's provider-ordered content blocks
 *   into runs, so consecutive tool calls become a single segment rather than N
 *   independent ones.
 * - `buildTurns` walks a message list into turns at user-prompt boundaries.
 *
 * Both were previously inlined at their call sites — the segmenter inside
 * `MessageBubble`, the turn walk separately in `ChatView`'s file-edit grouping
 * and again in `ChatScrollSpine`'s tick numbering. Three private copies of the
 * same walk is exactly how the live and hydrated message pipelines drifted into
 * disagreeing about what a turn was, so this module is the single answer and is
 * pinned by tests rather than by whichever renderer happened to be looked at
 * last.
 *
 * Deliberately free of React and of the SDK client: a pure module is testable
 * with plain `bun:test`, and there is no testing-library in this repo.
 */

import type { Message, MessageContentBlock, ToolCall } from "../../sdk/index";

// ── Content blocks → segments ──

export type RenderSegment =
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; thinking: string }
  | { kind: "tools"; key: string; tools: ToolCall[] }
  | { kind: "deferred"; key: string; hasThinking: boolean; count: number; toolNames: Record<string, number> };

/**
 * Consecutive tool calls belong together, so they are emitted as one run rather
 * than N adjacent segments. Walking the blocks into segments before rendering
 * keeps that grouping out of the render path, and gives a deferred placeholder
 * the same shape as a loaded run — which is what lets both render through one
 * component.
 */
export function segmentContentBlocks(msgId: string, blocks: MessageContentBlock[]): RenderSegment[] {
  const segments: RenderSegment[] = [];
  let run: ToolCall[] = [];
  const flushRun = (index: number) => {
    if (run.length === 0) return;
    // Appending calls must not change the parent key and remount existing rows.
    segments.push({ kind: "tools", key: `${msgId}:run:${index - run.length}`, tools: run });
    run = [];
  };

  blocks.forEach((block, index) => {
    if (block.type === "tool_call") {
      run.push(block.toolCall);
      return;
    }
    flushRun(index);
    if (block.type === "text") {
      if (block.text) segments.push({ kind: "text", key: `${msgId}:text:${index}`, text: block.text });
    } else if (block.type === "thinking") {
      segments.push({ kind: "thinking", key: `${msgId}:thinking:${index}`, thinking: block.thinking });
    } else {
      segments.push({
        kind: "deferred",
        key: `${msgId}:deferred:${index}`,
        hasThinking: block.hasThinking,
        count: block.toolCallCount,
        toolNames: block.toolNames ?? {},
      });
    }
  });
  flushRun(blocks.length);
  return segments;
}

/**
 * A message that predates ordered content blocks still has to segment. Falling
 * back to the flat fields keeps one render path for both, in the same order the
 * transcript has always used: deferred marker, thinking, text, tools.
 */
export function segmentMessage(msg: Message): RenderSegment[] {
  if (msg.contentBlocks?.length) return segmentContentBlocks(msg.id, msg.contentBlocks);

  const segments: RenderSegment[] = [];
  if (msg.detailsDeferred) {
    segments.push({
      kind: "deferred",
      key: `${msg.id}:deferred:flat`,
      hasThinking: !!msg.deferredHasThinking,
      count: msg.deferredToolCallCount ?? 0,
      toolNames: {},
    });
  }
  if (msg.thinking) {
    segments.push({ kind: "thinking", key: `${msg.id}:thinking:flat`, thinking: msg.thinking });
  }
  if (msg.content) {
    segments.push({ kind: "text", key: `${msg.id}:text:flat`, text: msg.content });
  }
  if (msg.toolCalls?.length) {
    segments.push({ kind: "tools", key: `${msg.id}:run:flat`, tools: msg.toolCalls });
  }
  return segments;
}

/**
 * The part of a streaming round that no finalized block holds yet.
 *
 * Deltas write the flat `thinking` and `content` fields as the finalized blocks
 * plus the round in progress; the round only becomes blocks once the provider
 * confirms it. A bubble that already has blocks renders from them alone, so a
 * later round's reasoning and prose stayed invisible until it was confirmed.
 * Only a flat field that extends its blocks has a tail — anything else is left
 * to the blocks.
 */
export function streamingTailSegments(msg: Message): RenderSegment[] {
  if (!msg.contentBlocks?.length) return [];
  const segments: RenderSegment[] = [];
  const thinking = unconfirmedTail(msg.thinking, msg.contentBlocks, "thinking");
  if (thinking) segments.push({ kind: "thinking", key: `${msg.id}:thinking:tail`, thinking });
  const text = unconfirmedTail(msg.content, msg.contentBlocks, "text");
  if (text) segments.push({ kind: "text", key: `${msg.id}:text:tail`, text });
  return segments;
}

function unconfirmedTail(
  flat: string | undefined,
  blocks: MessageContentBlock[],
  type: "text" | "thinking",
): string {
  if (!flat) return "";
  let confirmed = "";
  for (const block of blocks) {
    if (type === "text" && block.type === "text") confirmed += block.text;
    if (type === "thinking" && block.type === "thinking") confirmed += block.thinking;
  }
  return flat.length > confirmed.length && flat.startsWith(confirmed) ? flat.slice(confirmed.length) : "";
}

/** Tally a loaded run so its header reads the same as a deferred one's. */
export function tallyToolNames(tools: ToolCall[]): Record<string, number> {
  const names: Record<string, number> = {};
  for (const tool of tools) names[tool.name] = (names[tool.name] ?? 0) + 1;
  return names;
}

// ── Messages → turns ──

export type ChatTurn = {
  /**
   * 1-based position in the whole conversation, not in the loaded window.
   * History pages in from the newest end, so numbering from the loaded array
   * would renumber every turn each time an older page arrives.
   */
  number: number;
  /** Stable across re-renders and across pagination: the opening message's id. */
  key: string;
  /**
   * The prompt that opened this turn. Null for a turn with no prompt of its
   * own — a resumed session whose loaded window starts mid-conversation, or an
   * agent that spoke first.
   */
  prompt: Message | null;
  /** Assistant and system messages belonging to this turn, in arrival order. */
  body: Message[];
  /**
   * Seq to address this turn by. The prompt's when there is one, otherwise the
   * first body message's — so a headless leading turn is still selectable.
   */
  seq?: number;
};

/**
 * Group a flat message list into turns at user-prompt boundaries.
 *
 * `turnOffset` is the server's count of user prompts before the oldest loaded
 * message (`olderTurnCount`). Without it a paginated transcript numbers its
 * oldest loaded turn "1" regardless of where it actually sits.
 */
export function buildTurns(messages: Message[], turnOffset = 0): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn | null = null;
  let number = turnOffset;

  for (const msg of messages) {
    if (msg.role === "user") {
      number += 1;
      current = {
        number,
        key: msg.id,
        prompt: msg,
        body: [],
        ...(msg.seq != null ? { seq: msg.seq } : {}),
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      // Leading assistant/system content with no prompt above it. It is still a
      // turn — it has to be addressable, or the first thing in a resumed window
      // is unreachable from an index.
      number += 1;
      current = {
        number,
        key: msg.id,
        prompt: null,
        body: [],
        ...(msg.seq != null ? { seq: msg.seq } : {}),
      };
      turns.push(current);
    }
    current.body.push(msg);
    if (current.seq == null && msg.seq != null) current.seq = msg.seq;
  }

  return turns;
}

/** Locate a turn by the seq of any message inside it. */
export function findTurnBySeq(turns: ChatTurn[], seq: number): ChatTurn | null {
  for (const turn of turns) {
    if (turn.seq === seq) return turn;
    if (turn.prompt?.seq === seq) return turn;
    if (turn.body.some((msg) => msg.seq === seq)) return turn;
  }
  return null;
}

/**
 * Every tool call in a turn, flattened in order. Sub-agent tools are not
 * included: `TurnContent.toolCalls` is flat and history never reconstructs
 * `subMessages`, so counting them here would make a live turn and the same turn
 * after reload disagree.
 */
export function turnToolCalls(turn: ChatTurn): ToolCall[] {
  const tools: ToolCall[] = [];
  for (const msg of turn.body) {
    for (const segment of segmentMessage(msg)) {
      if (segment.kind === "tools") tools.push(...segment.tools);
    }
  }
  return tools;
}

/**
 * Weight of a turn's prose, in characters. A hint for index marks only — it
 * counts the text a reader would see, and deliberately not tool payloads, which
 * are orders of magnitude larger and would flatten every prose mark to nothing.
 */
export function turnProseWeight(turn: ChatTurn): number {
  let weight = 0;
  for (const msg of turn.body) {
    for (const segment of segmentMessage(msg)) {
      if (segment.kind === "text") weight += segment.text.length;
    }
  }
  return weight;
}
