/**
 * Page layout linter — static review of an authored page against what the
 * renderer actually does.
 *
 * This exists because a page can only be judged by looking at it, and looking
 * at it requires a human with the app open. Every rule here encodes a real
 * behaviour of `PanelTreeRenderer` / `panels.css` / `App.tsx` that is not
 * visible in the page JSON, and each one has caused a broken page at least
 * once. The point is that an author — human or agent — can iterate against
 * this in milliseconds and only spend a human's attention on a page that
 * already passes.
 *
 * Pure on purpose: no React, no DOM, no fetch. It takes the page object and a
 * widget catalog, so it runs in `bun test` and could equally back a CLI or an
 * API op.
 *
 * What it cannot do: it has no text metrics and no viewport, so it reports
 * *unbounded* layouts, never "this label is clipped at 118px". That needs
 * measurement from a rendered page, which is a different tool.
 */

import type { LayoutNode, WidgetMeta } from "./widgets/types";

export type LintSeverity = "error" | "warning" | "info";

export type LintFinding = {
  /** Stable rule id, so a caller can filter or suppress. */
  rule: string;
  severity: LintSeverity;
  /** Where in the page, as a JSON-ish path: `layout.children[0].children[2]`. */
  path: string;
  message: string;
};

/** The parts of a page this linter reads. */
export type LintablePage = {
  id?: string;
  title?: string;
  fullscreen?: boolean;
  padding?: number;
  layout?: LayoutNode;
  layouts?: Record<string, LayoutNode | undefined>;
};

type PanelNode = Extract<LayoutNode, { kind: "tabs" }> | Extract<LayoutNode, { kind: "list" }>;

function isPanel(node: LayoutNode): node is PanelNode {
  return node.kind === "tabs" || node.kind === "list";
}

function childrenOf(node: LayoutNode): LayoutNode[] {
  if (node.kind === "widget") return [];
  return (node.children ?? []) as LayoutNode[];
}

/** Every widget leaf in a subtree, in document order. */
function leavesOf(node: LayoutNode): Extract<LayoutNode, { kind: "widget" }>[] {
  if (node.kind === "widget") return [node];
  return childrenOf(node).flatMap(leavesOf);
}

/**
 * A `move:<name>` widget type is resolved at runtime by `MoveWidgetEmbed`, not
 * from the registry, so the catalog cannot confirm or deny it.
 */
function isMoveWidget(type: string): boolean {
  return type.startsWith("move:");
}

/**
 * Context keys a subtree could plausibly supply: whatever the enclosing scopes
 * declare, plus anything any `publish` in the page maps *to*.
 *
 * Deliberately generous. A widget with no `publish` map writes its raw key
 * straight onto the bus (`usePageContext`: `publishRef.current?.[key] ?? key`),
 * so a key nobody declares can still be set at runtime by a widget the linter
 * cannot see inside. Reporting an undeclared key as an error would be wrong;
 * reporting it as "nothing in this page accounts for it" is not.
 */
function collectDeclaredKeys(node: LayoutNode, into: Set<string>): void {
  if (node.kind === "scope") {
    for (const key of Object.keys(node.context ?? {})) into.add(key);
    // ScopeUrlSessionBinder pushes the URL's session id onto this key.
    if (node.bindUrlSession) into.add("sessionId");
    for (const binding of node.bindings ?? []) into.add(binding.local);
  }
  if (node.kind === "widget") {
    for (const contextKey of Object.values(node.publish ?? {})) into.add(contextKey);
  }
  for (const child of childrenOf(node)) collectDeclaredKeys(child, into);
}

/**
 * True if this subtree has a declared ceiling on its own height.
 *
 * `maxHeight` is the only bound any widget declares, so it is the only
 * evidence available that a widget placed in an `auto` split child will not
 * grow without limit. A panel node (`tabs`/`list`) has no ceiling of its own
 * and its contents can be swapped at runtime by the widget picker, so it never
 * counts as bounded.
 */
function subtreeIsHeightBounded(node: LayoutNode, catalog: Record<string, WidgetMeta>): boolean {
  const leaves = leavesOf(node);
  if (leaves.length === 0) return false;
  if (isPanel(node) || childrenOf(node).some(isPanel)) return false;
  return leaves.every((leaf) => {
    if (isMoveWidget(leaf.widget.type)) return false;
    return typeof catalog[leaf.widget.type]?.maxHeight === "number";
  });
}

