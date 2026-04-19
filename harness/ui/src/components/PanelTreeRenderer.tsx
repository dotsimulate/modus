import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { View } from "../views";
import type { MoveWidgetInfo } from "../../../sdk/index";
import { WIDGET_DEFS, WIDGETS, type LayoutLeaf, type LayoutNode, type ScopeEvent, type WidgetBase } from "../widgets";
import { PanelSurface, type PanelSurfaceItem } from "./PanelSurface";
import { WidgetPicker } from "./WidgetPicker";
import { usePageContext, useLeafVisible, ScopeProvider, useScopeBus, ScopeUrlSessionBinder } from "./pageScope";
import { MoveWidgetEmbed } from "./MoveWidgetEmbed";
import { MoveWidget, evictWidgetModule } from "./MoveWidget";
import { modus } from "../modusClient";
import { useFileViewer } from "../providers/FileViewerContext";

type Props = {
  node: LayoutNode;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  empty?: ReactNode;
};

function getLeafId(leaf: LayoutLeaf, index: number): string {
  return leaf.id?.trim() || leaf.widget.id?.trim() || `${leaf.widget.type}-${index + 1}`;
}

/**
 * True if the subtree rooted at `node` contains an editable target panel
 * (one that receives dynamic move tabs). Used by ResizableSplit to know which
 * collapsed children should pop open when an `expand-target` event fires.
 */
function containsTarget(node: LayoutNode): boolean {
  if ((node.kind === "tabs" || node.kind === "list") && node.editable && node.target) {
    return true;
  }
  if (node.kind === "split" || node.kind === "scope") {
    return node.children.some(containsTarget);
  }
  if (node.kind === "grid") {
    return (node.children ?? []).some(containsTarget);
  }
  return false;
}

/** Check if a widget type is a move widget reference (e.g. "move:chess") */
function isMoveWidget(type: string): boolean {
  return type.startsWith("move:");
}

/** Extract the move name from a move widget type (e.g. "move:chess" → "chess") */
function getMoveWidgetName(type: string): string {
  return type.slice("move:".length);
}

function LeafWidget({
  leaf,
  index,
  active,
  onNavigate,
  onSelectSession,
}: {
  leaf: LayoutLeaf;
  index: number;
  active: boolean;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
}) {
  const widgetId = getLeafId(leaf, index);
  const pageContext = usePageContext(leaf.publish, leaf.subscribe, leaf.canNavigate);
  const visible = useLeafVisible(leaf.showWhen, leaf.hideWhen);

  if (!visible) return null;

  // Move widget resolution: "move:chess" → MoveWidgetEmbed
  if (isMoveWidget(leaf.widget.type)) {
    return (
      <MoveWidgetEmbed
        moveName={getMoveWidgetName(leaf.widget.type)}
        widgetId={widgetId}
        pageContext={pageContext}
      />
    );
  }

  const def = WIDGET_DEFS[leaf.widget.type];
  const Comp = def?.miniComponent ?? def?.component;

  if (!Comp) return <div className="panel-empty">unknown widget: {leaf.widget.type}</div>;

  return (
    <Comp
      config={leaf.widget}
      widgetId={widgetId}
      active={active}
      onNavigate={onNavigate}
      onSelectSession={onSelectSession}
      pageContext={pageContext}
    />
  );
}

/** Compact SVG icons for widget tabs — matches RightPanel iconFor */
function widgetIcon(widgetType: string): ReactNode | undefined {
  if (widgetType === "code-editor") {
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <path d="M4.5 3.5L2 6l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M7.5 3.5L10 6l-2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (widgetType === "agent-activity") {
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <path d="M1 6h2l1.5-3 2 6L8.5 3 10 6h1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (widgetType === "session-edits") {
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <rect x="1" y="1" width="10" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.1"/>
        <rect x="1" y="5.5" width="10" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.1"/>
      </svg>
    );
  }
  if (widgetType === "session-terminal") {
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <path d="M2 3l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M7 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    );
  }
  if (widgetType === "session-list") {
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <path d="M2 3h8M2 6h8M2 9h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    );
  }
  if (widgetType === "session-history") {
    // Mirrors the sort icon used inside the widget itself — three stepped
    // lines (descending) read as "ordered history".
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <path d="M2 3h8M3 6h6M4 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    );
  }
  if (widgetType === "session-sidebar") {
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <rect x="1" y="1" width="10" height="10" rx="1" stroke="currentColor" strokeWidth="1.1" fill="none"/>
        <path d="M4 1v10" stroke="currentColor" strokeWidth="1.1"/>
      </svg>
    );
  }
  if (widgetType === "profiles-manager" || widgetType === "profile-card") {
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <circle cx="6" cy="4" r="2.5" stroke="currentColor" strokeWidth="1.1"/>
        <path d="M2 11c0-2.2 1.8-4 4-4s4 1.8 4 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
      </svg>
    );
  }
  if (widgetType === "actions-manager") {
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <path d="M6 1v4l3 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.1" fill="none"/>
      </svg>
    );
  }
  if (widgetType === "moves") {
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <path d="M2 6h8M6 2v8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    );
  }
  if (widgetType === "inbox") {
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <path d="M1 7h3l1 2h2l1-2h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
        <rect x="1" y="2" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.1" fill="none"/>
      </svg>
    );
  }
  if (widgetType === "new-session") {
    return (
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    );
  }
  return undefined;
}

