import { Activity, type ReactNode } from "react";
import { WIDGET_DEFS, WIDGETS, type LayoutNode, type WidgetBase } from "../widgets";
import { WidgetPicker } from "./WidgetPicker";
import { PanelSurface, type PanelSurfaceItem } from "./PanelSurface";
import type { View } from "../views";

type Props = {
  open: boolean;
  width: number;
  onOpen: () => void;
  onClose: () => void;
  mode?: "list" | "tabs";
  widgets?: WidgetBase[];
  tree?: LayoutNode;
  onWidgetsChange?: (widgets: WidgetBase[]) => void;
  onModeChange?: (mode: "list" | "tabs") => void;
  onNavigate?: (view: View) => void;
  onSelectSession?: (id: string) => void;
  children?: ReactNode;
};

function getLeftWidgetId(widget: WidgetBase): string {
  return widget.id ?? `left-${widget.type}`;
}

export function LeftPanel({ open, width, onOpen: _onOpen, onClose: _onClose, mode = "list", widgets, tree: _tree, onWidgetsChange, onModeChange, onNavigate, onSelectSession, children }: Props) {
  const validWidgets = (widgets ?? []).filter((w) => WIDGETS[w.type]);
  const items: PanelSurfaceItem[] = validWidgets.map((widget) => {
    const widgetId = getLeftWidgetId(widget);
    const Component = WIDGETS[widget.type];
    const widgetDef = WIDGET_DEFS[widget.type];
    return {
      id: widgetId,
      label: widget.title ?? widget.type,
      title: widget.title ?? widget.type,
      minHeight: widgetDef?.minHeight,
      maxHeight: widgetDef?.maxHeight,
      preferredHeight: widgetDef?.preferredHeight,
      defaultCollapsed: widget.collapsed ?? false,
      render: (active) => (
        <Component
          config={widget}
          widgetId={widgetId}
          active={active}
          onNavigate={onNavigate ?? (() => {})}
          onSelectSession={onSelectSession ?? (() => {})}
        />
      ),
    };
  });

  const picker = onWidgetsChange ? (
    <div className="left-panel-picker">
      <WidgetPicker
        zone="left-panel"
        current={validWidgets}
        onChange={onWidgetsChange}
        mode={mode}
        onModeChange={onModeChange}
      />
    </div>
  ) : undefined;

  return (
    <div
      className={`left-panel${open ? " open" : ""}`}
      style={open ? { width, minWidth: width } : undefined}
    >
      <Activity mode={open ? "visible" : "hidden"} name="left-panel">
        <PanelSurface
          mode={mode}
          items={items}
          picker={picker}
          empty={children || <div className="panel-empty">no widgets pinned</div>}
          surfaceClassName="left-panel-content"
          tabsClassName="lp-tabs"
          tabClassName="lp-tab"
          tabActiveClassName="lp-tab--active"
          tabLabelClassName="lp-tab-label"
          tabCloseClassName="lp-tab-close"
        />
      </Activity>
    </div>
  );
}