/**
 * True if `child` and every one of its siblings are conditionally exclusive —
 * i.e. they are never on screen at the same time.
 *
 * An `auto` child that is alone whenever it is visible cannot push anything
 * out of the viewport, because there is nothing beside it to push. This is the
 * shape chat-studio uses for its empty state: a `showWhen: {sessionId: null}`
 * panel beside children that all carry `hideWhen: {sessionId: null}`.
 */
function exclusiveWithSiblings(child: LayoutNode, siblings: LayoutNode[]): boolean {
  const others = siblings.filter((node) => node !== child);
  if (others.length === 0) return true;

  const complement = (
    own: Record<string, unknown> | undefined,
    otherKey: "showWhen" | "hideWhen",
  ): boolean => {
    const entries = Object.entries(own ?? {});
    const only = entries.length === 1 ? entries[0] : undefined;
    if (!only) return false;
    const [key, value] = only;
    return others.every((node) => {
      const condition = (node as Record<string, unknown>)[otherKey] as
        | Record<string, unknown>
        | undefined;
      return !!condition && key in condition && condition[key] === value;
    });
  };

  const own = child as { showWhen?: Record<string, unknown>; hideWhen?: Record<string, unknown> };
  return complement(own.showWhen, "hideWhen") || complement(own.hideWhen, "showWhen");
}

/**
 * Whether this layout is the window's primary session surface — it mirrors the
 * URL's session id, the way chat-studio and chat-mobile do.
 *
 * Deliberately narrower than "mentions sessionId". A mission dashboard carries
 * a `sessionId` context key so a graph node can drive a detail pane, but it is
 * not standing in for the chat view and is not expected to grow a sidebar.
 */
function bindsUrlSession(node: LayoutNode): boolean {
  if (node.kind === "scope" && node.bindUrlSession) return true;
  return childrenOf(node).some(bindsUrlSession);
}

/** Whether any scope in this layout carries a session at all. Moves attach to sessions. */
function hasSessionContext(node: LayoutNode): boolean {
  if (node.kind === "scope") {
    if (node.bindUrlSession) return true;
    if (node.context && "sessionId" in node.context) return true;
  }
  return childrenOf(node).some(hasSessionContext);
}

/**
 * Whether a panel can receive dynamically-opened move widgets. `target: true`
 * is the usual way; an explicit `handles` entry does the same job
 * (`editablePanelSupportsDynamicMoves`).
 */
function acceptsDynamicMoves(node: PanelNode): boolean {
  if (node.target === true) return true;
  return (node.handles ?? []).some((entry) => {
    const type = typeof entry === "string" ? entry : entry.type;
    return type === "open-move" || type === "close-move";
  });
}

function describeSubtree(node: LayoutNode): string {
  const types = leavesOf(node).map((leaf) => leaf.widget.type);
  const first = types[0];
  if (!first) return node.kind;
  if (types.length === 1) return first;
  return `${first} +${types.length - 1} more`;
}