/**
 * ScopeSessionWatcher — invisible component that monitors the scope's session
 * for active move widgets and emits "open-move" events on the scope bus.
 * Rendered inside each scope node that has a sessionId in its context.
 */
const emptySnapshot: Record<string, unknown> = {};
function ScopeSessionWatcher() {
  const bus = useScopeBus();
  const state = useSyncExternalStore(
    bus ? bus.subscribe : () => () => {},
    bus ? bus.getSnapshot : () => emptySnapshot,
  );
  const sessionId = state.sessionId as string | undefined | null;
  const knownWidgets = useRef(new Set<string>());
  const prevSessionId = useRef<string | null>(null);

  useEffect(() => {
    if (prevSessionId.current !== (sessionId ?? null)) {
      knownWidgets.current.clear();
      prevSessionId.current = sessionId ?? null;
    }

    if (!sessionId || !bus) return;

    let cancelled = false;
    const fetchSessionId = sessionId;

    const fetchWidgets = () => {
      modus.getActiveWidgets(fetchSessionId).then((widgets) => {
        if (cancelled) return;
        for (const w of widgets) {
          if (!knownWidgets.current.has(w.instanceId)) {
            knownWidgets.current.add(w.instanceId);
            bus.emit({
              type: "open-move",
              id: `widget:${w.instanceId}`,
              label: w.widget.label,
              widget: w.widget,
              apiToken: w.apiToken,
              instanceId: w.instanceId,
              sessionId: fetchSessionId,
              mountedOnAttach: w.widget.mountOnAttach ?? false,
            });
          }
        }
      }).catch(() => {});
    };

    fetchWidgets();
    const handler = () => fetchWidgets();
    window.addEventListener("modus:widgets-changed", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("modus:widgets-changed", handler);
    };
  }, [sessionId, bus]);

  return null;
}

function renderLeaf(
  leaf: LayoutLeaf,
  index: number,
  onNavigate: (view: View) => void,
  onSelectSession: (id: string) => void,
): PanelSurfaceItem {
  const widgetId = getLeafId(leaf, index);
  const isMove = isMoveWidget(leaf.widget.type);
  const def = isMove ? undefined : WIDGET_DEFS[leaf.widget.type];
  const label = leaf.widget.title ?? (isMove ? getMoveWidgetName(leaf.widget.type) : leaf.widget.type);

  return {
    id: widgetId,
    label,
    title: label,
    icon: widgetIcon(leaf.widget.type) ?? undefined,
    minHeight: def?.minHeight ?? (isMove ? 200 : undefined),
    maxHeight: def?.maxHeight,
    preferredHeight: def?.preferredHeight ?? (isMove ? 400 : undefined),
    defaultCollapsed: leaf.widget.collapsed ?? false,
    render: (active) => (
      <LeafWidget
        leaf={leaf}
        index={index}
        active={active}
        onNavigate={onNavigate}
        onSelectSession={onSelectSession}
      />
    ),
  };
}

// ── Resizable split panels ──

type SplitNode = Extract<LayoutNode, { kind: "split" }>;

/**
 * Collapse tab on the inner edge of a collapsible split child.
 * Click → toggle collapse. Drag → resize the adjacent panels.
 * Replaces the separate resize handle for collapsible children.
 */
