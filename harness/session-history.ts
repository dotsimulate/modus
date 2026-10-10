import type { TurnContent, TurnContentBlock, TurnToolCall } from "./db";
import { hasTurnStats, turnMetaFromResultEvent, type TurnMeta } from "./turn-meta";
import { providerErrorDisplayText } from "./provider-error";

/** Keep the existing weight threshold and ordered placeholders when deferring details. */
export function summarizeTurnDetails(turn: TurnContent): TurnContent {
  if (turn.role !== "assistant" || estimateTurnDetailBytes(turn) < 32_768) return turn;
  const deferredToolCallCount = turn.toolCalls?.length ?? 0;
  const { thinking: _thinking, toolCalls: _toolCalls, ...summary } = turn;
  return {
    ...summary,
    ...(turn.contentBlocks ? { contentBlocks: summarizeContentBlocks(turn.contentBlocks) } : {}),
    detailsDeferred: true,
    deferredHasThinking: !!turn.thinking,
    ...(deferredToolCallCount > 0 ? { deferredToolCallCount } : {}),
  };
}

export type SessionHistoryEventRow = {
  seq: number;
  type: string;
  subtype: string | null;
  data: string;
  created_at: number;
  /** Optional row id for stable wall-clock ordering when seq collides. */
  id?: number;
};

/**
 * Chronological order for reconstruction.
 *
 * `seq` is the normal key, but providers that restart an ActiveSession at
 * `seq: 0` (without seeding from getMaxSeq) write colliding seq numbers.
 * Wall-clock + row id keeps turns intact when that happens.
 */
export function compareSessionHistoryEvents(
  a: SessionHistoryEventRow,
  b: SessionHistoryEventRow,
): number {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  const aId = a.id ?? 0;
  const bId = b.id ?? 0;
  if (aId !== bId) return aId - bId;
  return a.seq - b.seq;
}

/**
 * A turn is only worth deferring if its payload is actually large.
 *
 * Sums the fields that dominate a serialized turn without building the string —
 * deciding not to ship four megabytes should not cost four megabytes of
 * stringify first. Approximate on purpose: this picks a side of a threshold, it
 * is not accounting.
 */
export function estimateTurnDetailBytes(turn: TurnContent): number {
  let bytes = turn.thinking?.length ?? 0;
  for (const toolCall of turn.toolCalls ?? []) {
    bytes += toolCall.name.length + (toolCall.result?.length ?? 0);
    for (const [key, value] of Object.entries(toolCall.input ?? {})) {
      // Non-strings are bounded and small once serialized; a flat estimate
      // keeps this O(fields) instead of recursing arbitrary JSON.
      bytes += key.length + (typeof value === "string" ? value.length : 32);
    }
  }
  return bytes;
}

/** Keep text positions while replacing contiguous heavy provider blocks with
 * lightweight placeholders. Text uses offsets into TurnContent.text so the
 * summary response does not send the complete conversation twice.
 *
 * The placeholder carries a per-tool-name tally so a deferred run can render the
 * same collapsed header as a loaded one — the user sees the same summary line
 * either way, and expanding is what differs. */
export function summarizeContentBlocks(blocks: TurnContentBlock[]): TurnContentBlock[] {
  const summary: TurnContentBlock[] = [];
  let textOffset = 0;
  let deferred: Extract<TurnContentBlock, { type: "deferred" }> | null = null;
  const flushDeferred = () => {
    if (!deferred) return;
    summary.push(deferred);
    deferred = null;
  };

  for (const block of blocks) {
    if (block.type === "text") {
      flushDeferred();
      const textLength = block.text?.length ?? 0;
      summary.push({ type: "text", textStart: textOffset, textEnd: textOffset + textLength });
      textOffset += textLength;
      continue;
    }
    if (!deferred) deferred = { type: "deferred", hasThinking: false, toolCallCount: 0, toolNames: {} };
    if (block.type === "thinking") deferred.hasThinking = true;
    if (block.type === "tool_call") {
      deferred.toolCallCount++;
      const name = block.toolCall.name;
      deferred.toolNames[name] = (deferred.toolNames[name] ?? 0) + 1;
    }
  }
  flushDeferred();
  return summary;
}

/**
 * Semantic messages are authoritative only through their latest materialized
 * assistant turn. If a newer raw assistant event exists, the provider ended or
 * was interrupted before that turn was finalized and raw reconstruction is the
 * only complete history source.
 */
