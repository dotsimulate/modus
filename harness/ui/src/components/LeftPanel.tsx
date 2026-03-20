import { type ReactNode } from "react";
import { WIDGETS, type WidgetBase, type WidgetProps } from "../widgets";
import { useWidgetUiState } from "../widgets/ui-state";
import { useProfiles } from "../providers/ProfileProvider";
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

const chevron = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
);

function CollapsibleWidget({ widget, widgetId, onNavigate, onSelectSession }: {
  widget: WidgetBase;
  widgetId: string;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
}) {
  const Component = WIDGETS[widget.type];
  if (!Component) return null;

  const { activeUserProfile } = useProfiles();
  const [collapsed, setCollapsed] = useWidgetUiState(
    { userProfile: activeUserProfile },
    widgetId,
    "collapsed",
    widget.collapsed ?? false,
  );

  return (
    <div className="widget">
      <button className="widget-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="widget-title">{widget.title ?? widget.type}</span>
        <span className={`widget-chevron ${collapsed ? "" : "widget-chevron--open"}`}>
          {chevron}
        </span>
      </button>
      <div className={`panel-collapse ${collapsed ? "" : "panel-collapse--open"}`}>
        <div className="panel-collapse-clip">
          <Component
            config={widget}
            widgetId={widgetId}
            onNavigate={onNavigate}
            onSelectSession={onSelectSession}
          />
        </div>
      </div>
    </div>
  );
}

export function LeftPanel({ open, width, onOpen, onClose, widgets, onNavigate, onSelectSession, children }: Props) {
  const validWidgets = (widgets ?? []).filter((w) => WIDGETS[w.type]);

  return (
    <div
      className={`left-panel${open ? " open" : ""}`}
      style={open ? { width, minWidth: width } : undefined}
    >
      <div className="left-panel-header">
        <span className="left-panel-title">widgets</span>
      </div>
      <div className="left-panel-content">
        {validWidgets.length > 0 ? validWidgets.map((w, i) => {
          const widgetId = w.id ?? `left-${w.type}-${i}`;
          return (
            <CollapsibleWidget
              key={widgetId}
              widget={w}
              widgetId={widgetId}
              onNavigate={onNavigate ?? (() => {})}
              onSelectSession={onSelectSession ?? (() => {})}
            />
          );
        }) : (
          children || <div className="panel-empty">no widgets pinned</div>
        )}
      </div>
    </div>
  );
}