function SplitCollapseTab({
  axis,
  side,
  collapsed,
  onToggle,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
}: {
  axis: "horizontal" | "vertical";
  side: "before" | "after";
  collapsed: boolean;
  onToggle: () => void;
  /** If provided, the tab doubles as a drag handle for resizing */
  onResizeStart?: (e: React.PointerEvent) => void;
  onResizeMove?: (e: React.PointerEvent) => void;
  onResizeEnd?: () => void;
}) {
  const isPressed = useRef(false);
  const didDrag = useRef(false);
  const startPos = useRef(0);

  const isHorizontal = axis === "horizontal";
  let chevron: "left" | "right" | "up" | "down";
  if (isHorizontal) {
    chevron = side === "before"
      ? (collapsed ? "right" : "left")
      : (collapsed ? "left" : "right");
  } else {
    chevron = side === "before"
      ? (collapsed ? "down" : "up")
      : (collapsed ? "up" : "down");
  }

  const paths: Record<string, string> = {
    left:  "M6 2L2 5.5 6 9",
    right: "M4 2l4 3.5L4 9",
    up:    "M2 6.5L5.5 3 9 6.5",
    down:  "M2 3.5L5.5 7 9 3.5",
  };

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    isPressed.current = true;
    didDrag.current = false;
    startPos.current = isHorizontal ? e.clientX : e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [isHorizontal]);

  const DRAG_THRESHOLD = 10;

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPressed.current) return;
    const pos = isHorizontal ? e.clientX : e.clientY;
    const delta = Math.abs(pos - startPos.current);
    if (!didDrag.current && delta >= DRAG_THRESHOLD) {
      didDrag.current = true;
      onResizeStart?.(e);
    }
    if (didDrag.current) {
      onResizeMove?.(e);
    }
  }, [isHorizontal, onResizeStart, onResizeMove]);

  const handlePointerUp = useCallback(() => {
    if (!isPressed.current) return;
    isPressed.current = false;
    if (didDrag.current) {
      onResizeEnd?.();
    } else {
      onToggle();
    }
    didDrag.current = false;
  }, [onToggle, onResizeEnd]);

  const canDrag = !collapsed && !!onResizeStart;

  const className = [
    "split-collapse-tab",
    `split-collapse-tab--${axis}`,
    `split-collapse-tab--${side}`,
    collapsed ? "split-collapse-tab--collapsed" : "",
    canDrag ? "split-collapse-tab--draggable" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={className}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      title={collapsed ? "Expand panel" : "Drag to resize · Click to collapse"}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d={paths[chevron]} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
  );
}

/**
 * Split child wrapper — handles showWhen/hideWhen visibility for leaf nodes.
 * When a leaf is hidden by conditions, the wrapper collapses to 0 height/width
 * so the split layout reclaims the space.
 */
function SplitChild({
  node,
  flex,
  isCollapsed,
  isAuto,
  onNavigate,
  onSelectSession,
  empty,
}: {
  node: LayoutNode;
  flex: string;
  isCollapsed: boolean;
  isAuto: boolean;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  empty: ReactNode;
}) {
  // All node types support showWhen/hideWhen
  const visible = useLeafVisible(node.showWhen, node.hideWhen);
  const hidden = !visible;

  const effectiveFlex = hidden ? "0 0 0px" : flex;
  const className = [
    "panel-split-child",
    isCollapsed ? "panel-split-child--collapsed" : "",
    isAuto ? "panel-split-child--auto" : "",
    hidden ? "panel-split-child--collapsed" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={className} style={{ flex: effectiveFlex }}>
      {!isCollapsed && !hidden && (
        <PanelTreeRenderer
          node={node}
          onNavigate={onNavigate}
          onSelectSession={onSelectSession}
          empty={empty}
        />
      )}
    </div>
  );
}

