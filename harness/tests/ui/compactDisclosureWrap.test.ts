import { resolve as resolveTestSourceDir } from "node:path";
/**
 * Guard for move/skill context wrapping inside a chat message.
 *
 * `.panel-collapse` is a grid and `.panel-collapse-clip` is a grid item, so the
 * item's `min-width: auto` makes the min-content width of anything unbreakable
 * inside it the floor of the grid track. The track then grows past the
 * disclosure's own border, every prose line lays out at that inflated width,
 * and the content bleeds to the right of the box it is supposed to sit in.
 *
 * A move gather always ends in the harness-appended `modus_submit` code fence
 * (`buildApiOpsProtocol`), which is exactly such an unbreakable run — so every
 * API move rendered this way, and the wider the token/op list the worse it got.
 *
 * There is no DOM test environment in this tree, so the invariant is pinned as
 * a stylesheet contract: the clip inside a compact disclosure must be floored
 * at 0 so the detail below it can scroll its own overflow instead.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const STYLES_DIR = join(resolveTestSourceDir(import.meta.dir, "..", "..", "ui"), "src/styles");

const COMPACT_DISCLOSURE = readFileSync(
  join(STYLES_DIR, "components/compact-disclosure.css"),
  "utf-8",
);
const PROFILE_PANEL = readFileSync(join(STYLES_DIR, "components/profile-panel.css"), "utf-8");

/** Body of the first rule whose selector list matches, comments stripped. */
function ruleBody(css: string, selector: string): string | null {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) return match[2];
  }
  return null;
}

describe("compact disclosure content wrapping", () => {
  test("the collapse clip is still a grid item that can be widened", () => {
    // If this stops being true the guard below is measuring nothing, so fail
    // here rather than reporting a green check on a rule that no longer matters.
    expect(ruleBody(PROFILE_PANEL, ".panel-collapse")).toContain("display: grid");
    expect(ruleBody(PROFILE_PANEL, ".panel-collapse-clip")).not.toContain("min-width: 0");
  });

  test("a compact disclosure floors its collapse clip at zero", () => {
    const body = ruleBody(COMPACT_DISCLOSURE, ".compact-disclosure .panel-collapse-clip");
    expect(
      body,
      "Without `min-width: 0` the modus_submit code fence in a move gather widens "
        + "the grid track past the disclosure border and its prose stops wrapping.",
    ).not.toBeNull();
    expect(body).toMatch(/min-width:\s*0\s*;/);
  });

  test("the detail pane can still scroll what it clips", () => {
    // Flooring the clip only moves the overflow down a level; the detail has to
    // be the thing that absorbs it, or wide content bleeds again from there.
    const body = ruleBody(COMPACT_DISCLOSURE, ".compact-disclosure__detail");
    expect(body).toMatch(/overflow-y:\s*auto\s*;/);
  });
});
