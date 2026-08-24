import type {
  ConversationProjectionTurnV1,
  Message,
  SessionTurnIndex,
} from "../../sdk/index";
import { buildTurns, turnProseWeight, turnToolCalls } from "./turn-segments";

function promptPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function conversationProjectionIsPartial(
  index: SessionTurnIndex | null,
  indexError: string | null,
): boolean {
  return !!indexError || (index?.olderTurnCount ?? 0) > 0;
}

/** Merge the bodiless whole-session index with the currently loaded history window. */
export function buildConversationProjectionTurns(
  index: SessionTurnIndex | null,
  messages: Message[],
  olderTurnCount: number,
): ConversationProjectionTurnV1[] {
  const loaded = buildTurns(messages, olderTurnCount);
  const byNumber = new Map<number, ConversationProjectionTurnV1>();
  for (const turn of index?.turns ?? []) {
    byNumber.set(turn.number, { ...turn, loaded: false, deferred: false });
  }
  for (const turn of loaded) {
    if (turn.seq == null) continue;
    const promptText = turn.prompt?.content ?? "";
    const deferred = turn.body.some((message) => (
      message.contentBlocks?.some((block) => block.type === "deferred")
    ));
    byNumber.set(turn.number, {
      number: turn.number,
      seq: turn.seq,
      timestamp: turn.prompt?.timestamp ?? turn.body[0]?.timestamp ?? 0,
      promptWeight: promptText.length,
      textWeight: turnProseWeight(turn),
      toolCount: turnToolCalls(turn).length,
      loaded: true,
      deferred,
      ...(promptText ? { promptPreview: promptPreview(promptText) } : {}),
    });
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}