function ResizableSplit({
  node,
  onNavigate,
  onSelectSession,
  empty,
}: {
  node: SplitNode;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  empty: ReactNode;
}) {
  const count = node.children.length;
  const rawSizes = node.children.map((_, i) => node.sizes?.[i] ?? 1);
  // Track which children are "auto" (content-sized, not flex)
  const autoFlags = rawSizes.map((s) => s === "auto");
  // Flex sizes only (auto children get 0 — they don't participate in flex)
  const defaultFlexSizes = rawSizes.map((s) => (s === "auto" ? 0 : s));
  const collapsible = node.collapsible ?? [];
  const [sizes, setSizes] = useState(defaultFlexSizes);
  const [collapsed, setCollapsed] = useState<boolean[]>(() => {
    const isMobile = typeof window !== "undefined" && window.innerWidth <= 640;
    return new Array(count).fill(false).map((_, i) => isMobile && collapsible[i] === true);
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ index: number; startPos: number; startSizes: number[] } | null>(null);

  const toggleCollapsed = useCallback((index: number) => {
    setCollapsed((prev) => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  }, []);

  // Auto-expand: when a target panel deeper in this split's subtree gains a new
  // dynamic tab, it emits "expand-target" on the scope bus. Uncollapse any
  // collapsible child whose subtree contains a target panel so the new tab is
  // visible. Other splits at different levels listen too — cascade handles deep nesting.
  const expandBus = useScopeBus();
  useEffect(() => {
    if (!expandBus) return;
    return expandBus.on("expand-target", () => {
      const collapsibleFlags = node.collapsible ?? [];
      setCollapsed((prev) => {
        let changed = false;
        const next = prev.map((isCollapsed, i) => {
          if (isCollapsed && collapsibleFlags[i] && containsTarget(node.children[i])) {
            changed = true;
            return false;
          }
          return isCollapsed;
        });
        return changed ? next : prev;
      });
    });
  }, [expandBus, node]);

  // Only allow resize between two non-auto, non-collapsed flex children
  const canResize = useCallback((handleIndex: number) => {
    const left = handleIndex;
    const right = handleIndex + 1;
    if (autoFlags[left] || autoFlags[right]) return false;
    if (collapsed[left] || collapsed[right]) return false;
    return true;
  }, [autoFlags, collapsed]);

  /** Begin a resize drag between children at handleIndex and handleIndex+1 */
  const startResize = useCallback((e: React.PointerEvent, handleIndex: number) => {
    if (!canResize(handleIndex)) return;
    const pos = node.axis === "horizontal" ? e.clientX : e.clientY;
    dragging.current = { index: handleIndex, startPos: pos, startSizes: [...sizes] };
  }, [sizes, node.axis, canResize]);

  const onHandlePointerDown = useCallback((e: React.PointerEvent, handleIndex: number) => {
    if (!canResize(handleIndex)) return;
    e.preventDefault();
    startResize(e, handleIndex);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [canResize, startResize]);

  const updateResize = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const { index, startPos: dragStart, startSizes } = dragging.current;
    const rect = containerRef.current.getBoundingClientRect();
    const totalPx = node.axis === "horizontal" ? rect.width : rect.height;
    const pos = node.axis === "horizontal" ? e.clientX : e.clientY;
    const deltaPx = pos - dragStart;
    const totalFlex = startSizes.reduce((a, b) => a + b, 0) || 1;
    const deltaFlex = (deltaPx / totalPx) * totalFlex;

    const newSizes = [...startSizes];
    const minFlex = 0.05 * totalFlex;
    newSizes[index] = Math.max(minFlex, startSizes[index] + deltaFlex);
    newSizes[index + 1] = Math.max(minFlex, startSizes[index + 1] - deltaFlex);
    setSizes(newSizes);
  }, [node.axis]);

  const endResize = useCallback(() => {
    dragging.current = null;
  }, []);

  if (count === 0) {
    return (
      <div className={`panel-split panel-split--${node.axis}`}>
        <div className="panel-split-child" style={{ flex: "1 1 0%" }}>{empty}</div>
      </div>
    );
  }

  const elements: ReactNode[] = [];
  node.children.forEach((child, index) => {
    const isAuto = autoFlags[index];
    const isCollapsible = collapsible[index] === true;
    const isCollapsed = isCollapsible && collapsed[index];
    // Tab side: first child → "after" (right/bottom edge), last → "before" (left/top edge)
    const tabSide: "before" | "after" | null = isCollapsible
      ? (index === count - 1 ? "before" : "after")
      : null;

    // The handle index this child's tab replaces:
    // "after" tab replaces the handle to its right (between this and next child)
    // "before" tab replaces the handle to its left (between prev and this child)
    const tabHandleIndex = tabSide === "after" ? index : index - 1;

    // Resize handle between children.
    // Skip when: either neighbor is collapsed, OR a collapse tab will serve as the handle.
    if (index > 0) {
      const prevCollapsed = collapsible[index - 1] && collapsed[index - 1];
      const hideHandle = isCollapsed || prevCollapsed;
      const prevIsCollapsible = collapsible[index - 1] === true;
      const prevTabSide = prevIsCollapsible ? (index - 1 === count - 1 ? "before" : "after") : null;
      const handleReplacedByTab = (prevTabSide === "after") || (tabSide === "before");

      if (!hideHandle && !handleReplacedByTab) {
        const resizable = canResize(index - 1);
        elements.push(
          <div
            key={`handle-${index}`}
            className={`panel-split-handle panel-split-handle--${node.axis}${!resizable ? " panel-split-handle--static" : ""}`}
            onPointerDown={resizable ? (e) => onHandlePointerDown(e, index - 1) : undefined}
            onPointerMove={resizable ? updateResize : undefined}
            onPointerUp={resizable ? endResize : undefined}
          />,
        );
      }
    }

    // Collapse tab BEFORE the child (last/rightmost panels).
    // Also serves as the resize handle for the boundary to its left.
    if (tabSide === "before") {
      const resizable = tabHandleIndex >= 0 && canResize(tabHandleIndex);
      elements.push(
        <SplitCollapseTab
          key={`collapse-${index}`}
          axis={node.axis}
          side={tabSide}
          collapsed={isCollapsed}
          onToggle={() => toggleCollapsed(index)}
          onResizeStart={resizable ? (e) => startResize(e, tabHandleIndex) : undefined}
          onResizeMove={resizable ? updateResize : undefined}
          onResizeEnd={resizable ? endResize : undefined}
        />,
      );
    }

    // The child itself
    const size = sizes[index] ?? 1;
    let flex: string;
    if (isCollapsed) {
      flex = "0 0 0px";
    } else if (isAuto) {
      flex = "0 0 auto";
    } else {
      flex = `${size} ${size} 0%`;
    }

    elements.push(
      <SplitChild
        key={child.id ?? `${child.kind}-${index}`}
        node={child}
        flex={flex}
        isCollapsed={isCollapsed}
        isAuto={isAuto}
        onNavigate={onNavigate}
        onSelectSession={onSelectSession}
        empty={empty}
      />,
    );

    // Collapse tab AFTER the child (first/leftmost panels).
    // Also serves as the resize handle for the boundary to its right.
    if (tabSide === "after") {
      const resizable = tabHandleIndex < count - 1 && canResize(tabHandleIndex);
      elements.push(
        <SplitCollapseTab
          key={`collapse-${index}`}
          axis={node.axis}
          side={tabSide}
          collapsed={isCollapsed}
          onToggle={() => toggleCollapsed(index)}
          onResizeStart={resizable ? (e) => startResize(e, tabHandleIndex) : undefined}
          onResizeMove={resizable ? updateResize : undefined}
          onResizeEnd={resizable ? endResize : undefined}
        />,
      );
    }
  });

  return (
    <div ref={containerRef} className={`panel-split panel-split--${node.axis}`}>
      {elements}
    </div>
  );
}

export function PanelTreeRenderer({
  node,
  onNavigate,
  onSelectSession,
  empty = <div className="panel-empty">empty panel</div>,
}: Props) {
  if (node.kind === "widget") {
    const item = renderLeaf(node, 0, onNavigate, onSelectSession);
    return <>{item.render(true)}</>;
  }

  if (node.kind === "split") {
    return (
      <ResizableSplit node={node} onNavigate={onNavigate} onSelectSession={onSelectSession} empty={empty} />
    );
  }

  if (node.kind === "grid") {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: Array.isArray(node.templateColumns) && node.templateColumns.length > 0
            ? node.templateColumns.join(" ")
            : `repeat(${Math.max(1, node.columns)}, minmax(0, 1fr))`,
          gridTemplateRows: Array.isArray(node.templateRows) && node.templateRows.length > 0
            ? node.templateRows.join(" ")
            : undefined,
          gridAutoRows: Array.isArray(node.templateRows) && node.templateRows.length > 0
            ? undefined
            : "minmax(0, 1fr)",
          gap: `${node.gap ?? 12}px`,
          minHeight: 0,
          height: "100%",
          flex: 1,
        }}
      >
        {node.children.map((child, index) => (
          <div
            key={child.id ?? `${child.kind}-${index}`}
            style={{
              minHeight: 0,
              gridColumn:
                (child.kind === "tabs" || child.kind === "list") && child.columnSpan
                  ? `span ${child.columnSpan}`
                  : undefined,
              gridRow:
                (child.kind === "tabs" || child.kind === "list") && child.rowSpan
                  ? `span ${child.rowSpan}`
                  : undefined,
            }}
          >
            <PanelTreeRenderer
              node={child}
              onNavigate={onNavigate}
              onSelectSession={onSelectSession}
              empty={empty}
            />
          </div>
        ))}
      </div>
    );
  }

  if (node.kind === "scope") {
    const child = node.children.length === 1 ? (
      <PanelTreeRenderer
        node={node.children[0]}
        onNavigate={onNavigate}
        onSelectSession={onSelectSession}
        empty={empty}
      />
    ) : (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%" }}>
        {node.children.map((child, i) => (
          <PanelTreeRenderer
            key={child.id ?? `${child.kind}-${i}`}
            node={child}
            onNavigate={onNavigate}
            onSelectSession={onSelectSession}
            empty={empty}
          />
        ))}
      </div>
    );

    return (
      <ScopeProvider
        context={node.context}
        onNavigate={onNavigate as unknown as (view: string) => void}
        onSelectSession={onSelectSession}
      >
        <ScopeSessionWatcher />
        {node.bindUrlSession && <ScopeUrlSessionBinder />}
        {child}
      </ScopeProvider>
    );
  }

  if (node.editable) {
    return (
      <EditablePanel
        node={node}
        onNavigate={onNavigate}
        onSelectSession={onSelectSession}
        empty={empty}
      />
    );
  }

  const items = node.children.map((child, index) =>
    renderLeaf(child, index, onNavigate, onSelectSession),
  );

  return (
    <div
      style={{
        minHeight: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
      }}
    >
      <div style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
        <PanelSurface
          mode={node.kind}
          items={items}
          empty={empty}
          surfaceClassName="right-panel-content"
          headerClassName="right-panel-tabs-bar"
          bodyClassName="right-panel-body"
          contentClassName="right-panel-content"
          tabsClassName="rp-tabs"
          tabClassName="rp-tab"
          tabActiveClassName="rp-tab--active"
          tabIconOnlyClassName="rp-tab--icon-only"
          tabLabelClassName="rp-tab-label"
          tabCloseClassName="rp-tab-close"
        />
      </div>
    </div>
  );
}

