import { type ReactNode } from "react";
import { WIDGETS, type WidgetBase, type WidgetProps } from "../widgets";
import type { View } from "../views";

type Props = {
  open: boolean;
  width: number;
  onOpen: () => void;
  onClose: () => void;
  widgets?: WidgetBase[];
  onNavigate?: (view: View) => void;
  onSelectSession?: (id: string) => void;
  children?: ReactNode;
};

export function LeftPanel({ open, width, onOpen, onClose, widgets, onNavigate, onSelectSession, children }: Props) {
  const renderedWidgets = (widgets ?? []).map((w, i) => {
    const Component = WIDGETS[w.type];
    if (!Component) return null;
    const widgetId = w.id ?? `left-${w.type}-${i}`;
    const props: WidgetProps = {
      config: w,
      widgetId,
      onNavigate: onNavigate ?? (() => {}),
      onSelectSession: onSelectSession ?? (() => {}),
    };
    return <Component key={widgetId} {...props} />;
  }).filter(Boolean);

  return (
    <div
      className={`left-panel${open ? " open" : ""}`}
      style={open ? { width, minWidth: width } : undefined}
    >
      <div className="left-panel-header">
        <span className="left-panel-title">widgets</span>
      </div>
      <div className="left-panel-content">
        {renderedWidgets.length > 0 ? renderedWidgets : (
          children || <div className="panel-empty">no widgets pinned</div>
        )}
      </div>
    </div>
  );
}