export function shouldRecoverSessionHistory(
  semanticTurns: TurnContent[],
  latestRawAssistantSeq: number,
): boolean {
  if (latestRawAssistantSeq <= 0) return false;
  const latestSemanticAssistantSeq = semanticTurns.reduce(
    (max, turn) => turn.role === "assistant" && turn.seq > max ? turn.seq : max,
    0,
  );
  return latestRawAssistantSeq > latestSemanticAssistantSeq;
}

/**
 * Subtype of the user event written when a message is queued, before any
 * provider has seen it. It exists so the text survives a backend death between
 * persistence and dispatch.
 *
 * Deliberately not `"prompt"`: the provider emits a real `user/prompt` event
 * when the message is actually delivered, so a `"prompt"` row here means two
 * durable rows per message. Anything rebuilt from the event stream then shows
 * every follow-up twice — and for a message queued mid-turn the queue-time copy
 * also lands at the wrong point in the transcript, because it is ordered by
 * when the user hit send rather than by when the agent received it.
 *
 * Sessions written while most providers still skipped that delivery echo hold
 * only this row for their follow-ups. Reconstruction recovers those; see
 * {@link reconstructSessionTurns}.
 */
export const QUEUED_PROMPT_SUBTYPE = "prompt_pending";

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  let text = "";
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") text += block.text;
    }
  }
  return text;
}

/**
 * Rebuild user/assistant turns from durable non-stream events.
 *
 * `result` events close a turn *and* carry its usage. Reading only the boundary
 * and discarding the payload is what used to make a reloaded session lose every
 * cost, token, and context figure it had shown while streaming.
 *
 * A queued row is a turn only when its delivery left no `user/prompt` row: an
 * assistant reply then opens with no prompt before it, and the oldest queued
 * message still waiting is what it answers. Providers deliver the queue as soon
 * as a turn ends, so a message queued before the last turn ended loses to one
 * sent after it: a leftover still waiting once the agent took a fresh message
 * was cancelled or dropped by a stop. A prompt that opens a turn retires those
 * leftovers the same way; one steered into a running turn does not. A queued
 * row whose delivery was recorded, or that was never delivered, stays hidden.
 */
