export type PastedContentPart =
  | { type: "text"; text: string }
  | { type: "paste"; text: string };

const PASTED_BLOCK = /^<pasted>\r?\n([\s\S]*?)\r?\n<\/pasted>(?:\r?\n|$)/gm;

function decodePastedText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Split composer-authored paste envelopes from the user's ordinary Markdown. */
export function parsePastedContent(content: string): PastedContentPart[] {
  const parts: PastedContentPart[] = [];
  let cursor = 0;

  for (const match of content.matchAll(PASTED_BLOCK)) {
    const index = match.index ?? 0;
    const preceding = content.slice(cursor, index);
    if (preceding.trim()) parts.push({ type: "text", text: preceding });
    parts.push({ type: "paste", text: decodePastedText(match[1] ?? "") });
    cursor = index + match[0].length;
  }

  const trailing = content.slice(cursor);
  if (trailing.trim()) parts.push({ type: "text", text: trailing });
  return parts.length ? parts : [{ type: "text", text: content }];
}
