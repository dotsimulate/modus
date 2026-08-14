import { resolve as resolveTestSourceDir } from "node:path";
/**
 * Guard against a React Effect Event that can never update.
 *
 * `useEffectEvent` keeps its implementation current by writing the latest
 * closure into a stable ref during commit. react-dom does that write in
 * `commitBeforeMutationEffectsOnFiber`, and only for `FunctionComponent`:
 * `ForwardRef` and `SimpleMemoComponent` share a `break` with no write
 * (react-dom-client 19.2 — a `memo(fn)` with no comparator becomes
 * SimpleMemoComponent, tag 15).
 *
 * So an effect event declared inside a `memo()` or `forwardRef()` component
 * runs its FIRST render's closure forever. There is no error, no warning and no
 * type error; the handler simply reads stale props and usually guards itself
 * out. That is exactly how auto-load-at-top shipped broken in ChatView: the
 * frozen closure saw `hasOlderMessages === false`, the value it had before
 * history landed, and every scroll to the top returned early.
 *
 * The replacement is a ref assigned during render, which is what the
 * virtualizer already does to keep its imperative controls current.
 *
 * The scan is deliberately file-scoped rather than component-scoped: a file
 * mixing a wrapped and an unwrapped component is close enough to the hazard to
 * be worth rejecting, and it needs no parser. Prose naming the hook stays legal
 * — only a call site matches.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

const SRC_DIR = join(resolveTestSourceDir(import.meta.dir, "..", "..", "ui"), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** A call, not a mention — a comment explaining why the hook is avoided must stay legal. */
const EFFECT_EVENT_CALL = /\buseEffectEvent\s*\(/;
const WRAPPED_COMPONENT = /\b(?:React\.)?(?:memo|forwardRef)\s*\(/;

describe("useEffectEvent fiber tags", () => {
  const files = sourceFiles(SRC_DIR);

  test("scans the frontend source tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("no effect event is declared alongside a memo/forwardRef component", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (!EFFECT_EVENT_CALL.test(source)) continue;
      if (!WRAPPED_COMPONENT.test(source)) continue;
      offenders.push(relative(SRC_DIR, file).replace(/\\/g, "/"));
    }
    expect(offenders).toEqual([]);
  });
});