export function reconstructSessionTurns(
  events: SessionHistoryEventRow[],
  fallbackModel = "",
): TurnContent[] {
  const turns: TurnContent[] = [];
  // Queued messages not yet matched to a delivery, oldest first. `at` is the
  // event's position, compared against where the last turn ended.
  let queued: { at: number; seq: number; text: string; timestamp: number }[] = [];
  let lastEndAt = -1;
  let promptOpen = false;
  let current: {
    text: string;
    thinking: string;
    toolCalls: Map<string, TurnToolCall>;
    contentBlocks: TurnContentBlock[];
    seq: number;
    timestamp: number;
    uuid?: string;
  } | null = null;

  // Callers should already order by created_at; sort defensively so a
  // seq-only query cannot scramble multi-turn sessions with reused seqs.
  const ordered = events.length > 1
    ? [...events].sort(compareSessionHistoryEvents)
    : events;

  for (const [at, evt] of ordered.entries()) {
    let d: any;
    try { d = JSON.parse(evt.data); } catch { continue; }

    if (evt.type === "user") {
      // Queue-time durability row, not yet a transcript turn — the
      // dispatch-time copy is the one that carries the moment the agent
      // actually received it.
      if (evt.subtype === QUEUED_PROMPT_SUBTYPE || d.subtype === QUEUED_PROMPT_SUBTYPE) {
        const text = userMessageText(d.message?.content);
        if (text) queued.push({ at, seq: evt.seq, text, timestamp: evt.created_at });
        continue;
      }
      if (evt.subtype === "prompt" || d.subtype === "prompt") {
        const text = userMessageText(d.message?.content);
        const delivered = queued.findIndex((entry) => entry.text === text);
        if (delivered >= 0) queued.splice(delivered, 1);
        if (current) {
          // Steered into the running turn: anything queued is still waiting.
          turns.push(materializeAssistantTurn(current, current.seq));
          current = null;
        } else {
          // Opens a turn of its own, so what was queued before the last turn
          // ended is never going to be.
          queued = queued.filter((entry) => entry.at > lastEndAt);
        }
        if (text) turns.push({ role: "user", seq: evt.seq, text, timestamp: evt.created_at });
        promptOpen = true;
      } else if (current) {
        const content = d.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
            const toolCall = current.toolCalls.get(block.tool_use_id);
            if (!toolCall) continue;
            toolCall.result = typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "");
            toolCall.status = block.is_error ? "error" : "completed";
          }
        }
      }
    }

    if (evt.type === "assistant") {
      if (!current) {
        if (!promptOpen && queued.length > 0) {
          const fresh = queued.findIndex((entry) => entry.at > lastEndAt);
          if (fresh > 0) queued = queued.slice(fresh);
          const answered = queued.shift()!;
          turns.push({ role: "user", seq: answered.seq, text: answered.text, timestamp: answered.timestamp });
        }
        promptOpen = false;
        current = {
          text: "",
          thinking: "",
          toolCalls: new Map(),
          contentBlocks: [],
          seq: evt.seq,
          timestamp: evt.created_at,
          ...(typeof d.uuid === "string" ? { uuid: d.uuid } : {}),
        };
      } else if (!current.uuid && typeof d.uuid === "string") {
        current.uuid = d.uuid;
      }
      // If the turn never receives a terminal event, its visible timestamp is
      // the last assistant content/tool event that actually landed.
      current.timestamp = evt.created_at;
      const content = d.message?.content;
      if (typeof content === "string" && content) {
        current.text += content;
        current.contentBlocks.push({ type: "text", text: content });
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string" && block.text) {
            current.text += block.text;
            current.contentBlocks.push({ type: "text", text: block.text });
          }
          if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
            current.thinking += block.thinking;
            current.contentBlocks.push({ type: "thinking", thinking: block.thinking });
          }
          if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            const toolCall: TurnToolCall = { id: block.id, name: block.name, input: block.input ?? {} };
            current.toolCalls.set(block.id, toolCall);
            current.contentBlocks.push({ type: "tool_call", toolCall });
          }
        }
      }
    }

    if (evt.type === "result" || evt.type === "error") lastEndAt = at;

    if (evt.type === "result" && current) {
      const meta = turnMetaFromResultEvent(d, fallbackModel);
      turns.push(materializeAssistantTurn(
        current,
        evt.seq,
        hasTurnStats(meta) ? meta : undefined,
        evt.created_at,
      ));
      current = null;
    }

    // A terminal error ends the turn like `result` does, but carries an
    // explanation instead of statistics. Without this the reload path dropped
    // it entirely, so a failed session reconstructed as a silent one — the live
    // reducer showed a reason and the reloaded transcript did not.
    if (evt.type === "error") {
      if (current) {
        turns.push(materializeAssistantTurn(current, current.seq, undefined, evt.created_at));
        current = null;
      }
      turns.push({
        role: "system",
        seq: evt.seq,
        text: providerErrorDisplayText(d),
        timestamp: evt.created_at,
      });
    }
  }

  // Deliberately retain an unterminated assistant turn. This is the recovery
  // case: its durable assistant/tool events are useful even without `result`.
  if (current) turns.push(materializeAssistantTurn(current, current.seq));
  return turns;
}

function materializeAssistantTurn(
  current: {
    text: string;
    thinking: string;
    toolCalls: Map<string, TurnToolCall>;
    contentBlocks: TurnContentBlock[];
    seq: number;
    timestamp: number;
    uuid?: string;
  },
  seq: number,
  meta?: TurnMeta,
  timestamp = current.timestamp,
): TurnContent {
  const turn: TurnContent = {
    role: "assistant",
    seq,
    text: current.text,
    timestamp,
    ...(current.uuid ? { uuid: current.uuid } : {}),
    ...(meta ? { meta } : {}),
  };
  if (current.thinking) turn.thinking = current.thinking;
  if (current.toolCalls.size > 0) {
    turn.toolCalls = [...current.toolCalls.values()];
  }
  if (current.contentBlocks.length > 0) turn.contentBlocks = current.contentBlocks;
  return turn;
}

/**
 * Empty each tool call's input and drop its result, for readers of the
 * conversation rather than its tool traffic. Tool results are most of a long
 * transcript's bytes. Clears in place: content blocks share the same tool-call
 * objects, so a copy would leave the payloads reachable.
 */
export function dropToolPayloads(turns: TurnContent[]): void {
  for (const turn of turns) {
    for (const call of turn.toolCalls ?? []) {
      call.input = {};
      delete call.result;
    }
  }
}