// ── Editable Panel ──
// Renders tabs/list with a WidgetPicker to add/remove widgets at runtime.
// Initial children from the layout config seed the widget list; runtime
// additions are managed in local state.
//
// When `target: true`, this panel also listens for events on the scope bus
// (e.g. "open-move" for move widgets, "open-file" for file viewer, "focus-tab"
// for tab switching) and dynamically adds/removes tabs in response.

type EditablePanelNode = Extract<LayoutNode, { kind: "tabs" }> | Extract<LayoutNode, { kind: "list" }>;

type DynamicMoveTab = {
  id: string;
  label: string;
  widget: MoveWidgetInfo;
  apiToken: string;
  instanceId: string;
  sessionId: string;
  mountedOnAttach?: boolean;
  reloadKey: number;
};

function panelStorageKey(node: EditablePanelNode): string {
  const id = node.id ?? node.children.map(l => l.widget.id ?? l.widget.type).join(",");
  return `harness:editable-panel:${id}`;
}

function loadPanelWidgets(node: EditablePanelNode): WidgetBase[] {
  const defaults = node.children.map(l => l.widget);
  try {
    const raw = localStorage.getItem(panelStorageKey(node));
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as WidgetBase[];
    if (!Array.isArray(saved) || saved.length === 0) return defaults;
    return saved;
  } catch {
    return defaults;
  }
}

