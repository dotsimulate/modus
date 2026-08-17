/**
 * The measured half of page review.
 *
 * `captureBoxes` needs a browser, but the rules that turn geometry into
 * findings do not, so they live in `analyzeBoxes` and are pinned here with
 * hand-built boxes. Every rule below describes something a user can see and
 * the page JSON cannot predict — which is the whole reason the linter is not
 * sufficient on its own.
 */

import { describe, expect, test } from "bun:test";
import {
  analyzeBoxes,
  formatInspectFindings,
  worstInspectSeverity,
} from "../../ui/src/page-inspect";
import type { InspectedBox } from "../../ui/src/page-inspect";

const VIEWPORT = { w: 1200, h: 800 };

function box(partial: Partial<InspectedBox> = {}): InspectedBox {
  const rect = partial.rect ?? { x: 0, y: 0, w: 400, h: 300 };
  return {
    path: partial.path ?? "div.thing",
    className: partial.className ?? "div.thing",
    rect,
    scrollW: partial.scrollW ?? rect.w,
    scrollH: partial.scrollH ?? rect.h,
    clientW: partial.clientW ?? rect.w,
    clientH: partial.clientH ?? rect.h,
    overflowX: partial.overflowX ?? "visible",
    overflowY: partial.overflowY ?? "visible",
    ...(partial.text ? { text: partial.text } : {}),
    children: partial.children ?? [],
  };
}

function ruleIds(box_: InspectedBox): string[] {
  return analyzeBoxes(box_, VIEWPORT).map((f) => f.rule);
}

describe("clipping", () => {
  test("content wider than a hidden-overflow box is cut off", () => {
    const findings = analyzeBoxes(
      box({ clientW: 118, scrollW: 512, overflowX: "hidden", text: "read the bootstrap file" }),
      VIEWPORT,
    );
    const clipped = findings.find((f) => f.rule === "clipped-horizontally");
    expect(clipped?.severity).toBe("error");
    // The number is the point — it says how much is missing.
    expect(clipped?.message).toContain("394px wider");
    expect(clipped?.message).toContain("read the bootstrap file");
  });

  test("content wider than a scrollable box is reachable and not reported", () => {
    expect(ruleIds(box({ clientW: 118, scrollW: 512, overflowX: "auto" }))).not.toContain(
      "clipped-horizontally",
    );
  });

  test("vertical clipping is reported separately", () => {
    expect(ruleIds(box({ clientH: 200, scrollH: 900, overflowY: "hidden" }))).toContain(
      "clipped-vertically",
    );
  });

  test("sub-pixel overflow is not a finding", () => {
    expect(ruleIds(box({ clientW: 300, scrollW: 300.8, overflowX: "hidden" }))).toEqual([]);
  });
});

describe("escaping the viewport", () => {
  test("a box extending past the right edge is reported", () => {
    const findings = analyzeBoxes(box({ rect: { x: 900, y: 0, w: 600, h: 100 } }), VIEWPORT);
    const escaped = findings.find((f) => f.rule === "past-right-edge");
    expect(escaped?.severity).toBe("error");
    expect(escaped?.message).toContain("300px past");
  });

  test("a box exactly filling the viewport is fine", () => {
    expect(ruleIds(box({ rect: { x: 0, y: 0, w: 1200, h: 400 } }))).toEqual([]);
  });
});

describe("collapsed and starved panes", () => {
  test("a pane with children and no width has lost them", () => {
    const findings = analyzeBoxes(
      box({ rect: { x: 0, y: 0, w: 0, h: 800 }, children: [box({ path: "child" })] }),
      VIEWPORT,
    );
    const collapsed = findings.find((f) => f.rule === "collapsed-pane");
    expect(collapsed?.severity).toBe("error");
  });

  test("an empty leaf with no size is not reported", () => {
    expect(ruleIds(box({ rect: { x: 0, y: 0, w: 0, h: 0 } }))).toEqual([]);
  });

  test("a pane too narrow to read is a warning, not an error", () => {
    const findings = analyzeBoxes(
      box({ rect: { x: 0, y: 0, w: 9, h: 800 }, children: [box({ path: "child" })] }),
      VIEWPORT,
    );
    expect(findings.find((f) => f.rule === "starved-pane")?.severity).toBe("warning");
    expect(ruleIds(box({ rect: { x: 0, y: 0, w: 9, h: 800 }, children: [box()] }))).not.toContain(
      "collapsed-pane",
    );
  });
});

describe("nested scrollers", () => {
  test("two overflowing vertical scrollers in one chain are reported", () => {
    const inner = box({
      path: "outer > inner",
      clientH: 200,
      scrollH: 900,
      overflowY: "auto",
    });
    const outer = box({
      path: "outer",
      clientH: 300,
      scrollH: 950,
      overflowY: "auto",
      children: [inner],
    });
    expect(ruleIds(outer)).toContain("nested-scrollers");
  });

  test("a scroller containing a non-overflowing child is fine", () => {
    const inner = box({ path: "outer > inner", clientH: 200, scrollH: 200, overflowY: "auto" });
    const outer = box({
      path: "outer",
      clientH: 300,
      scrollH: 950,
      overflowY: "auto",
      children: [inner],
    });
    expect(ruleIds(outer)).not.toContain("nested-scrollers");
  });
});

describe("traversal", () => {
  test("findings are reported for descendants, not just the root", () => {
    const deep = box({ path: "a > b > c", clientW: 50, scrollW: 400, overflowX: "hidden" });
    const mid = box({ path: "a > b", children: [deep] });
    const root = box({ path: "a", children: [mid] });
    const findings = analyzeBoxes(root, VIEWPORT);
    expect(findings.map((f) => f.path)).toContain("a > b > c");
  });
});

describe("severity helpers", () => {
  test("a clean measurement has no worst severity", () => {
    expect(worstInspectSeverity([])).toBeNull();
  });

  test("formatting puts errors first", () => {
    const text = formatInspectFindings([
      { rule: "warn-thing", severity: "warning", path: "x", message: "m" },
      { rule: "error-thing", severity: "error", path: "y", message: "m" },
    ]);
    expect(text.indexOf("error-thing")).toBeLessThan(text.indexOf("warn-thing"));
  });

  test("no findings formats as a sentence, not an empty string", () => {
    expect(formatInspectFindings([])).toBe("no findings");
  });
});
