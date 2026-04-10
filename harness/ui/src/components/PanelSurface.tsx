import { useEffect, useRef, useState, type ReactNode, type WheelEvent } from "react";
import { WidgetChromeContext } from "../widgets";
import { useWidgetUiState } from "../widgets/ui-state";
import { useProfiles } from "../providers/ProfileContext";

export type PanelSurfaceItem = {
  id: string;
  label: string;
  title?: string;
  icon?: ReactNode;
  minHeight?: number;
  maxHeight?: number;
  preferredHeight?: number;
  defaultCollapsed?: boolean;
  onClose?: () => void;
  onReload?: () => void;
  render: (active: boolean) => ReactNode;
};

type Props = {
  mode: "list" | "tabs";
  items: PanelSurfaceItem[];
  picker?: ReactNode;
  empty: ReactNode;
  /** Request that a specific tab be activated (by item id). Cleared after handling. */
  requestActiveId?: string | null;
  onRequestActiveHandled?: () => void;
  surfaceClassName: string;
  headerClassName?: string;
  bodyClassName?: string;
  contentClassName?: string;
  tabsClassName: string;
  tabClassName: string;
  tabActiveClassName: string;
  tabIconOnlyClassName?: string;
  tabLabelClassName: string;
  tabCloseClassName: string;
};

function CollapsibleSurfaceItem({ item }: { item: PanelSurfaceItem }) {
  const { activeUserProfile } = useProfiles();
  const [collapsed, setCollapsed] = useWidgetUiState(
    { userProfile: activeUserProfile },
    item.id,
    "collapsed",
    item.defaultCollapsed ?? false,
  );
  const [headerSuffix, setHeaderSuffix] = useState<string | null>(null);

  return (
    <div className="widget">
      <button className="widget-header" onClick={() => setCollapsed(!collapsed)}>
        <span className={`widget-chevron ${collapsed ? "" : "widget-chevron--open"}`}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
          </svg>
        </span>
        <span className="widget-title">{item.label}{collapsed && headerSuffix ? ` ${headerSuffix}` : ""}</span>
      </button>
      <div className={`panel-collapse ${collapsed ? "" : "panel-collapse--open"}`}>
        <div className="panel-collapse-clip">
          <div
            className="panel-surface-item-body panel-surface-item-body--list"
            style={{
              minHeight: item.minHeight,
              maxHeight: item.maxHeight,
              height: item.preferredHeight,
            }}
          >
            <WidgetChromeContext.Provider value={{ setHeaderSuffix }}>
              {item.render(!collapsed)}
            </WidgetChromeContext.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PanelSurface({
  mode,
  items,
  picker,
  empty,
  requestActiveId,
  onRequestActiveHandled,
  surfaceClassName,
  headerClassName,
  bodyClassName,
  contentClassName,
  tabsClassName,
  tabClassName,
  tabActiveClassName,
  tabIconOnlyClassName = "",
  tabLabelClassName,
  tabCloseClassName,
}: Props) {
  const [activeItemId, setActiveItemId] = useState<string | null>(items[0]?.id ?? null);
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!items.length) {
      setActiveItemId(null);
      return;
    }
    if (activeItemId && items.some((item) => item.id === activeItemId)) return;
    setActiveItemId(items[0].id);
  }, [activeItemId, items]);

  // Handle external request to activate a specific tab
  useEffect(() => {
    if (!requestActiveId) return;
    if (items.some((item) => item.id === requestActiveId)) {
      setActiveItemId(requestActiveId);
    }
    onRequestActiveHandled?.();
  }, [requestActiveId, items, onRequestActiveHandled]);

  const tabs = mode === "tabs" && items.length > 1 ? (
    <div
      className={tabsClassName}
      ref={tabsRef}
      onWheel={(e: WheelEvent<HTMLDivElement>) => {
        if (!tabsRef.current) return;
        e.preventDefault();
        tabsRef.current.scrollLeft += e.deltaY + e.deltaX;
      }}
    >
      {items.map((item) => {
        const iconOnly = !!item.icon;
        return (
          <div
            key={item.id}
            className={`${tabClassName}${iconOnly ? ` ${tabIconOnlyClassName}` : ""}${activeItemId === item.id ? ` ${tabActiveClassName}` : ""}`}
          >
            <button
              className={tabLabelClassName}
              onClick={() => setActiveItemId(item.id)}
              title={item.title ?? item.label}
            >
              {item.icon ?? item.label}
            </button>
            {item.onReload && (
              <button className={tabCloseClassName} onClick={(e) => { e.stopPropagation(); item.onReload?.(); }} title="Reload widget">
                <svg width="7" height="7" viewBox="0 0 10 10" fill="none">
                  <path d="M8 2.5A3.5 3.5 0 1 0 8.5 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
                  <path d="M6.5 2.5H8.5V0.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                </svg>
              </button>
            )}
            {item.onClose && (
              <button className={tabCloseClassName} onClick={(e) => { e.stopPropagation(); item.onClose?.(); }} title="Remove widget">
                <svg width="7" height="7" viewBox="0 0 10 10" fill="none">
                  <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  ) : null;

  const content = items.length > 0 ? (
    mode === "tabs" ? (
      items.map((item) => (
        <div
          key={item.id}
          className="panel-surface-item-body panel-surface-item-body--tabs"
          style={{ display: activeItemId === item.id ? "flex" : "none" }}
        >
          <WidgetChromeContext.Provider value={{ setHeaderSuffix: () => {} }}>
            {item.render(activeItemId === item.id)}
          </WidgetChromeContext.Provider>
        </div>
      ))
    ) : (
      items.map((item) => <CollapsibleSurfaceItem key={item.id} item={item} />)
    )
  ) : empty;

  if (headerClassName || bodyClassName || contentClassName) {
    return (
      <>
        {(headerClassName || picker) && (
          <div className={headerClassName}>
            {picker}
            {tabs}
          </div>
        )}
        {bodyClassName ? (
          <div className={bodyClassName}>
            <div className={contentClassName}>{content}</div>
          </div>
        ) : (
          <div className={contentClassName}>{content}</div>
        )}
      </>
    );
  }

  return (
    <div className={surfaceClassName}>
      {picker}
      {tabs}
      {content}
    </div>
  );
}
