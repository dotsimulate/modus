import type { TurnContent, TurnContentBlock, TurnToolCall } from "./db";

export type SessionHistoryEventRow = {
  seq: number;
  type: string;
  subtype: string | null;
  data: string;
  created_at: number;
};

/** Keep text positions while replacing contiguous heavy provider blocks with
 * lightweight placeholders. Text uses offsets into TurnContent.text so the
 * summary response does not send the complete conversation twice. */
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
    if (!deferred) deferred = { type: "deferred", hasThinking: false, toolCallCount: 0 };
    if (block.type === "thinking") deferred.hasThinking = true;
    if (block.type === "tool_call") deferred.toolCallCount++;
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

/** Rebuild user/assistant turns from durable non-stream events. */
export function reconstructSessionTurns(events: SessionHistoryEventRow[]): TurnContent[] {
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

  for (const evt of events) {
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
      turns.push(materializeAssistantTurn(current, evt.seq));
      current = null;
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
): TurnContent {
  const turn: TurnContent = {
    role: "assistant",
    seq,
    text: current.text,
    timestamp: current.timestamp,
    ...(current.uuid ? { uuid: current.uuid } : {}),
  };
  if (current.thinking) turn.thinking = current.thinking;
  if (current.toolCalls.size > 0) {
    turn.toolCalls = [...current.toolCalls.values()].map(({ id: _id, ...toolCall }) => toolCall);
  }
  if (current.contentBlocks.length > 0) turn.contentBlocks = current.contentBlocks;
  return turn;
}
