import { resolve as resolveTestSourceDir } from "node:path";
/**
 * Drift guard for build-time generated reference docs.
 *
 * The committed markdown under docs/generated/ must equal what the generator
 * produces from current source. Rename a field in move-types.ts without
 * regenerating and this fails — which is the whole point: a generated reference
 * that can silently fall behind is no better than the hand-written field lists
 * it replaced.
 *
 * Regenerate with `bun run docs:generate` from harness/.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createDocsRegistry } from "../docs-registry";
import { GENERATED_DOCS, findDeclaration } from "../scripts/generate-docs";

const DOCS_DIR = join(resolveTestSourceDir(import.meta.dir, ".."), "docs");
const GENERATED_DIR = join(DOCS_DIR, "generated");

/** The repo stores LF in the index but checks out CRLF on Windows. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

describe("generated reference docs", () => {
  for (const [id, build] of Object.entries(GENERATED_DOCS)) {
    test(`docs/generated/${id}.md is committed`, () => {
      expect(existsSync(join(GENERATED_DIR, `${id}.md`))).toBe(true);
    });

    test(`docs/generated/${id}.md matches current source`, () => {
      const committed = normalize(readFileSync(join(GENERATED_DIR, `${id}.md`), "utf-8"));
      expect(normalize(build())).toBe(committed);
    });
  }

  test("a missing declaration throws by name instead of shrinking the output", () => {
    expect(() => findDeclaration("move-types.ts", "NotARealDeclaration")).toThrow(
      /NotARealDeclaration/,
    );
  });

  test("the generated doc is reachable through the registry, not just listed", () => {
    // Regression guard: getDoc routed every "generated/" id to the virtual
    // builder, so a real file under docs/generated/ was searchable and listed
    // but returned null on fetch.
    const registry = createDocsRegistry({ docsDir: DOCS_DIR });
    for (const id of Object.keys(GENERATED_DOCS)) {
      const doc = registry.getDoc(`generated/${id}`);
      expect(doc).not.toBeNull();
      expect(doc?.content.length ?? 0).toBeGreaterThan(0);
      expect(registry.listDocs().some((entry) => entry.id === `generated/${id}`)).toBe(true);
    }
  });

  test("the virtual move-ops doc still resolves and is not shadowed", () => {
    const registry = createDocsRegistry({ docsDir: DOCS_DIR });
    const doc = registry.getDoc("generated/move-ops");
    expect(doc?.generated).toBe(true);
    const listed = registry.listDocs().filter((entry) => entry.id === "generated/move-ops");
    expect(listed).toHaveLength(1);
  });

  test("declared members are quoted, so the matrix cannot understate a surface", () => {
    const contracts = GENERATED_DOCS["authoring-contracts"]!();
    // `run` exists on MoveContext and not on MoveApiContext. Prose claimed
    // "full orchestration parity" for handlers for weeks; the matrix must show
    // the asymmetry rather than assert parity.
    expect(contracts).toContain("| `run` | yes | — | — |");
    expect(contracts).toContain("| `wake` | — | yes | — |");
  });
});
