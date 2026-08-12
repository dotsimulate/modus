import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MoveWidgetInfo, Message, TerminalInfo } from "../../../sdk/index";
import { WIDGET_DEFS, WIDGETS, type LayoutNode, type WidgetBase } from "../widgets";
import { WidgetPicker } from "./WidgetPicker";
import { MoveWidget, evictWidgetModule } from "./MoveWidget";
import { RightPanelContextProvider } from "./RightPanelContext";
import { PanelSurface, type PanelSurfaceItem } from "./PanelSurface";
import { TerminalView } from "./TerminalView";
import { modus } from "../modusClient";

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
  /** Navigate to a session. Widgets in this panel receive it as onSelectSession. */
  onSelectSession?: (id: string) => void;
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
  if (widgetType === "session-history") {
    // Mirrors the sort icon used inside the widget itself — three stepped
    // lines (descending) read as "ordered history". Kept in sync with
    // PanelTreeRenderer.widgetIcon().
    return (
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
        <path d="M2 3h8M3 6h6M4 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
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
  onSelectSession,
  sessionId,
}: Props) {
  void tree;
  const validWidgets = (widgets ?? []).filter((w) => WIDGETS[w.type]);
  const [requestActiveId, setRequestActiveId] = useState<string | null>(null);
  const clearRequestActive = useCallback(() => setRequestActiveId(null), []);
  const [widgetReloadKeys, setWidgetReloadKeys] = useState<Record<string, number>>({});
  const prevMoveWidgetIdsRef = useRef<Set<string>>(new Set());

  // ── Action terminal detection ──
  // Poll for terminals owned by actions and inject them as panel tabs
  const [actionTerminals, setActionTerminals] = useState<Map<string, TerminalInfo[]>>(new Map());
  const prevActionTerminalKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const terms = await modus.listTerminals({ ownerType: "action" });
        if (!active) return;
        // Group by ownerName (action name)
        const grouped = new Map<string, TerminalInfo[]>();
        for (const t of terms) {
          if (!t.ownerName) continue;
          const list = grouped.get(t.ownerName) ?? [];
          list.push(t);
          grouped.set(t.ownerName, list);
        }
        setActionTerminals(grouped);
      } catch { /* silent */ }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  // Auto-open panel and select tab when new action terminals appear
  useEffect(() => {
    const currentKeys = new Set(actionTerminals.keys());
    const prev = prevActionTerminalKeysRef.current;
    let newKey: string | null = null;
    for (const key of currentKeys) {
      if (!prev.has(key)) { newKey = key; break; }
    }
    prevActionTerminalKeysRef.current = currentKeys;
    if (newKey) {
      onOpen();
      setRequestActiveId(`action-term:${newKey}`);
    }
  }, [actionTerminals, onOpen]);

  // Handle requestView — open panel and select the matching tab
  useEffect(() => {
    if (!requestView) return;
    const widgetType = REQUEST_VIEW_TO_WIDGET[requestView];
    if (!widgetType) {
      onRequestViewHandled?.();
      return;
    }
    const target = validWidgets.find((w) => w.type === widgetType);
    if (target) {
      onOpen();
      setRequestActiveId(getRightWidgetId(target));
    }
    onRequestViewHandled?.();
  }, [onOpen, onRequestViewHandled, requestView, validWidgets]);

  // Auto-select newly added move widgets (with autoOpen)
  useEffect(() => {
    const currentIds = new Set((moveWidgets ?? []).map(w => w.instanceId));
    const prev = prevMoveWidgetIdsRef.current;
    const newAutoOpen = (moveWidgets ?? []).findLast(
      w => !prev.has(w.instanceId) && w.widget.autoOpen !== false
    );
    prevMoveWidgetIdsRef.current = currentIds;
    if (newAutoOpen) {
      setRequestActiveId(`widget:${newAutoOpen.instanceId}`);
    }
  }, [moveWidgets]);

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
            onSelectSession={onSelectSession ?? (() => {})}
          />
        ),
      };
    }),
    ...(moveWidgets ?? []).map((moveWidget) => ({
      id: `widget:${moveWidget.instanceId}`,
      label: moveWidget.widget.label,
      title: moveWidget.widget.label,
      onReload: () => {
        evictWidgetModule(moveWidget.widget.moduleUrl);
        setWidgetReloadKeys(prev => ({ ...prev, [moveWidget.instanceId]: (prev[moveWidget.instanceId] ?? 0) + 1 }));
      },
      onClose: () => onWidgetClose?.(moveWidget.apiToken, moveWidget.widget.moveName),
      render: () => (
        <MoveWidget
          key={`${moveWidget.instanceId}-${widgetReloadKeys[moveWidget.instanceId] ?? 0}`}
          widget={moveWidget.widget}
          apiToken={moveWidget.apiToken}
          instanceId={moveWidget.instanceId}
          sessionId={moveWidget.sessionId}
          mountedOnAttach={moveWidget.mountedOnAttach}
        />
      ),
    })),
    // ── Action terminal tabs ──
    ...[...actionTerminals.entries()].map(([actionName]) => ({
      id: `action-term:${actionName}`,
      label: actionName,
      title: `${actionName} terminal`,
      icon: (
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
          <path d="M2 3l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M7 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      ),
      onClose: () => {
        setActionTerminals((prev) => {
          const next = new Map(prev);
          next.delete(actionName);
          return next;
        });
      },
      render: (active: boolean) => (
        <TerminalView
          visible={active}
          ownerType="action"
          ownerName={actionName}
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
    </RightPanelContextProvider>
  );
}
