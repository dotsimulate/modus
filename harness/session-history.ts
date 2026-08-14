import type { TurnContent, TurnContentBlock, TurnToolCall } from "./db";
import { hasTurnStats, turnMetaFromResultEvent, type TurnMeta } from "./turn-meta";
import { providerErrorDisplayText } from "./provider-error";

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
 * Rebuild user/assistant turns from durable non-stream events.
 *
 * `result` events close a turn *and* carry its usage. Reading only the boundary
 * and discarding the payload is what used to make a reloaded session lose every
 * cost, token, and context figure it had shown while streaming.
 */
export function reconstructSessionTurns(
  events: SessionHistoryEventRow[],
  fallbackModel = "",
): TurnContent[] {
  const turns: TurnContent[] = [];
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

  for (const evt of ordered) {
    let d: any;
    try { d = JSON.parse(evt.data); } catch { continue; }

    if (evt.type === "user") {
      if (evt.subtype === "prompt" || d.subtype === "prompt") {
        if (current) {
          turns.push(materializeAssistantTurn(current, current.seq));
          current = null;
        }
        const content = d.message?.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string") text += block.text;
          }
        }
        if (text) turns.push({ role: "user", seq: evt.seq, text, timestamp: evt.created_at });
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

    if (evt.type === "result" && current) {
      const meta = turnMetaFromResultEvent(d, fallbackModel);
      turns.push(materializeAssistantTurn(current, evt.seq, hasTurnStats(meta) ? meta : undefined));
      current = null;
    }

    // A terminal error ends the turn like `result` does, but carries an
    // explanation instead of statistics. Without this the reload path dropped
    // it entirely, so a failed session reconstructed as a silent one — the live
    // reducer showed a reason and the reloaded transcript did not.
    if (evt.type === "error") {
      if (current) {
        turns.push(materializeAssistantTurn(current, current.seq));
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
): TurnContent {
  const turn: TurnContent = {
    role: "assistant",
    seq,
    text: current.text,
    timestamp: current.timestamp,
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
