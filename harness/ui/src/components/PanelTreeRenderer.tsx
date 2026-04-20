import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { View } from "../views";
import type { MoveWidgetInfo, TerminalInfo } from "../../../sdk/index";
import { WIDGET_DEFS, WIDGETS, dispatchUiIntent, panelHandlesIntent, panelHandlesUiIntent, widgetHandlesUiIntent, type LayoutLeaf, type LayoutNode, type UiIntent, type WidgetBase } from "../widgets";
import { PanelSurface, type PanelSurfaceItem } from "./PanelSurface";
import { WidgetPicker } from "./WidgetPicker";
import { usePageContext, useLeafVisible, ScopeProvider, useScopeBus, ScopeUrlSessionBinder, ScopeSelectSessionIntentBridge } from "./pageScope";
import { MoveWidgetEmbed } from "./MoveWidgetEmbed";
import { MoveWidget, evictWidgetModule } from "./MoveWidget";
import { modus } from "../modusClient";
import { useFileViewer } from "../providers/FileViewerContext";
import { TerminalView } from "./TerminalView";

type Props = {
  node: LayoutNode;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  onActivateSession?: (id: string) => void;
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
function containsTarget(node: LayoutNode, target?: string): boolean {
  if ((node.kind === "tabs" || node.kind === "list") && node.editable && node.target) {
    return panelMatchesIntentTarget(node.id, target);
  }
  if (node.kind === "split" || node.kind === "scope") {
    return node.children.some((child) => containsTarget(child, target));
  }
  if (node.kind === "grid") {
    return (node.children ?? []).some((child) => containsTarget(child, target));
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
            dispatchUiIntent(bus, {
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

function ScopeFileOpenIntentBridge() {
  const bus = useScopeBus();
  const { subscribeFileOpens } = useFileViewer();

  useEffect(() => {
    if (!bus) return;
    return subscribeFileOpens((request) => {
      bus.emit({
        type: "open-file",
        path: request.path,
        edit: request.edit,
        line: request.line,
        endLine: request.endLine,
        highlight: request.highlight,
        source: request.source,
      });
    });
  }, [bus, subscribeFileOpens]);

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
type SplitPointerEvent = Pick<React.PointerEvent, "clientX" | "clientY">;

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
  onResizeStart?: (e: SplitPointerEvent) => void;
  onResizeMove?: (e: SplitPointerEvent) => void;
  onResizeEnd?: () => void;
}) {
  const isPressed = useRef(false);
  const didDrag = useRef(false);
  const suppressClick = useRef(false);
  const startPos = useRef(0);
  const pointerId = useRef<number | null>(null);

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

  const DRAG_THRESHOLD = 10;

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    isPressed.current = true;
    didDrag.current = false;
    startPos.current = isHorizontal ? e.clientX : e.clientY;
    pointerId.current = e.pointerId;

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId.current) return;
      if (!isPressed.current) return;
      const pos = isHorizontal ? event.clientX : event.clientY;
      const delta = Math.abs(pos - startPos.current);
      if (!didDrag.current && delta >= DRAG_THRESHOLD) {
        didDrag.current = true;
        suppressClick.current = true;
        onResizeStart?.(event);
      }
      if (didDrag.current) {
        event.preventDefault();
        onResizeMove?.(event);
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId.current) return;
      isPressed.current = false;
      pointerId.current = null;
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerUp);
      if (didDrag.current) {
        onResizeEnd?.();
      }
      didDrag.current = false;
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerUp);
  }, [isHorizontal, onResizeStart, onResizeMove, onResizeEnd]);

  const handleClick = useCallback(() => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onToggle();
  }, [onToggle]);

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
      onClick={handleClick}
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
  onActivateSession,
  empty,
}: {
  node: LayoutNode;
  flex: string;
  isCollapsed: boolean;
  isAuto: boolean;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  onActivateSession?: (id: string) => void;
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
          onActivateSession={onActivateSession}
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
  onActivateSession,
  empty,
}: {
  node: SplitNode;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  onActivateSession?: (id: string) => void;
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
    return expandBus.on("expand-target", (event) => {
      const collapsibleFlags = node.collapsible ?? [];
      setCollapsed((prev) => {
        let changed = false;
        const next = prev.map((isCollapsed, i) => {
          if (isCollapsed && collapsibleFlags[i] && containsTarget(node.children[i], event.target)) {
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
  const startResize = useCallback((e: SplitPointerEvent, handleIndex: number) => {
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

  const updateResize = useCallback((e: SplitPointerEvent) => {
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
        onActivateSession={onActivateSession}
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
  onActivateSession,
  empty = <div className="panel-empty">empty panel</div>,
}: Props) {
  if (node.kind === "widget") {
    const item = renderLeaf(node, 0, onNavigate, onSelectSession);
    return <>{item.render(true)}</>;
  }

  if (node.kind === "split") {
    return (
      <ResizableSplit node={node} onNavigate={onNavigate} onSelectSession={onSelectSession} onActivateSession={onActivateSession} empty={empty} />
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
              onActivateSession={onActivateSession}
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
        onActivateSession={onActivateSession}
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
            onActivateSession={onActivateSession}
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
        onActivateSession={onActivateSession}
      >
        <ScopeSessionWatcher />
        <ScopeFileOpenIntentBridge />
        <ScopeSelectSessionIntentBridge />
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

type DynamicTerminalTab = {
  id: string;
  label: string;
  ownerType: string;
  ownerName: string;
};

function isTerminalDiscoveryDeclaration(widget: WidgetBase): boolean {
  return (
    widget.type === "persistent-terminal"
    && ((widget as Record<string, unknown>).ownerType === "action" || (widget as Record<string, unknown>).discoverOwnerType === "action")
    && !(widget as Record<string, unknown>).ownerName
  );
}

function panelDeclaresTerminalDiscovery(widgets: WidgetBase[]): boolean {
  return widgets.some((w) => w.type === "session-terminal" || isTerminalDiscoveryDeclaration(w));
}

function panelMatchesIntentTarget(panelId: string | undefined, target?: string): boolean {
  return !target || target === panelId;
}

function editablePanelReceivesIntent(node: EditablePanelNode, intent: UiIntent): boolean {
  if (!panelMatchesIntentTarget(node.id, intent.target)) return false;
  if (panelHandlesUiIntent(node, intent)) return true;
  if (intent.type === "open-file" || intent.type === "focus-tab") return true;
  return node.target === true;
}

function editablePanelSubscribesToIntent(node: EditablePanelNode, intentType: UiIntent["type"]): boolean {
  if (intentType === "open-file" || intentType === "focus-tab") return true;
  return node.target === true || panelHandlesIntent(node, intentType);
}

function editablePanelSupportsDynamicMoves(node: EditablePanelNode): boolean {
  return node.target === true || panelHandlesIntent(node, "open-move") || panelHandlesIntent(node, "close-move");
}

function editablePanelSupportsDynamicTerminals(node: EditablePanelNode): boolean {
  return node.target === true || panelHandlesIntent(node, "open-terminal");
}

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
  const [dynamicTerminalTabs, setDynamicTerminalTabs] = useState<DynamicTerminalTab[]>([]);
  const [requestActiveId, setRequestActiveId] = useState<string | null>(null);
  const clearRequestActive = useCallback(() => setRequestActiveId(null), []);

  const bus = useScopeBus();
  const dynamicTabsRef = useRef(dynamicTabs);
  dynamicTabsRef.current = dynamicTabs;
  const dynamicTerminalTabsRef = useRef(dynamicTerminalTabs);
  dynamicTerminalTabsRef.current = dynamicTerminalTabs;
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;

  const handleIntent = useCallback((intent: UiIntent) => {
    if (!editablePanelReceivesIntent(node, intent)) return;

    switch (intent.type) {
      case "open-file": {
        const valid = widgetsRef.current.filter((w) => WIDGETS[w.type]);
        const editorIndex = valid.findIndex((w) => widgetHandlesUiIntent(w, WIDGET_DEFS[w.type], intent));
        if (editorIndex === -1) return;
        const editor = valid[editorIndex];
        const editorId = editor.id ?? `${editor.type}-${editorIndex}`;
        setRequestActiveId(editorId);
        dispatchUiIntent(bus, { type: "expand-target", target: intent.target });
        return;
      }

      case "focus-tab":
        setRequestActiveId(intent.tabId);
        return;

      case "focus-widget": {
        const valid = widgetsRef.current.filter((w) => WIDGETS[w.type] && !isTerminalDiscoveryDeclaration(w));
        let index = -1;
        if (intent.widgetId) {
          index = valid.findIndex((w, i) => (w.id ?? `${w.type}-${i}`) === intent.widgetId);
        }
        if (index === -1 && intent.widgetType) {
          index = valid.findIndex((w) => w.type === intent.widgetType && widgetHandlesUiIntent(w, WIDGET_DEFS[w.type], intent));
        }
        if (index === -1) return;
        const widget = valid[index];
        setRequestActiveId(widget.id ?? `${widget.type}-${index}`);
        dispatchUiIntent(bus, { type: "expand-target", target: intent.target });
        return;
      }

      case "open-move": {
        const { id, label, widget, apiToken, instanceId, sessionId, mountedOnAttach } = intent;
        const exists = dynamicTabsRef.current.some(t => t.id === id);
        if (!exists) {
          setDynamicTabs(prev => prev.some(t => t.id === id) ? prev : [...prev, { id, label, widget, apiToken, instanceId, sessionId, mountedOnAttach, reloadKey: 0 }]);
          dispatchUiIntent(bus, { type: "expand-target" });
        }
        setRequestActiveId(id);
        return;
      }

      case "close-move":
        setDynamicTabs(prev => prev.filter(t => t.id !== intent.id));
        return;

      case "open-terminal": {
        if (!panelDeclaresTerminalDiscovery(widgetsRef.current)) return;
        const { ownerType, ownerName } = intent;
        const id = `terminal:${ownerType}:${ownerName}`;
        const label = intent.label ?? ownerName;
        const exists = dynamicTerminalTabsRef.current.some(t => t.id === id);
        if (!exists) {
          setDynamicTerminalTabs(prev => prev.some(t => t.id === id) ? prev : [...prev, { id, label, ownerType, ownerName }]);
          dispatchUiIntent(bus, { type: "expand-target" });
        }
        setRequestActiveId(id);
        return;
      }
    }
  }, [bus, node]);

  // ── open-file intent → focus declared file surface ──
  useEffect(() => {
    if (!bus) return;
    return bus.on("open-file", handleIntent);
  }, [bus, handleIntent]);

  // Track scope session for direct widget fetching
  const scopeState = useSyncExternalStore(
    bus ? bus.subscribe : () => () => {},
    bus ? bus.getSnapshot : () => emptySnapshot,
  );
  const scopeSessionId = scopeState.sessionId as string | undefined | null;

  // Any editable panel listens for focus-tab so widgets can switch tabs
  useEffect(() => {
    if (!bus) return;
    return bus.on("focus-tab", handleIntent);
  }, [bus, handleIntent]);

  // Listen for target events when this panel is a target
  useEffect(() => {
    if (!bus) return;

    const unsubs: (() => void)[] = [];
    if (editablePanelSubscribesToIntent(node, "open-move")) {
      unsubs.push(bus.on("open-move", handleIntent));
    }
    if (editablePanelSubscribesToIntent(node, "close-move")) {
      unsubs.push(bus.on("close-move", handleIntent));
    }
    if (editablePanelSubscribesToIntent(node, "open-terminal")) {
      unsubs.push(bus.on("open-terminal", handleIntent));
    }
    if (editablePanelSubscribesToIntent(node, "focus-widget")) {
      unsubs.push(bus.on("focus-widget", handleIntent));
    }

    return () => unsubs.forEach(fn => fn());
  }, [node, bus, handleIntent]);

  // Action terminals are owner-bound rather than session-bound. Surface them
  // in editable target panels so action pages can focus their terminal output
  // without relying on the app-level RightPanel special case.
  useEffect(() => {
    if (!editablePanelSupportsDynamicTerminals(node) || !bus) return;
    let active = true;
    const poll = async () => {
      if (!panelDeclaresTerminalDiscovery(widgetsRef.current)) return;
      const terms = await modus.listTerminals({ ownerType: "action" }).catch(() => [] as TerminalInfo[]);
      if (!active) return;
      const seen = new Set(dynamicTerminalTabsRef.current.map(t => t.ownerName));
      const additions: DynamicTerminalTab[] = [];
      for (const term of terms) {
        if (!term.ownerName || seen.has(term.ownerName)) continue;
        seen.add(term.ownerName);
        additions.push({
          id: `terminal:action:${term.ownerName}`,
          label: term.ownerName,
          ownerType: "action",
          ownerName: term.ownerName,
        });
      }
      if (additions.length === 0) return;
      setDynamicTerminalTabs(prev => {
        const have = new Set(prev.map(t => t.id));
        const fresh = additions.filter(t => !have.has(t.id));
        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
      setRequestActiveId(additions[additions.length - 1].id);
      dispatchUiIntent(bus, { type: "expand-target" });
    };
    poll();
    const interval = window.setInterval(poll, 3000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [node, bus]);

  // Self-fetch active widgets directly. Independent of ScopeSessionWatcher's
  // bus emit so the panel self-heals when it mounts after the event already
  // fired (e.g. it was previously collapsed and is just being expanded).
  useEffect(() => {
    if (!editablePanelSupportsDynamicMoves(node) || !scopeSessionId) return;
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
      dispatchUiIntent(bus, { type: "expand-target" });
    };

    fetchWidgets();
    const handler = () => fetchWidgets();
    window.addEventListener("modus:widgets-changed", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("modus:widgets-changed", handler);
    };
  }, [node, scopeSessionId, bus]);

  // Clear dynamic tabs when the scope's session changes
  const prevScopeSession = useRef(scopeSessionId);
  useEffect(() => {
    if (prevScopeSession.current !== scopeSessionId) {
      prevScopeSession.current = scopeSessionId;
      setDynamicTabs([]);
    }
  }, [scopeSessionId]);

  const validWidgets = widgets.filter((w) => WIDGETS[w.type]);
  const renderableWidgets = validWidgets.filter((w) => !isTerminalDiscoveryDeclaration(w));

  const staticItems: PanelSurfaceItem[] = renderableWidgets.map((widget, index) => {
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

  const dynamicTerminalItems: PanelSurfaceItem[] = dynamicTerminalTabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    title: `${tab.label} terminal`,
    icon: widgetIcon("session-terminal") ?? undefined,
    onClose: () => {
      setDynamicTerminalTabs(prev => prev.filter(t => t.id !== tab.id));
    },
    render: (active) => (
      <TerminalView
        visible={active}
        ownerType={tab.ownerType}
        ownerName={tab.ownerName}
      />
    ),
  }));

  const items = [...staticItems, ...dynamicItems, ...dynamicTerminalItems];

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
