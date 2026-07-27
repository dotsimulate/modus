export type MessageTextPart =
  | { type: "text"; text: string }
  | { type: "move_context"; moveName: string; content: string }
  | { type: "skill_context"; skillName: string; content: string };

/**
 * Both moves and skills inject a block into the user turn that the user did not
 * type. They share one marker shape so the transcript can fold either kind and
 * the copy button returns only the authored text. Group 1 is the kind, group 2
 * the name — the closing tag backreferences both, so a stray opener cannot
 * swallow the rest of the message.
 */
const INJECTED_CONTEXT_PATTERN =
  /<!-- (move|skill):([A-Za-z0-9][A-Za-z0-9._-]*) -->\r?\n?([\s\S]*?)\r?\n?<!-- \/\1:\2 -->(?:\r?\n){0,2}/g;

/** Wrap skill text in the marker the transcript folds. Mirrors the move form. */
export function wrapSkillContext(skillName: string, content: string): string {
  return `<!-- skill:${skillName} -->\n${content}\n<!-- /skill:${skillName} -->`;
}

/** Split harness-injected move/skill context from the user-authored portion of a prompt. */
export function parseMessageText(content: string): MessageTextPart[] {
  if (!content) return [];

  const parts: MessageTextPart[] = [];
  let cursor = 0;

  for (const match of content.matchAll(INJECTED_CONTEXT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push({ type: "text", text: content.slice(cursor, index) });
    }
    parts.push(
      match[1] === "skill"
        ? { type: "skill_context", skillName: match[2]!, content: match[3]!.trim() }
        : { type: "move_context", moveName: match[2]!, content: match[3]!.trim() },
    );
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
