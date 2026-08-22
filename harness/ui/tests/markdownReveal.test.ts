import { describe, expect, test } from "bun:test";
import { rehypeWordReveal, revealUnitDelay } from "../src/markdown-reveal";

type Node = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

function revealNodes(node: Node): Node[] {
  const found: Node[] = [];
  if (node.tagName === "reveal") found.push(node);
  for (const child of node.children ?? []) found.push(...revealNodes(child));
  return found;
}

describe("Markdown word diffusion", () => {
  test("wraps prose in staggered reveal units without touching code", () => {
    const tree: Node = {
      type: "root",
      children: [{
        type: "element",
        tagName: "p",
        children: [{ type: "text", value: "one two three" }],
      }, {
        type: "element",
        tagName: "code",
        children: [{ type: "text", value: "const untouched = true" }],
      }],
    };
    rehypeWordReveal()(tree);

    const reveals = revealNodes(tree);
    expect(reveals.map((node) => node.children?.[0]?.value)).toEqual(["one ", "two ", "three"]);
    expect(reveals.map((node) => node.properties?.delay)).toEqual([0, 38, 76]);
    expect(tree.children?.[1]?.children?.[0]?.value).toBe("const untouched = true");
  });

  test("groups huge text into bounded phrase units and caps the stagger window", () => {
    const text = Array.from({ length: 1_000 }, (_, index) => `word${index}`).join(" ");
    const tree: Node = {
      type: "root",
      children: [{ type: "element", tagName: "p", children: [{ type: "text", value: text }] }],
    };
    rehypeWordReveal()(tree);
    const reveals = revealNodes(tree);

    expect(reveals.length).toBeLessThanOrEqual(240);
    expect(Number(reveals.at(-1)?.properties?.delay)).toBeLessThanOrEqual(520);
    expect(revealUnitDelay(239, 240)).toBe(520);
  });
});