export function lintPageLayout(
  page: LintablePage,
  catalog: Record<string, WidgetMeta>,
  options: { layoutName?: string } = {},
): LintFinding[] {
  const findings: LintFinding[] = [];
  const root = options.layoutName
    ? page.layouts?.[options.layoutName]
    : page.layout;
  const rootPath = options.layoutName ? `layouts.${options.layoutName}` : "layout";
  if (!root) return findings;

  const add = (rule: string, severity: LintSeverity, path: string, message: string) =>
    findings.push({ rule, severity, path, message });

  const declaredKeys = new Set<string>();
  collectDeclaredKeys(root, declaredKeys);

  const seenWidgetIds = new Map<string, string>();
  const panels: { node: PanelNode; path: string }[] = [];

  const walk = (node: LayoutNode, path: string): void => {
    // ── Conditional visibility keys ──
    for (const source of ["showWhen", "hideWhen"] as const) {
      const conditions = (node as { showWhen?: Record<string, unknown>; hideWhen?: Record<string, unknown> })[source];
      for (const key of Object.keys(conditions ?? {})) {
        if (!declaredKeys.has(key)) {
          add(
            "unaccounted-context-key",
            "warning",
            `${path}.${source}`,
            `\`${source}\` tests context key "${key}", which no scope declares and no \`publish\` writes. `
            + `If nothing sets it the condition never changes, so this node is permanently `
            + `${source === "showWhen" ? "hidden" : "visible"}.`,
          );
        }
      }
    }

    if (node.kind === "widget") {
      const type = node.widget.type;
      const meta = catalog[type];

      if (!meta && !isMoveWidget(type)) {
        add(
          "unknown-widget",
          "error",
          `${path}.widget.type`,
          `"${type}" is not a registered widget type. It renders as the literal text `
          + `"unknown widget: ${type}".`,
        );
      }

      const widgetId = node.widget.id;
      if (widgetId) {
        const previous = seenWidgetIds.get(widgetId);
        if (previous) {
          add(
            "duplicate-widget-id",
            "error",
            `${path}.widget.id`,
            `Widget id "${widgetId}" is already used at ${previous}. Ids key panel state and `
            + `tab focus, so duplicates collide.`,
          );
        } else {
          seenWidgetIds.set(widgetId, path);
        }
      }

      for (const source of ["publish", "subscribe"] as const) {
        for (const [widgetKey, contextKey] of Object.entries(node[source] ?? {})) {
          if (widgetKey === contextKey) {
            add(
              "identity-mapping",
              "info",
              `${path}.${source}.${widgetKey}`,
              `"${widgetKey}" maps to itself. Unmapped keys already fall through to the same `
              + `name (usePageContext: \`map?.[key] ?? key\`), so this entry does nothing.`,
            );
          }
        }
        if (source === "subscribe") {
          for (const contextKey of Object.values(node.subscribe ?? {})) {
            if (!declaredKeys.has(contextKey)) {
              add(
                "unaccounted-context-key",
                "warning",
                `${path}.subscribe`,
                `Subscribes to context key "${contextKey}", which no scope declares and no `
                + `\`publish\` writes.`,
              );
            }
          }
        }
      }

      if (meta && !meta.description) {
        add(
          "undescribed-widget",
          "info",
          `${path}.widget.type`,
          `"${type}" has no description in the widget catalog, so an author cannot tell what it `
          + `renders without reading its source.`,
        );
      }
      return;
    }

    if (isPanel(node)) {
      panels.push({ node, path });
      if (node.editable && !node.id) {
        add(
          "editable-panel-without-id",
          "warning",
          path,
          `\`editable: true\` with no \`id\`. The panel's contents persist to localStorage under a `
          + `key derived from its children (\`panelStorageKey\`), so editing this page's JSON `
          + `changes the key and silently discards the user's customization — and two pages `
          + `listing the same widget ids share one saved panel. Set an explicit \`id\`.`,
        );
      }
    }

    if (node.kind === "split") {
      const children = node.children ?? [];
      const sizes = node.sizes;
      if (sizes && sizes.length !== children.length) {
        add(
          "sizes-length-mismatch",
          "error",
          `${path}.sizes`,
          `\`sizes\` has ${sizes.length} entries for ${children.length} children. Missing entries `
          + `default to flex weight 1, which is rarely what was meant.`,
        );
      }
      if (node.collapsible && node.collapsible.length !== children.length) {
        add(
          "collapsible-length-mismatch",
          "warning",
          `${path}.collapsible`,
          `\`collapsible\` has ${node.collapsible.length} entries for ${children.length} children.`,
        );
      }

      children.forEach((child, index) => {
        if (sizes?.[index] !== "auto") return;
        const childPath = `${path}.children[${index}]`;
        // `auto` compiles to `flex: 0 0 auto`, and `.panel-split-child--auto`
        // forces `min-width: auto; min-height: auto; overflow: visible`. The
        // child therefore sizes to its content and *cannot shrink* — it takes
        // its space from its siblings and never gives it back.
        if (node.axis === "horizontal") {
          add(
            "unshrinkable-auto-column",
            "warning",
            `${childPath}`,
            `\`"auto"\` in a horizontal split makes this column \`flex: 0 0 auto\` with `
            + `\`min-width: auto\`, so it claims its full content width and cannot shrink. `
            + `No widget declares a maximum width, so text inside (${describeSubtree(child)}) sets `
            + `the column width — squeezing its siblings and overflowing on a narrow window. `
            + `Use a flex weight, or bound the content.`,
          );
        } else if (!subtreeIsHeightBounded(child, catalog) && !exclusiveWithSiblings(child, children)) {
          add(
            "unbounded-auto-row",
            "warning",
            `${childPath}`,
            `\`"auto"\` in a vertical split makes this row \`flex: 0 0 auto\` with `
            + `\`min-height: auto\`, and ${describeSubtree(child)} declares no \`maxHeight\`, so it `
            + `grows to its content and pushes its siblings out of the viewport.`,
          );
        }
      });

      // A bare `kind: "widget"` child of a split renders as the component alone —
      // `PanelTreeRenderer` returns `<>{item.render(true)}</>` with no frame,
      // header, or title. Right for a transcript or a composer, wrong for
      // anything the reader has to identify.
      const bareLeaves = children.filter((child) => child.kind === "widget");
      if (bareLeaves.length >= 2) {
        add(
          "unlabelled-bare-leaves",
          "info",
          path,
          `${bareLeaves.length} sibling \`kind: "widget"\` children. A bare widget leaf renders with `
          + `no frame, header, or title, so adjacent ones read as one undivided surface. `
          + `Wrap in \`tabs\`/\`list\` for a labelled panel.`,
        );
      }
    }

    for (const [index, child] of childrenOf(node).entries()) {
      walk(child, `${path}.children[${index}]`);
    }
  };

  walk(root, rootPath);

  // ── Page-level rules ──

  // Only a session-bound surface is expected to carry navigation. A standalone
  // tool page (trace, web, profiles) is fullscreen precisely so it can have the
  // whole window, and flagging those would train the reader to ignore the rule.
  const primarySurface = bindsUrlSession(root);
  const sessionBound = hasSessionContext(root);

  if (page.fullscreen && primarySurface && panels.length === 0) {
    add(
      "fullscreen-without-panels",
      "warning",
      rootPath,
      `\`fullscreen: true\` suppresses the app's LeftPanel and RightPanel `
      + `(\`shouldShowAppPanels = panelsEnabled && !isFullscreenPage\`), and this session-bound `
      + `layout defines no \`tabs\`/\`list\` panel to replace them. The page has no sidebar, no `
      + `session switcher, and no viewer panel.`,
    );
  }

  if (sessionBound && panels.length > 0 && !panels.some(({ node }) => acceptsDynamicMoves(node))) {
    add(
      "no-target-panel",
      "warning",
      rootPath,
      `No panel sets \`target: true\` or declares \`handles: ["open-move"]\`. That is what lets a `
      + `panel receive dynamically attached move widgets and action terminals `
      + `(\`editablePanelSupportsDynamicMoves\`), so on this session-bound page an attached move `
      + `has nowhere to appear.`,
    );
  }

  return findings;
}

/** Lint the default layout and every named alternate (`layouts.mobile`, …). */
export function lintPage(
  page: LintablePage,
  catalog: Record<string, WidgetMeta>,
): LintFinding[] {
  const findings = lintPageLayout(page, catalog);
  for (const layoutName of Object.keys(page.layouts ?? {})) {
    if (!page.layouts?.[layoutName]) continue;
    findings.push(...lintPageLayout(page, catalog, { layoutName }));
  }
  return findings;
}

/** Highest severity present, or null for a clean page. */
export function worstSeverity(findings: LintFinding[]): LintSeverity | null {
  if (findings.some((f) => f.severity === "error")) return "error";
  if (findings.some((f) => f.severity === "warning")) return "warning";
  if (findings.length > 0) return "info";
  return null;
}

/** Human-readable report, for a CLI or a test failure message. */
export function formatFindings(findings: LintFinding[]): string {
  if (findings.length === 0) return "no findings";
  const order: LintSeverity[] = ["error", "warning", "info"];
  return findings
    .slice()
    .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
    .map((f) => `[${f.severity}] ${f.rule} @ ${f.path}\n    ${f.message}`)
    .join("\n");
}
