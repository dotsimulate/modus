import { resolve as resolveTestSourceDir } from "node:path";
/**
 * Built-in moves are loaded dynamically from the packaged resource tree, where
 * the only harness modules that exist are the generated bridge shims. A move
 * that imports a harness module missing from BRIDGED_HARNESS_MODULES therefore
 * works perfectly in dev and fails only in a packaged build — silently, because
 * activateMoveBindings catches the load error and the user just sees a move that
 * injects nothing.
 *
 * This suite is the local signal that failure mode otherwise does not have.
 * It regression-tests a real incident: a built-in move added a runtime
 * harness import without a bridge entry.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { BRIDGED_HARNESS_MODULES } from "../bridged-modules";

const MOVES_DIR = join(resolveTestSourceDir(import.meta.dir, ".."), "moves");

/** Relative imports that climb out of the move directory into harness/. */
const HARNESS_IMPORT = /^\s*import\s+(?!type\s)([\s\S]*?)\s+from\s+["']\.\.\/\.\.\/([A-Za-z0-9._-]+)["']/gm;

function builtInMoveFiles(): { move: string; file: string; source: string }[] {
  if (!existsSync(MOVES_DIR)) return [];
  const out: { move: string; file: string; source: string }[] = [];
  for (const entry of readdirSync(MOVES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(MOVES_DIR, entry.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      out.push({ move: entry.name, file: join(dir, f), source: readFileSync(join(dir, f), "utf-8") });
    }
  }
  return out;
}

describe("built-in move harness imports", () => {
  test("every harness module a built-in move imports is bridged", () => {
    const bridged = new Set<string>(BRIDGED_HARNESS_MODULES);
    const unbridged: string[] = [];

    for (const { move, file, source } of builtInMoveFiles()) {
      for (const match of source.matchAll(HARNESS_IMPORT)) {
        const clause = match[1]!;
        const moduleName = match[2]!;
        // `import type { … }` is erased; so is a clause of only `type` specifiers.
        const specifiers = clause.replace(/^\{|\}$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
        const allTypeOnly = specifiers.length > 0 && specifiers.every((s) => s.startsWith("type "));
        if (allTypeOnly) continue;
        if (moduleName.endsWith("-types")) continue; // type-only modules by convention
        if (bridged.has(moduleName)) continue;
        unbridged.push(`${move}: ${moduleName} (${file.replace(resolveTestSourceDir(import.meta.dir, ".."), "harness")})`);
      }
    }

    expect(unbridged).toEqual([]);
  });

  test("the bridge publishes a namespace for every declared module", async () => {
    // A name in the list with no namespace in initHarnessBridge() would stage a
    // shim that resolves to undefined — the same silent failure, one step later.
    const bridgeSource = readFileSync(join(resolveTestSourceDir(import.meta.dir, ".."), "harness-bridge.ts"), "utf-8");
    for (const name of BRIDGED_HARNESS_MODULES) {
      expect(bridgeSource).toContain(`"${name}":`);
    }
  });
});
