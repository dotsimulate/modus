/**
 * Page inspector — measured geometry of a rendered page.
 *
 * The linter reads page JSON and reports what *cannot* work. This reports what
 * actually happened: real rectangles, real overflow, real clipping. It is the
 * half that catches "the label is cut off" and "that pane rendered 3px wide",
 * neither of which is derivable from the config.
 *
 * Two pieces, split on purpose. `captureBoxes` touches the DOM and can only run
 * in a browser. `analyzeBoxes` is pure over the captured tree, so the rules are
 * unit-testable with hand-built fixtures and no jsdom — this repo has no
 * testing-library and pure logic is the only thing that can be pinned.
 *
 * Nothing here changes layout. It reads `getBoundingClientRect` and
 * `getComputedStyle` on elements that already exist, deliberately rather than
 * tagging the renderer with inspection attributes: a probe that alters the tree
 * it measures is worse than no probe.
 */

export type InspectedBox = {
  /** Readable ancestry, e.g. `div.panel-split > div.panel-split-child[1] > div.session-turns`. */
  path: string;
  /** Tag plus the element's classes, for eyeballing which component this is. */
  className: string;
  rect: { x: number; y: number; w: number; h: number };
  scrollW: number;
  scrollH: number;
  clientW: number;
  clientH: number;
  overflowX: string;
  overflowY: string;
  /** First bit of text content, truncated — enough to identify a clipped label. */
  text?: string;
  children: InspectedBox[];
};

export type InspectSeverity = "error" | "warning" | "info";

export type InspectFinding = {
  rule: string;
  severity: InspectSeverity;
  path: string;
  message: string;
};

export type PageInspectReport = {
  pageId: string;
  layoutName?: string;
  viewport: { w: number; h: number };
  capturedAt: number;
  boxes: InspectedBox;
  findings: InspectFinding[];
};

/** Sub-pixel layout means exact comparisons produce noise. */
const SLACK = 1.5;

/** A pane this thin is not showing anything, whatever it was supposed to contain. */
const STARVED_PX = 24;

function isScrollable(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

function isClipping(overflow: string): boolean {
  return overflow === "hidden" || overflow === "clip";
}

/**
 * Rules over measured geometry.
 *
 * Each one describes a state the user can see and the config cannot predict.
 * `hidden` overflow with content past the edge is the important one: content
 * that is simply *scrollable* is fine, content that is clipped is gone.
 */
export function analyzeBoxes(
  root: InspectedBox,
  viewport: { w: number; h: number },
): InspectFinding[] {
  const findings: InspectFinding[] = [];

  const visit = (box: InspectedBox, depth: number): void => {
    const { rect, path } = box;
    const hasArea = rect.w > 0 && rect.h > 0;

    // ── Clipped content ──
    if (box.scrollW > box.clientW + SLACK && isClipping(box.overflowX)) {
      findings.push({
        rule: "clipped-horizontally",
        severity: "error",
        path,
        message:
          `Content is ${Math.round(box.scrollW - box.clientW)}px wider than the box `
          + `(${Math.round(box.scrollW)} vs ${Math.round(box.clientW)}) and \`overflow-x: ${box.overflowX}\`, `
          + `so that much is cut off with no way to reach it.`
          + (box.text ? ` Text begins "${box.text}".` : ""),
      });
    }
    if (box.scrollH > box.clientH + SLACK && isClipping(box.overflowY)) {
      findings.push({
        rule: "clipped-vertically",
        severity: "error",
        path,
        message:
          `Content is ${Math.round(box.scrollH - box.clientH)}px taller than the box `
          + `(${Math.round(box.scrollH)} vs ${Math.round(box.clientH)}) and \`overflow-y: ${box.overflowY}\`, `
          + `so the bottom is cut off and cannot be scrolled to.`,
      });
    }

    // ── Escaped the viewport ──
    if (hasArea && rect.x + rect.w > viewport.w + SLACK) {
      findings.push({
        rule: "past-right-edge",
        severity: "error",
        path,
        message:
          `Extends ${Math.round(rect.x + rect.w - viewport.w)}px past the right edge of the `
          + `${viewport.w}px viewport, so its right side is off screen.`,
      });
    }

    // ── Collapsed panes ──
    // A leaf with no children and no size is usually just an empty div; a node
    // that contains something and has no size has lost that something.
    if (box.children.length > 0) {
      if (rect.w <= SLACK || rect.h <= SLACK) {
        findings.push({
          rule: "collapsed-pane",
          severity: "error",
          path,
          message:
            `Rendered ${Math.round(rect.w)}×${Math.round(rect.h)} while containing `
            + `${box.children.length} child ${box.children.length === 1 ? "box" : "boxes"}. `
            + `Its contents are not visible.`,
        });
      } else if (rect.w < STARVED_PX || rect.h < STARVED_PX) {
        findings.push({
          rule: "starved-pane",
          severity: "warning",
          path,
          message:
            `Rendered ${Math.round(rect.w)}×${Math.round(rect.h)} — too small to read. `
            + `A sibling is probably taking the space; check for an \`auto\` split child.`,
        });
      }
    }

    // ── Nested scrollers ──
    // Two scroll containers on the same axis in one chain means the user's
    // wheel goes to whichever one is under the pointer, which reads as the page
    // randomly refusing to scroll.
    if (isScrollable(box.overflowY)) {
      const nestedScroller = box.children.find(
        (child) => isScrollable(child.overflowY) && child.scrollH > child.clientH + SLACK,
      );
      if (nestedScroller && box.scrollH > box.clientH + SLACK) {
        findings.push({
          rule: "nested-scrollers",
          severity: "warning",
          path,
          message:
            `Scrolls vertically and directly contains another vertical scroller `
            + `(${nestedScroller.path.split(" > ").pop()}) that also overflows. Which one moves `
            + `depends on where the pointer is.`,
        });
      }
    }

    for (const child of box.children) visit(child, depth + 1);
  };

  visit(root, 0);
  return findings;
}

/** Highest severity present, or null when the page measured clean. */
export function worstInspectSeverity(findings: InspectFinding[]): InspectSeverity | null {
  if (findings.some((f) => f.severity === "error")) return "error";
  if (findings.some((f) => f.severity === "warning")) return "warning";
  return findings.length > 0 ? "info" : null;
}

export function formatInspectFindings(findings: InspectFinding[]): string {
  if (findings.length === 0) return "no findings";
  const order: InspectSeverity[] = ["error", "warning", "info"];
  return findings
    .slice()
    .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
    .map((f) => `[${f.severity}] ${f.rule} @ ${f.path}\n    ${f.message}`)
    .join("\n");
}

// ── DOM capture (browser only) ──

function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const classes = typeof el.className === "string" ? el.className.trim() : "";
  if (!classes) return tag;
  // Long utility class lists add noise without adding identity.
  return `${tag}.${classes.split(/\s+/).slice(0, 3).join(".")}`;
}

