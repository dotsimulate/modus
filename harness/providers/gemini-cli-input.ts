import type { MessageContent } from "../session-manager";

export function buildGeminiRequest(content: MessageContent): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ text: content }];

  const parts: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push({ text: block.text });
    } else if (block.type === "image" && block.source) {
      parts.push({
        inlineData: {
          mimeType: block.source.media_type,
          data: block.source.data,
        },
      });
    }
  }
  return parts.length > 0 ? parts : [{ text: "" }];
}
