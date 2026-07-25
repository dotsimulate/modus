export type MessageTextPart =
  | { type: "text"; text: string }
  | { type: "move_context"; moveName: string; content: string };

const MOVE_CONTEXT_PATTERN =
  /<!-- move:([A-Za-z0-9][A-Za-z0-9._-]*) -->\r?\n?([\s\S]*?)\r?\n?<!-- \/move:\1 -->(?:\r?\n){0,2}/g;

/** Split harness-injected move context from the user-authored portion of a prompt. */
export function parseMessageText(content: string): MessageTextPart[] {
  if (!content) return [];

  const parts: MessageTextPart[] = [];
  let cursor = 0;

  for (const match of content.matchAll(MOVE_CONTEXT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push({ type: "text", text: content.slice(cursor, index) });
    }
    parts.push({
      type: "move_context",
      moveName: match[1]!,
      content: match[2]!.trim(),
    });
    cursor = index + match[0].length;
  }

  if (cursor < content.length) {
    parts.push({ type: "text", text: content.slice(cursor) });
  }

  return parts.length ? parts : [{ type: "text", text: content }];
}

/** Text the user actually authored, excluding harness-injected move context. */
export function userAuthoredMessageText(content: string): string {
  return parseMessageText(content)
    .filter((part): part is Extract<MessageTextPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function maskMoveApiTokens(content: string): string {
  return content.replace(/\bmapi-[A-Za-z0-9._-]+-[A-Za-z0-9]{6,}\b/g, (token) => {
    return `${token.slice(0, 5)}…${token.slice(-4)}`;
  });
}