export type CaptureOptions = {
  /** How deep to walk. Deeper trees are mostly markdown internals. */
  maxDepth?: number;
  /** Hard cap on captured nodes, so a huge transcript cannot produce a huge report. */
  maxNodes?: number;
};

/**
 * Walk a rendered subtree and record every element's geometry.
 *
 * Skips zero-area leaves, which are overwhelmingly spacers and inline spans and
 * would bury the findings that matter.
 */
export function captureBoxes(root: Element, options: CaptureOptions = {}): InspectedBox {
  const maxDepth = options.maxDepth ?? 12;
  const maxNodes = options.maxNodes ?? 600;
  let captured = 0;

  const build = (el: Element, path: string, depth: number): InspectedBox => {
    captured += 1;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const htmlEl = el as HTMLElement;

    const children: InspectedBox[] = [];
    if (depth < maxDepth) {
      const elementChildren = Array.from(el.children);
      for (const [index, child] of elementChildren.entries()) {
        if (captured >= maxNodes) break;
        const childRect = child.getBoundingClientRect();
        const isLeaf = child.children.length === 0;
        if (isLeaf && childRect.width === 0 && childRect.height === 0) continue;
        children.push(build(child, `${path} > ${describeElement(child)}[${index}]`, depth + 1));
      }
    }

    const ownText = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);

    return {
      path,
      className: describeElement(el),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      scrollW: htmlEl.scrollWidth,
      scrollH: htmlEl.scrollHeight,
      clientW: htmlEl.clientWidth,
      clientH: htmlEl.clientHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      ...(ownText ? { text: ownText } : {}),
      children,
    };
  };

  return build(root, describeElement(root), 0);
}

/** Measure a rendered page and analyze it in one call. */
export function inspectPage(
  root: Element,
  meta: { pageId: string; layoutName?: string },
  options?: CaptureOptions,
): PageInspectReport {
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const boxes = captureBoxes(root, options);
  return {
    pageId: meta.pageId,
    ...(meta.layoutName ? { layoutName: meta.layoutName } : {}),
    viewport,
    capturedAt: Date.now(),
    boxes,
    findings: analyzeBoxes(boxes, viewport),
  };
}
