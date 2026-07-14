import type { TurnContent } from "./db";

export type SessionHistoryEventRow = {
  seq: number;
  type: string;
  subtype: string | null;
  data: string;
  created_at: number;
};

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
    toolCalls: Map<string, { name: string; input: Record<string, unknown>; result?: string }>;
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
          seq: evt.seq,
          timestamp: evt.created_at,
          ...(typeof d.uuid === "string" ? { uuid: d.uuid } : {}),
        };
      } else if (!current.uuid && typeof d.uuid === "string") {
        current.uuid = d.uuid;
      }
      const content = d.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") current.text += block.text;
          if (block?.type === "thinking" && typeof block.thinking === "string") current.thinking += block.thinking;
          if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            current.toolCalls.set(block.id, { name: block.name, input: block.input ?? {} });
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
    toolCalls: Map<string, { name: string; input: Record<string, unknown>; result?: string }>;
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
  if (current.toolCalls.size > 0) turn.toolCalls = [...current.toolCalls.values()];
  return turn;
}
