import { useCallback, useRef, useState, type ReactNode } from "react";
import type { View } from "../views";
import { WIDGET_DEFS, type LayoutLeaf, type LayoutNode } from "../widgets";
import { PanelSurface, type PanelSurfaceItem } from "./PanelSurface";
import { usePageContext } from "./PageRenderer";

type Props = {
  node: LayoutNode;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  empty?: ReactNode;
};

function getLeafId(leaf: LayoutLeaf, index: number): string {
  return leaf.id?.trim() || leaf.widget.id?.trim() || `${leaf.widget.type}-${index + 1}`;
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
  const def = WIDGET_DEFS[leaf.widget.type];
  const pageContext = usePageContext(leaf.publish, leaf.subscribe);
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

function renderLeaf(
  leaf: LayoutLeaf,
  index: number,
  onNavigate: (view: View) => void,
  onSelectSession: (id: string) => void,
): PanelSurfaceItem {
  const widgetId = getLeafId(leaf, index);
  const def = WIDGET_DEFS[leaf.widget.type];

  return {
    id: widgetId,
    label: leaf.widget.title ?? leaf.widget.type,
    title: leaf.widget.title ?? leaf.widget.type,
    minHeight: def?.minHeight,
    maxHeight: def?.maxHeight,
    preferredHeight: def?.preferredHeight,
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
  const defaultSizes = node.children.map((_, i) => node.sizes?.[i] ?? 1);
  const [sizes, setSizes] = useState(defaultSizes);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ index: number; startPos: number; startSizes: number[] } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent, index: number) => {
    e.preventDefault();
    const pos = node.axis === "horizontal" ? e.clientX : e.clientY;
    dragging.current = { index, startPos: pos, startSizes: [...sizes] };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
  }, [sizes, node.axis]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const { index, startPos, startSizes } = dragging.current;
    const rect = containerRef.current.getBoundingClientRect();
    const totalPx = node.axis === "horizontal" ? rect.width : rect.height;
    const pos = node.axis === "horizontal" ? e.clientX : e.clientY;
    const deltaPx = pos - startPos;
    const totalFlex = startSizes.reduce((a, b) => a + b, 0);
    const deltaFlex = (deltaPx / totalPx) * totalFlex;

    const newSizes = [...startSizes];
    const minFlex = 0.05 * totalFlex;
    newSizes[index] = Math.max(minFlex, startSizes[index] + deltaFlex);
    newSizes[index + 1] = Math.max(minFlex, startSizes[index + 1] - deltaFlex);
    setSizes(newSizes);
  }, [node.axis]);

  const onPointerUp = useCallback(() => {
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
    if (index > 0) {
      elements.push(
        <div
          key={`handle-${index}`}
          className={`panel-split-handle panel-split-handle--${node.axis}`}
          onPointerDown={(e) => onPointerDown(e, index - 1)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />,
      );
    }
    const size = sizes[index] ?? 1;
    elements.push(
      <div
        key={child.id ?? `${child.kind}-${index}`}
        className="panel-split-child"
        style={{ flex: `${size} ${size} 0%` }}
      >
        <PanelTreeRenderer
          node={child}
          onNavigate={onNavigate}
          onSelectSession={onSelectSession}
          empty={empty}
        />
      </div>,
    );
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
      {/* Panel title intentionally omitted on pages — tab labels and list
         headers already identify content. Add showTitle to the node schema
         if an explicit section label is ever needed. */}
      <div style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
        <PanelSurface
          mode={node.kind}
          items={items}
          empty={empty}
          surfaceClassName="right-panel-content"
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
