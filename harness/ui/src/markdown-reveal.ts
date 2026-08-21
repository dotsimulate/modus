type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const MAX_REVEAL_UNITS = 240;
const MAX_STAGGER_WINDOW_MS = 520;
const MAX_UNIT_STEP_MS = 38;
const BLOCKED_TAGS = new Set(["code", "pre", "pasted", "script", "style", "svg"]);

function countWords(node: HastNode, blocked = false): number {
  const nextBlocked = blocked || (node.type === "element" && BLOCKED_TAGS.has(node.tagName ?? ""));
  if (nextBlocked) return 0;
  if (node.type === "text") return [...(node.value ?? "").matchAll(/\S+/g)].length;
  return (node.children ?? []).reduce((total, child) => total + countWords(child, nextBlocked), 0);
}

export function revealUnitDelay(index: number, unitCount: number): number {
  if (unitCount <= 1) return 0;
  const step = Math.min(MAX_UNIT_STEP_MS, MAX_STAGGER_WINDOW_MS / (unitCount - 1));
  return Math.round(index * step);
}

/**
 * Rehype plugin that wraps prose in bounded word/phrase units after untrusted
 * HTML has already been sanitized. Inline spans preserve the final wrapping
 * and height, so the animation changes paint only — never scroll geometry.
 */
export function rehypeWordReveal() {
  return (tree: HastNode) => {
    const wordCount = countWords(tree);
    if (wordCount === 0) return;
    const wordsPerUnit = Math.max(1, Math.ceil(wordCount / MAX_REVEAL_UNITS));

    const textNodes: HastNode[] = [];
    const collect = (node: HastNode, blocked = false) => {
      const nextBlocked = blocked || (node.type === "element" && BLOCKED_TAGS.has(node.tagName ?? ""));
      if (nextBlocked) return;
      if (node.type === "text" && /\S/.test(node.value ?? "")) textNodes.push(node);
      for (const child of node.children ?? []) collect(child, nextBlocked);
    };
    collect(tree);

    const unitCount = textNodes.reduce((total, node) => {
      const words = [...(node.value ?? "").matchAll(/\S+/g)].length;
      return total + Math.ceil(words / wordsPerUnit);
    }, 0);

    let unitIndex = 0;
    const transform = (node: HastNode, blocked = false) => {
      const nextBlocked = blocked || (node.type === "element" && BLOCKED_TAGS.has(node.tagName ?? ""));
      if (nextBlocked || !node.children) return;

      const nextChildren: HastNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !/\S/.test(child.value ?? "")) {
          transform(child, nextBlocked);
          nextChildren.push(child);
          continue;
        }

        const value = child.value ?? "";
        const words = [...value.matchAll(/\S+/g)];
        const firstWord = words[0];
        if (firstWord?.index) nextChildren.push({ type: "text", value: value.slice(0, firstWord.index) });

        for (let wordIndex = 0; wordIndex < words.length; wordIndex += wordsPerUnit) {
          const start = words[wordIndex]?.index ?? 0;
          const next = words[wordIndex + wordsPerUnit];
          const end = next?.index ?? value.length;
          nextChildren.push({
            type: "element",
            tagName: "reveal",
            properties: { delay: revealUnitDelay(unitIndex, unitCount) },
            children: [{ type: "text", value: value.slice(start, end) }],
          });
          unitIndex += 1;
        }
      }
      node.children = nextChildren;
    };
    transform(tree);
  };
}
