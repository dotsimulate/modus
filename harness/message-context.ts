export type MessageTextPart =
  | { type: "text"; text: string }
  | { type: "move_context"; moveName: string; content: string }
  | { type: "skill_context"; skillName: string; content: string };

/** Moves and skills share one injected-context marker shape. */
const INJECTED_CONTEXT_PATTERN =
  /<!-- (move|skill):([A-Za-z0-9][A-Za-z0-9._-]*) -->\r?\n?([\s\S]*?)\r?\n?<!-- \/\1:\2 -->(?:\r?\n){0,2}/g;

const INJECTED_CONTEXT_OPENER = /^\s*<!--\s*(move|skill):([A-Za-z0-9][A-Za-z0-9._-]*)\s*-->/;

export function wrapSkillContext(skillName: string, content: string): string {
  return `<!-- skill:${skillName} -->\n${content}\n<!-- /skill:${skillName} -->`;
}

export function parseMessageText(content: string): MessageTextPart[] {
  if (!content) return [];

  const parts: MessageTextPart[] = [];
  let cursor = 0;
  for (const match of content.matchAll(INJECTED_CONTEXT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ type: "text", text: content.slice(cursor, index) });
    parts.push(
      match[1] === "skill"
        ? { type: "skill_context", skillName: match[2]!, content: match[3]!.trim() }
        : { type: "move_context", moveName: match[2]!, content: match[3]!.trim() },
    );
    cursor = index + match[0].length;
  }
  if (cursor < content.length) parts.push({ type: "text", text: content.slice(cursor) });
  return parts.length ? parts : [{ type: "text", text: content }];
}

export function userAuthoredMessageText(content: string): string {
  return parseMessageText(content)
    .filter((part): part is Extract<MessageTextPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** Produce a preview without persisting injected bodies or capability tokens. */
export function userMessagePreviewText(content: string): string {
  const parts = parseMessageText(content);
  const injected = parts.find((part) => part.type !== "text");
  if (injected) {
    const authored = parts
      .filter((part): part is Extract<MessageTextPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    if (authored) return authored;
    return injected.type === "move_context"
      ? `${injected.moveName} move`
      : `${injected.skillName} skill`;
  }

  const opener = content.match(INJECTED_CONTEXT_OPENER);
  return opener ? `${opener[2]} ${opener[1]}` : content;
}
