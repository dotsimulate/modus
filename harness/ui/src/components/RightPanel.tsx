import { useEffect, type ReactNode } from "react";
import type { MoveWidgetInfo, Message } from "../../../sdk/index";
import { WIDGET_DEFS, WIDGETS, type LayoutNode, type WidgetBase } from "../widgets";
import { WidgetPicker } from "./WidgetPicker";
import { MoveWidget } from "./MoveWidget";
import { RightPanelContextProvider } from "./RightPanelContext";
import { PanelSurface, type PanelSurfaceItem } from "./PanelSurface";

type Props = {
  open: boolean;
  width: number;
  onOpen: () => void;
  onClose: () => void;
  children?: ReactNode;
  mode?: "list" | "tabs";
  widgets?: WidgetBase[];
  tree?: LayoutNode;
  onWidgetsChange?: (widgets: WidgetBase[]) => void;
  onModeChange?: (mode: "list" | "tabs") => void;
  moveWidgets?: Array<{
    widget: MoveWidgetInfo;
    apiToken: string;
    instanceId: string;
    sessionId: string;
    mountedOnAttach?: boolean;
  }> | null;
  initialBrowserPath?: string | null;
  onBrowserPathChange?: (path: string | null) => void;
  messages?: Message[];
  requestView?: string | null;
  onRequestViewHandled?: () => void;
  onWidgetClose?: (apiToken: string, moveName: string) => void;
  onSendToAgent?: (text: string) => void;
  sessionId?: string | null;
};

const REQUEST_VIEW_TO_WIDGET: Record<string, string> = {
  "session-edits": "session-edits",
  activity: "agent-activity",
  terminal: "session-terminal",
};

function labelFor(widget: WidgetBase): string {
  return widget.title ?? widget.type.replace(/-/g, " ");
}

function getRightWidgetId(widget: WidgetBase): string {
  return widget.id ?? `right-${widget.type}`;
}

function iconFor(widgetType: string) {
  if (widgetType === "code-editor") {
    return (
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
        <path d="M4.5 3.5L2 6l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M7.5 3.5L10 6l-2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (widgetType === "agent-activity") {
    return (
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
        <path d="M1 6h2l1.5-3 2 6L8.5 3 10 6h1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (widgetType === "session-edits") {
    return (
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
        <rect x="1" y="1" width="10" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.1"/>
        <rect x="1" y="5.5" width="10" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.1"/>
      </svg>
    );
  }
  if (widgetType === "session-terminal") {
    return (
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
        <path d="M2 3l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M7 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    );
  }
  return null;
}

export function RightPanel({
  open,
  width,
  onOpen,
  onClose: _onClose,
  children,
  mode = "tabs",
  widgets,
  tree,
  onWidgetsChange,
  onModeChange,
  moveWidgets,
  initialBrowserPath,
  onBrowserPathChange,
  messages,
  requestView,
  onRequestViewHandled,
  onWidgetClose,
  onSendToAgent: _onSendToAgent,
  sessionId,
}: Props) {
  void tree;
  const validWidgets = (widgets ?? []).filter((w) => WIDGETS[w.type]);
  useEffect(() => {
    if (!requestView) return;
    const widgetType = REQUEST_VIEW_TO_WIDGET[requestView];
    if (!widgetType) {
      onRequestViewHandled?.();
      return;
    }
    const target = validWidgets.find((w) => w.type === widgetType);
    if (target) onOpen();
    onRequestViewHandled?.();
  }, [onOpen, onRequestViewHandled, requestView, validWidgets]);

  const rightPanelContext = {
    messages: messages ?? [],
    sessionId: sessionId ?? null,
    browserPath: initialBrowserPath ?? null,
    activeWidgetId: null,
    setBrowserPath: (path: string | null) => onBrowserPathChange?.(path),
    requestOpen: onOpen,
  };

  const items: PanelSurfaceItem[] = [
    ...validWidgets.map((widget) => {
      const widgetId = getRightWidgetId(widget);
      const Component = WIDGETS[widget.type];
      const widgetDef = WIDGET_DEFS[widget.type];
      return {
        id: widgetId,
        label: labelFor(widget),
        title: labelFor(widget),
        icon: iconFor(widget.type) ?? undefined,
        minHeight: widgetDef?.minHeight,
        maxHeight: widgetDef?.maxHeight,
        preferredHeight: widgetDef?.preferredHeight,
        defaultCollapsed: widget.collapsed ?? false,
        render: (active: boolean) => (
          <Component
            config={widget}
            widgetId={widgetId}
            active={active}
            onNavigate={() => {}}
            onSelectSession={() => {}}
          />
        ),
      };
    }),
    ...(moveWidgets ?? []).map((moveWidget) => ({
      id: `widget:${moveWidget.instanceId}`,
      label: moveWidget.widget.label,
      title: moveWidget.widget.label,
      onClose: () => onWidgetClose?.(moveWidget.apiToken, moveWidget.widget.moveName),
      render: () => (
        <MoveWidget
          widget={moveWidget.widget}
          apiToken={moveWidget.apiToken}
          instanceId={moveWidget.instanceId}
          sessionId={moveWidget.sessionId}
          mountedOnAttach={moveWidget.mountedOnAttach}
        />
      ),
    })),
  ];

  const picker = onWidgetsChange ? (
    <div className="right-panel-picker">
      <WidgetPicker
        zone="right-panel"
        current={validWidgets}
        onChange={onWidgetsChange}
        mode={mode}
        onModeChange={onModeChange}
      />
    </div>
  ) : undefined;

  return (
    <RightPanelContextProvider value={rightPanelContext}>
      <div
        className={`right-panel${open ? " open" : ""}`}
        style={open ? { width, minWidth: width } : undefined}
      >
        <PanelSurface
          mode={mode}
          items={items}
          picker={picker}
          empty={children || <div className="panel-empty">no widgets pinned</div>}
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
    </RightPanelContextProvider>
  );
}
