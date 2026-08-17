/**
 * The page linter is the gate an authored page passes before a human looks at
 * it, so its rules are the contract.
 *
 * Every rule below encodes a renderer behaviour that is invisible in page JSON
 * and has produced a broken page at least once. The fixtures are deliberately
 * minimal — the point of each test is "this shape, this finding", not a
 * realistic page.
 *
 * The last block lints the harness's own built-in pages. Shipping a page that
 * trips an `error` rule is a defect in that page, so that assertion is real.
 * Warnings are printed rather than failed: several are judgement calls that a
 * built-in page is entitled to make deliberately.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { lintPage, lintPageLayout, worstSeverity, formatFindings } from "../../ui/src/page-lint";
import type { LintFinding, LintablePage } from "../../ui/src/page-lint";
import type { LayoutNode, WidgetMeta } from "../../ui/src/widgets/types";

// A catalog just large enough to exercise the rules. `bounded` declares a
// maxHeight (so it is legal in an `auto` row); `unbounded` does not.
const CATALOG: Record<string, WidgetMeta> = {
  bounded: { type: "bounded", description: "bounded thing", maxHeight: 200 },
  unbounded: { type: "unbounded", description: "unbounded thing", preferredHeight: 400 },
  undocumented: { type: "undocumented" },
};

function rules(findings: LintFinding[]): string[] {
  return findings.map((f) => f.rule);
}

function page(layout: LayoutNode, extra: Partial<LintablePage> = {}): LintablePage {
  return { id: "t", title: "t", layout, ...extra };
}

function leaf(type: string, rest: Partial<Extract<LayoutNode, { kind: "widget" }>> = {}): LayoutNode {
  return { kind: "widget", widget: { type }, ...rest } as LayoutNode;
}

describe("widget resolution", () => {
  test("an unregistered widget type is an error", () => {
    const findings = lintPage(page(leaf("no-such-widget")), CATALOG);
    expect(rules(findings)).toContain("unknown-widget");
    expect(findings.find((f) => f.rule === "unknown-widget")?.severity).toBe("error");
  });

  test("a move: widget is resolved at runtime and is not reported as unknown", () => {
    const findings = lintPage(page(leaf("move:chess")), CATALOG);
    expect(rules(findings)).not.toContain("unknown-widget");
  });

  test("a widget with no catalog description is reported as info", () => {
    const findings = lintPage(page(leaf("undocumented")), CATALOG);
    const finding = findings.find((f) => f.rule === "undescribed-widget");
    expect(finding?.severity).toBe("info");
  });

  test("duplicate widget ids collide in panel state", () => {
    const layout: LayoutNode = {
      kind: "split",
      axis: "vertical",
      children: [
        { kind: "widget", widget: { type: "bounded", id: "dup" } },
        { kind: "widget", widget: { type: "bounded", id: "dup" } },
      ],
    } as LayoutNode;
    const findings = lintPage(page(layout), CATALOG);
    expect(rules(findings)).toContain("duplicate-widget-id");
    expect(findings.find((f) => f.rule === "duplicate-widget-id")?.severity).toBe("error");
  });
});

describe("split sizing", () => {
  test('"auto" in a horizontal split is always unshrinkable', () => {
    // The exact shape that made the turn rail claim ~550px of an 80-character
    // label and refuse to give it back.
    const layout: LayoutNode = {
      kind: "split",
      axis: "horizontal",
      sizes: ["auto", 3, 1],
      children: [leaf("unbounded"), leaf("bounded"), leaf("bounded")],
    } as LayoutNode;
    const findings = lintPage(page(layout), CATALOG);
    expect(rules(findings)).toContain("unshrinkable-auto-column");
  });

  test('"auto" in a horizontal split is flagged even for a maxHeight widget', () => {
    // maxHeight says nothing about width, and no widget declares a max width.
    const layout: LayoutNode = {
      kind: "split",
      axis: "horizontal",
      sizes: ["auto", 1],
      children: [leaf("bounded"), leaf("bounded")],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).toContain("unshrinkable-auto-column");
  });

  test('"auto" in a vertical split is fine when every leaf declares maxHeight', () => {
    const layout: LayoutNode = {
      kind: "split",
      axis: "vertical",
      sizes: [1, "auto"],
      children: [leaf("unbounded"), leaf("bounded")],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).not.toContain("unbounded-auto-row");
  });

  test('"auto" in a vertical split is flagged when a leaf has no maxHeight', () => {
    const layout: LayoutNode = {
      kind: "split",
      axis: "vertical",
      sizes: ["auto", 1],
      children: [leaf("unbounded"), leaf("bounded")],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).toContain("unbounded-auto-row");
  });

  test("a sizes array shorter than children is an error", () => {
    const layout: LayoutNode = {
      kind: "split",
      axis: "vertical",
      sizes: [1],
      children: [leaf("bounded"), leaf("bounded")],
    } as LayoutNode;
    const findings = lintPage(page(layout), CATALOG);
    expect(findings.find((f) => f.rule === "sizes-length-mismatch")?.severity).toBe("error");
  });

  test("two sibling bare widget leaves read as one undivided surface", () => {
    const layout: LayoutNode = {
      kind: "split",
      axis: "vertical",
      sizes: [1, 1],
      children: [leaf("bounded"), leaf("bounded")],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).toContain("unlabelled-bare-leaves");
  });
});

describe("page context wiring", () => {
  test("a showWhen on a key no scope declares is flagged", () => {
    const layout: LayoutNode = {
      kind: "scope",
      context: { sessionId: null },
      children: [leaf("bounded", { showWhen: { somethingElse: null } })],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).toContain("unaccounted-context-key");
  });

  test("a key another leaf publishes counts as accounted for", () => {
    const layout: LayoutNode = {
      kind: "scope",
      context: {},
      children: [
        {
          kind: "split",
          axis: "vertical",
          sizes: [1, 1],
          children: [
            { kind: "widget", widget: { type: "bounded" }, publish: { selected: "turnSeq" } },
            { kind: "widget", widget: { type: "bounded" }, showWhen: { turnSeq: null } },
          ],
        },
      ],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).not.toContain("unaccounted-context-key");
  });

  test("bindUrlSession accounts for sessionId without declaring it in context", () => {
    const layout: LayoutNode = {
      kind: "scope",
      bindUrlSession: true,
      context: {},
      children: [leaf("bounded", { hideWhen: { sessionId: null } })],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).not.toContain("unaccounted-context-key");
  });

  test("an identity publish/subscribe mapping is a no-op", () => {
    const layout: LayoutNode = {
      kind: "scope",
      context: { turnSeq: null },
      children: [
        { kind: "widget", widget: { type: "bounded" }, subscribe: { turnSeq: "turnSeq" } },
      ],
    } as LayoutNode;
    const finding = lintPage(page(layout), CATALOG).find((f) => f.rule === "identity-mapping");
    expect(finding?.severity).toBe("info");
  });
});

describe("panels", () => {
  test("an editable panel with no id keys its localStorage off its children", () => {
    const layout: LayoutNode = {
      kind: "tabs",
      editable: true,
      children: [{ kind: "widget", widget: { type: "bounded" } }],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).toContain("editable-panel-without-id");
  });

  test("an editable panel with an explicit id is fine", () => {
    const layout: LayoutNode = {
      kind: "tabs",
      id: "left",
      editable: true,
      target: true,
      children: [{ kind: "widget", widget: { type: "bounded" } }],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).not.toContain("editable-panel-without-id");
  });

  test("a session-bound page with panels but no target cannot host an attached move", () => {
    const layout: LayoutNode = {
      kind: "scope",
      bindUrlSession: true,
      context: { sessionId: null },
      children: [
        { kind: "tabs", id: "left", children: [{ kind: "widget", widget: { type: "bounded" } }] },
      ],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).toContain("no-target-panel");
  });

  test('a panel declaring handles: ["open-move"] counts as a target', () => {
    const layout: LayoutNode = {
      kind: "scope",
      bindUrlSession: true,
      context: { sessionId: null },
      children: [
        {
          kind: "tabs",
          id: "left",
          handles: ["open-move"],
          children: [{ kind: "widget", widget: { type: "bounded" } }],
        },
      ],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).not.toContain("no-target-panel");
  });

  test("a fullscreen session-bound page with no panel at all has no sidebar", () => {
    const layout: LayoutNode = {
      kind: "scope",
      bindUrlSession: true,
      context: { sessionId: null },
      children: [leaf("bounded")],
    } as LayoutNode;
    const findings = lintPage(page(layout, { fullscreen: true }), CATALOG);
    expect(rules(findings)).toContain("fullscreen-without-panels");
  });

  test("a fullscreen standalone tool page binds no session and is not flagged", () => {
    // trace / web / profiles are fullscreen precisely so they get the whole
    // window. Flagging them would train the reader to ignore the rule.
    const findings = lintPage(page(leaf("bounded"), { fullscreen: true }), CATALOG);
    expect(rules(findings)).not.toContain("fullscreen-without-panels");
    expect(rules(findings)).not.toContain("no-target-panel");
  });

  test("a non-fullscreen page keeps the app panels and is not flagged", () => {
    expect(rules(lintPage(page(leaf("bounded")), CATALOG))).not.toContain("fullscreen-without-panels");
  });
});

describe("conditionally exclusive siblings", () => {
  // chat-studio's empty state: the picker is `auto` and unbounded, but every
  // sibling is hidden whenever it is shown, so it has nothing to push.
  const exclusive = (autoFirst: boolean): LayoutNode => ({
    kind: "split",
    axis: "vertical",
    sizes: autoFirst ? ["auto", 1, "auto"] : [1, "auto"],
    children: [
      { kind: "widget", widget: { type: "unbounded" }, showWhen: { sessionId: null } },
      { kind: "widget", widget: { type: "unbounded" }, hideWhen: { sessionId: null } },
      { kind: "widget", widget: { type: "bounded" }, hideWhen: { sessionId: null } },
    ],
  }) as LayoutNode;

  test("an unbounded auto row alone in its visible state is not flagged", () => {
    expect(rules(lintPage(page(exclusive(true)), CATALOG))).not.toContain("unbounded-auto-row");
  });

  test("an unbounded auto row sharing its state with a sibling is still flagged", () => {
    const layout: LayoutNode = {
      kind: "split",
      axis: "vertical",
      sizes: [1, "auto", 1],
      children: [
        { kind: "widget", widget: { type: "unbounded" }, showWhen: { sessionId: null } },
        // Visible at the same time as the next child, so it can push it away.
        { kind: "widget", widget: { type: "unbounded" }, hideWhen: { sessionId: null } },
        { kind: "widget", widget: { type: "unbounded" }, hideWhen: { sessionId: null } },
      ],
    } as LayoutNode;
    expect(rules(lintPage(page(layout), CATALOG))).toContain("unbounded-auto-row");
  });
});

describe("alternate layouts", () => {
  test("layouts.mobile is linted too, and findings name it", () => {
    const mobile: LayoutNode = {
      kind: "split",
      axis: "horizontal",
      sizes: ["auto", 1],
      children: [leaf("unbounded"), leaf("bounded")],
    } as LayoutNode;
    const findings = lintPage(page(leaf("bounded"), { layouts: { mobile } }), CATALOG);
    const mobileFinding = findings.find((f) => f.rule === "unshrinkable-auto-column");
    expect(mobileFinding?.path.startsWith("layouts.mobile")).toBe(true);
  });

  test("linting a named layout that does not exist yields nothing", () => {
    expect(lintPageLayout(page(leaf("bounded")), CATALOG, { layoutName: "tablet" })).toEqual([]);
  });
});

describe("severity helpers", () => {
  test("worstSeverity is null for a clean page", () => {
    expect(worstSeverity([])).toBeNull();
  });

  test("worstSeverity reports the highest present", () => {
    const findings: LintFinding[] = [
      { rule: "a", severity: "info", path: "x", message: "" },
      { rule: "b", severity: "error", path: "y", message: "" },
      { rule: "c", severity: "warning", path: "z", message: "" },
    ];
    expect(worstSeverity(findings)).toBe("error");
  });

  test("formatFindings orders errors first", () => {
    const text = formatFindings([
      { rule: "low", severity: "info", path: "x", message: "m" },
      { rule: "high", severity: "error", path: "y", message: "m" },
    ]);
    expect(text.indexOf("high")).toBeLessThan(text.indexOf("low"));
  });
});

describe("the harness's own pages", () => {
  const pagesDir = join(import.meta.dir, "..", "..", "pages");
  const files = readdirSync(pagesDir).filter((name) => name.endsWith(".json"));

  test("there are built-in pages to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // The real catalog, imported without React: `catalog.ts` holds no components.
  test("no built-in page trips an error rule", async () => {
    const { WIDGET_META } = await import("../../ui/src/widgets/catalog");
    const failures: string[] = [];
    for (const name of files) {
      const parsed = JSON.parse(readFileSync(join(pagesDir, name), "utf8")) as LintablePage;
      const errors = lintPage(parsed, WIDGET_META).filter((f) => f.severity === "error");
      if (errors.length > 0) failures.push(`${name}:\n${formatFindings(errors)}`);
    }
    expect(failures.join("\n\n")).toBe("");
  });

  test("every widget a built-in page uses is registered", async () => {
    const { WIDGET_META } = await import("../../ui/src/widgets/catalog");
    const unknown = new Set<string>();
    for (const name of files) {
      const parsed = JSON.parse(readFileSync(join(pagesDir, name), "utf8")) as LintablePage;
      for (const finding of lintPage(parsed, WIDGET_META)) {
        if (finding.rule === "unknown-widget") unknown.add(`${name} ${finding.path}`);
      }
    }
    expect([...unknown]).toEqual([]);
  });
});
