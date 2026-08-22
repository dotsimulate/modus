import type { Message, MessageContentBlock, ToolCall } from "../../sdk/index";
import { userAuthoredMessageText } from "./move-context";

export type CopyMode = "last" | "text" | "thinking" | "full";

export function copyTextFromBlocks(
  blocks: MessageContentBlock[] | undefined,
  kind: "text" | "thinking",
): string | undefined {
  if (!blocks) return undefined;
  const parts: string[] = [];
  for (const block of blocks) {
    if (kind === "text" && block.type === "text" && block.text) parts.push(block.text);
    if (kind === "thinking" && block.type === "thinking" && block.thinking) parts.push(block.thinking);
  }
  return parts.join("\n\n");
}

function formatToolCallsText(toolCalls?: ToolCall[]): string {
  if (!toolCalls?.length) return "";
  return toolCalls.map(tc => {
    const inputStr = Object.entries(tc.input)
      .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
    const parts = [`[${tc.name}]`, inputStr];
    if (tc.result) parts.push(`→ ${tc.result.slice(0, 500)}`);
    return parts.join("\n");
  }).join("\n\n");
}

export function buildCopyText(msg: Message, mode: CopyMode): string {
  if (msg.role === "user") return userAuthoredMessageText(msg.content);
  const tc = msg.turnCopy;

  if (mode === "last") return msg.content;

  // Hydrated turns do not carry the live-only turnCopy cache, but they do
  // retain ordered blocks. Rebuild the same readable text from those blocks
  // so a response copies identically before and after a refresh.
  const blockText = copyTextFromBlocks(msg.contentBlocks, "text");
  const blockThinking = copyTextFromBlocks(msg.contentBlocks, "thinking");
  // Hot reload can leave an already-settled message carrying the old flattened
  // cache. When that cache is exactly the message's compatibility field, the
  // ordered blocks are the more faithful source. A genuinely aggregated cache
  // can be longer than this message and still wins.
  const text = tc?.text && tc.text !== msg.content
    ? tc.text
    : blockText ?? tc?.text ?? msg.content;
  const thinking = tc?.thinking && tc.thinking !== msg.thinking
    ? tc.thinking
    : blockThinking ?? tc?.thinking ?? msg.thinking;
  const toolCalls = tc?.toolCalls ?? msg.toolCalls;

  const parts: string[] = [];
  if (mode !== "text" && thinking) parts.push(`<thinking>\n${thinking}\n</thinking>`);
  if (mode === "full" && toolCalls?.length) parts.push(formatToolCallsText(toolCalls));
  if (text) parts.push(text);
  return parts.join("\n\n");
}
