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
    <>
      <div
        className={`left-panel${open ? " open" : ""}`}
        style={open ? { width, minWidth: width } : undefined}
      >
        <div className="left-panel-header">
          <span className="left-panel-title">widgets</span>
          <button
            className="left-panel-close"
            onClick={onClose}
            title="Collapse panel"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M7 2L3 6l4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
        <div className="left-panel-content">
          {renderedWidgets.length > 0 ? renderedWidgets : (
            children || <div className="panel-empty">no widgets pinned</div>
          )}
        </div>
      </div>
      {!open && (
        <button
          className="panel-tab panel-tab--left"
          onClick={onOpen}
          title="Open widgets panel"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M4 2l4 3.5L4 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
    </>
  );
}