function savePanelWidgets(node: EditablePanelNode, widgets: WidgetBase[]) {
  try {
    localStorage.setItem(panelStorageKey(node), JSON.stringify(widgets));
  } catch {}
}

function EditablePanel({
  node,
  onNavigate,
  onSelectSession,
  empty,
}: {
  node: EditablePanelNode;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  empty: ReactNode;
}) {
  const [widgets, setWidgetsRaw] = useState<WidgetBase[]>(() => loadPanelWidgets(node));
  const setWidgets = useCallback((next: WidgetBase[] | ((prev: WidgetBase[]) => WidgetBase[])) => {
    setWidgetsRaw(prev => {
      const resolved = typeof next === "function" ? next(prev) : next;
      savePanelWidgets(node, resolved);
      return resolved;
    });
  }, [node]);
  const [mode, setMode] = useState<"list" | "tabs">(node.kind);
  const [dynamicTabs, setDynamicTabs] = useState<DynamicMoveTab[]>([]);
  const [requestActiveId, setRequestActiveId] = useState<string | null>(null);
  const clearRequestActive = useCallback(() => setRequestActiveId(null), []);

  const bus = useScopeBus();
  const dynamicTabsRef = useRef(dynamicTabs);
  dynamicTabsRef.current = dynamicTabs;
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;

  // ── File-open → focus code-editor tab ──
  // When a file is opened (e.g. via a file reference click in chat markdown),
  // if this panel contains a code-editor widget that isn't the active tab,
  // bring it to the front. Also emit expand-target in case a parent split
  // has this panel's branch collapsed.
  const { subscribeFileOpens } = useFileViewer();
  useEffect(() => {
    return subscribeFileOpens(() => {
      const valid = widgetsRef.current.filter((w) => WIDGETS[w.type]);
      const editorIndex = valid.findIndex((w) => w.type === "code-editor");
      if (editorIndex === -1) return;
      const editor = valid[editorIndex];
      const editorId = editor.id ?? `${editor.type}-${editorIndex}`;
      setRequestActiveId(editorId);
      bus?.emit({ type: "expand-target" });
    });
  }, [subscribeFileOpens, bus]);

  // Track scope session for direct widget fetching
  const scopeState = useSyncExternalStore(
    bus ? bus.subscribe : () => () => {},
    bus ? bus.getSnapshot : () => emptySnapshot,
  );
  const scopeSessionId = scopeState.sessionId as string | undefined | null;

  // Listen for target events when this panel is a target
  useEffect(() => {
    if (!node.target || !bus) return;

    const unsubs: (() => void)[] = [];

    unsubs.push(bus.on("open-move", (event: ScopeEvent) => {
      const id = event.id as string;
      const label = event.label as string;
      const widget = event.widget as MoveWidgetInfo;
      const apiToken = event.apiToken as string;
      const instanceId = event.instanceId as string;
      const sessionId = event.sessionId as string;
      const mountedOnAttach = event.mountedOnAttach as boolean | undefined;

      const exists = dynamicTabsRef.current.some(t => t.id === id);
      if (!exists) {
        setDynamicTabs(prev => prev.some(t => t.id === id) ? prev : [...prev, { id, label, widget, apiToken, instanceId, sessionId, mountedOnAttach, reloadKey: 0 }]);
        bus.emit({ type: "expand-target" });
      }
      setRequestActiveId(id);
    }));

    unsubs.push(bus.on("close-move", (event: ScopeEvent) => {
      const id = event.id as string;
      setDynamicTabs(prev => prev.filter(t => t.id !== id));
    }));

    unsubs.push(bus.on("focus-tab", (event: ScopeEvent) => {
      setRequestActiveId(event.tabId as string);
    }));

    return () => unsubs.forEach(fn => fn());
  }, [node.target, bus]);

  // Self-fetch active widgets directly. Independent of ScopeSessionWatcher's
  // bus emit so the panel self-heals when it mounts after the event already
  // fired (e.g. it was previously collapsed and is just being expanded).
  useEffect(() => {
    if (!node.target || !scopeSessionId) return;
    // Cancellation guard — a fast session switch can land a stale fetch's
    // resolution onto the new session's tab list. Drop it.
    let cancelled = false;
    const fetchSessionId = scopeSessionId;

    const fetchWidgets = async () => {
      const widgets = await modus.getActiveWidgets(fetchSessionId).catch(() => []);
      if (cancelled) return;
      const currentIds = new Set(dynamicTabsRef.current.map(t => t.instanceId));
      const additions: DynamicMoveTab[] = widgets
        .filter(w => !currentIds.has(w.instanceId))
        .map(w => ({
          id: `widget:${w.instanceId}`,
          label: w.widget.label,
          widget: w.widget,
          apiToken: w.apiToken,
          instanceId: w.instanceId,
          sessionId: fetchSessionId,
          mountedOnAttach: w.widget.mountOnAttach ?? false,
          reloadKey: 0,
        }));
      if (additions.length === 0) return;
      setDynamicTabs(prev => {
        const have = new Set(prev.map(t => t.instanceId));
        const fresh = additions.filter(a => !have.has(a.instanceId));
        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
      setRequestActiveId(additions[additions.length - 1].id);
      bus?.emit({ type: "expand-target" });
    };

    fetchWidgets();
    const handler = () => fetchWidgets();
    window.addEventListener("modus:widgets-changed", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("modus:widgets-changed", handler);
    };
  }, [node.target, scopeSessionId, bus]);

  // Clear dynamic tabs when the scope's session changes
  const prevScopeSession = useRef(scopeSessionId);
  useEffect(() => {
    if (prevScopeSession.current !== scopeSessionId) {
      prevScopeSession.current = scopeSessionId;
      setDynamicTabs([]);
    }
  }, [scopeSessionId]);

  const validWidgets = widgets.filter((w) => WIDGETS[w.type]);

  const staticItems: PanelSurfaceItem[] = validWidgets.map((widget, index) => {
    const widgetId = widget.id ?? `${widget.type}-${index}`;
    const widgetDef = WIDGET_DEFS[widget.type];

    // Find matching leaf from config to get publish/subscribe mappings
    const configLeaf = node.children.find((l) => l.widget.type === widget.type && (l.widget.id ?? "") === (widget.id ?? ""));

    return {
      id: widgetId,
      label: widget.title ?? widget.type,
      title: widget.title ?? widget.type,
      icon: widgetIcon(widget.type) ?? undefined,
      minHeight: widgetDef?.minHeight,
      maxHeight: widgetDef?.maxHeight,
      preferredHeight: widgetDef?.preferredHeight,
      defaultCollapsed: widget.collapsed ?? false,
      render: (active) => (
        <EditablePanelWidget
          widget={widget}
          widgetId={widgetId}
          active={active}
          publish={configLeaf?.publish}
          subscribe={configLeaf?.subscribe}
          canNavigate={configLeaf?.canNavigate}
          onNavigate={onNavigate}
          onSelectSession={onSelectSession}
        />
      ),
    };
  });

  const dynamicItems: PanelSurfaceItem[] = dynamicTabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    title: tab.label,
    onReload: () => {
      evictWidgetModule(tab.widget.moduleUrl);
      setDynamicTabs(prev => prev.map(t =>
        t.id === tab.id ? { ...t, reloadKey: t.reloadKey + 1 } : t,
      ));
    },
    onClose: () => {
      setDynamicTabs(prev => prev.filter(t => t.id !== tab.id));
      modus.detachMove(tab.widget.moveName, tab.apiToken).catch(() => {});
    },
    render: () => (
      <MoveWidget
        key={`${tab.instanceId}-${tab.reloadKey}`}
        widget={tab.widget}
        apiToken={tab.apiToken}
        instanceId={tab.instanceId}
        sessionId={tab.sessionId}
        mountedOnAttach={tab.mountedOnAttach}
      />
    ),
  }));

  const items = [...staticItems, ...dynamicItems];

  const picker = (
    <div className="left-panel-picker">
      <WidgetPicker
        zone="right-panel"
        current={validWidgets}
        onChange={setWidgets}
        mode={mode}
        onModeChange={setMode}
      />
    </div>
  );

  return (
    <div
      style={{
        minHeight: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
      }}
    >
      <div style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
        <PanelSurface
          mode={mode}
          items={items}
          picker={picker}
          empty={empty}
          requestActiveId={requestActiveId}
          onRequestActiveHandled={clearRequestActive}
          surfaceClassName="right-panel-content"
          headerClassName="right-panel-tabs-bar"
          bodyClassName="right-panel-body"
          contentClassName="right-panel-content"
          tabsClassName="rp-tabs"
          tabClassName="rp-tab"
          tabActiveClassName="rp-tab--active"
          tabIconOnlyClassName="rp-tab--icon-only"
          tabLabelClassName="rp-tab-label"
          tabCloseClassName="rp-tab-close"
        />
      </div>
    </div>
  );
}

/** Widget rendered inside an editable panel — hooks into page context. */
function EditablePanelWidget({
  widget,
  widgetId,
  active,
  publish,
  subscribe,
  canNavigate,
  onNavigate,
  onSelectSession,
}: {
  widget: WidgetBase;
  widgetId: string;
  active: boolean;
  publish?: Record<string, string>;
  subscribe?: Record<string, string>;
  canNavigate?: boolean;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
}) {
  const pageContext = usePageContext(publish, subscribe, canNavigate);
  const Component = WIDGETS[widget.type];
  if (!Component) return null;

  return (
    <Component
      config={widget}
      widgetId={widgetId}
      active={active}
      onNavigate={onNavigate}
      onSelectSession={onSelectSession}
      pageContext={pageContext}
    />
  );
}
