import type { ReactNode } from "react";
import type { View } from "../views";
import { WIDGET_DEFS, type LayoutLeaf, type LayoutNode } from "../widgets";
import { PanelSurface, type PanelSurfaceItem } from "./PanelSurface";

type Props = {
  node: LayoutNode;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  empty?: ReactNode;
};

function getLeafId(leaf: LayoutLeaf, index: number): string {
  return leaf.id?.trim() || leaf.widget.id?.trim() || `${leaf.widget.type}-${index + 1}`;
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
    render: (active) =>
      def ? (
        <def.component
          config={leaf.widget}
          widgetId={widgetId}
          active={active}
          onNavigate={onNavigate}
          onSelectSession={onSelectSession}
        />
      ) : (
        <div className="panel-empty">unknown widget: {leaf.widget.type}</div>
      ),
  };
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
    const childCount = Math.max(node.children.length, 1);
    return (
      <div className={`panel-split panel-split--${node.axis}`}>
        {node.children.map((child, index) => {
          const size = node.sizes?.[index];
          return (
            <div
              key={child.id ?? `${child.kind}-${index}`}
              className="panel-split-child"
              style={{ flex: size && size > 0 ? `${size} ${size} 0%` : `1 1 0%` }}
            >
              <PanelTreeRenderer
                node={child}
                onNavigate={onNavigate}
                onSelectSession={onSelectSession}
                empty={empty}
              />
            </div>
          );
        })}
        {node.children.length === 0 ? (
          <div className="panel-split-child" style={{ flex: `1 1 ${100 / childCount}%` }}>
            {empty}
          </div>
        ) : null}
      </div>
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
      {node.title ? (
        <div className="widget-header widget-header--static">
          <span className="widget-title">{node.title}</span>
        </div>
      ) : null}
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
