import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { View } from "../views";
import { useProfiles } from "../providers/ProfileContext";
import { Markdown } from "./Markdown";
import { Actions } from "./Actions";
import { GitPanel } from "./GitPanel";
import { WIDGETS, WidgetChromeContext } from "../widgets";
import type { DashboardBlock, DashboardModule, LayoutNode, PageContextHandle, ScopeEvent, WidgetBase, WidgetSize } from "../widgets";
import { getWidgetInstanceId, useWidgetUiState } from "../widgets/ui-state";
import { PanelTreeRenderer } from "./PanelTreeRenderer";

// ── Page-scoped shared state bus ──

const emptyBusSnapshot: Record<string, unknown> = {};

type EventHandler = (event: ScopeEvent) => void;

type PageStateBus = {
  state: Record<string, unknown>;
  listeners: Set<() => void>;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => Record<string, unknown>;
  /** Emit an event on this bus. All matching handlers fire synchronously. */
  emit: (event: ScopeEvent) => void;
  /** Subscribe to events of a given type. Returns unsubscribe function. */
  on: (type: string, handler: EventHandler) => () => void;
  /** Navigation callbacks from the parent view — available to widgets with canNavigate */
  onNavigate?: (view: string) => void;
  onSelectSession?: (id: string) => void;
};

function createPageStateBus(initial: Record<string, unknown>): PageStateBus {
  const eventHandlers = new Map<string, Set<EventHandler>>();

  const bus: PageStateBus = {
    state: { ...initial },
    listeners: new Set(),
    get(key) { return bus.state[key]; },
    set(key, value) {
      if (bus.state[key] === value) return;
      bus.state = { ...bus.state, [key]: value };
      bus.listeners.forEach((cb) => cb());
    },
    subscribe(cb) {
      bus.listeners.add(cb);
      return () => { bus.listeners.delete(cb); };
    },
    getSnapshot() { return bus.state; },
    emit(event) {
      const handlers = eventHandlers.get(event.type);
      if (handlers) handlers.forEach((h) => h(event));
    },
    on(type, handler) {
      let set = eventHandlers.get(type);
      if (!set) { set = new Set(); eventHandlers.set(type, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    },
  };
  return bus;
}

const PageStateBusContext = createContext<PageStateBus | null>(null);

// ── Page URL context — exposes hash session id to scope binders ──

type PageUrlState = {
  hashSessionId: string | null;
};

const PageUrlContext = createContext<PageUrlState>({ hashSessionId: null });

/**
 * Provides the current hash session id to the page subtree so scope nodes with
 * `bindUrlSession: true` can mirror it into their context bus. Outbound sync
 * (bus → URL) flows through `bus.onSelectSession`, which App wires to setUrlSession.
 */
export function PageUrlProvider({
  hashSessionId,
  children,
}: {
  hashSessionId: string | null;
  children: ReactNode;
}) {
  return (
    <PageUrlContext.Provider value={{ hashSessionId }}>
      {children}
    </PageUrlContext.Provider>
  );
}

export function usePageUrl(): PageUrlState {
  return useContext(PageUrlContext);
}

/**
 * ScopeUrlSessionBinder — invisible bridge between hash session id and scope bus.
 * Inbound: pushes hashSessionId into bus as `sessionId` on mount and changes.
 * Outbound: when bus `sessionId` changes, calls bus.onSelectSession to update URL.
 * Only mounted when scope node has `bindUrlSession: true`.
 */
export function ScopeUrlSessionBinder() {
  const bus = useContext(PageStateBusContext);
  const { hashSessionId } = usePageUrl();
  const lastPushed = useRef<string | null | undefined>(undefined);

  // Inbound: hash → bus
  useEffect(() => {
    if (!bus) return;
    const current = bus.get("sessionId") as string | null | undefined;
    const next = hashSessionId ?? null;
    if (current !== next) bus.set("sessionId", next);
    lastPushed.current = next;
  }, [bus, hashSessionId]);

  // Outbound: bus → URL (via onSelectSession wired up by PageView)
  const busState = useSyncExternalStore<Record<string, unknown>>(
    bus ? bus.subscribe : () => () => {},
    bus ? bus.getSnapshot : () => emptyBusSnapshot,
  );
  useEffect(() => {
    if (!bus) return;
    const sid = busState.sessionId as string | null | undefined;
    // Don't echo back a change we just applied from the URL
    if (sid === lastPushed.current) return;
    lastPushed.current = sid ?? null;
    if (sid && bus.onSelectSession) bus.onSelectSession(sid);
  }, [bus, busState.sessionId]);

  return null;
}

/**
 * Check if a layout leaf should be visible based on showWhen/hideWhen
 * conditions evaluated against the page context bus state.
 * Returns true (visible) when no bus or no conditions are set.
 */
export function useLeafVisible(
  showWhen?: Record<string, unknown>,
  hideWhen?: Record<string, unknown>,
): boolean {
  const bus = useContext(PageStateBusContext);
  useSyncExternalStore(
    bus ? bus.subscribe : () => () => {},
    bus ? bus.getSnapshot : () => ({}),
  );
  if (!bus) return true;
  // showWhen: ALL conditions must match (AND)
  if (showWhen) {
    for (const [key, expected] of Object.entries(showWhen)) {
      const actual = bus.get(key);
      if (expected === null) {
        if (actual != null) return false;
      } else if (actual !== expected) {
        return false;
      }
    }
  }
  // hideWhen: ANY condition matching hides the widget (OR)
  if (hideWhen) {
    for (const [key, expected] of Object.entries(hideWhen)) {
      const actual = bus.get(key);
      if (expected === null) {
        if (actual == null) return false;
      } else if (actual === expected) {
        return false;
      }
    }
  }
  return true;
}

/** Hook for widgets to access their scoped page context slice */
export function usePageContext(
  publishKeys?: Record<string, string>,
  subscribeKeys?: Record<string, string>,
  canNavigate?: boolean,
): PageContextHandle | undefined {
  const bus = useContext(PageStateBusContext);
  // Subscribe to state changes so widget re-renders on relevant updates
  useSyncExternalStore(
    bus ? bus.subscribe : () => () => {},
    bus ? bus.getSnapshot : () => ({}),
  );

  const publishRef = useRef(publishKeys);
  publishRef.current = publishKeys;
  const subscribeRef = useRef(subscribeKeys);
  subscribeRef.current = subscribeKeys;

  const get = useCallback((key: string): unknown => {
    if (!bus) return undefined;
    // Translate widget-local key to page context key via subscribe mapping
    const contextKey = subscribeRef.current?.[key] ?? key;
    return bus.get(contextKey);
  }, [bus]);

  const set = useCallback((key: string, value: unknown): void => {
    if (!bus) return;
    // Translate widget-local key to page context key via publish mapping
    const contextKey = publishRef.current?.[key] ?? key;
    bus.set(contextKey, value);
  }, [bus]);

  const emit = useCallback((event: ScopeEvent): void => {
    bus?.emit(event);
  }, [bus]);

  const on = useCallback((type: string, handler: (event: ScopeEvent) => void): () => void => {
    if (!bus) return () => {};
    return bus.on(type, handler);
  }, [bus]);

  if (!bus) return undefined;
  return {
    get,
    set,
    emit,
    on,
    navigate: canNavigate ? bus.onNavigate : undefined,
    selectSession: canNavigate ? bus.onSelectSession : undefined,
  };
}

/** Direct access to the bus for scope-level components (not widget-scoped) */
export function useScopeBus(): PageStateBus | null {
  return useContext(PageStateBusContext);
}

/** Render a scope node — creates a nested context bus for its subtree */
export function ScopeProvider({
  context,
  onNavigate,
  onSelectSession,
  children,
}: {
  context?: Record<string, unknown>;
  onNavigate?: (view: string) => void;
  onSelectSession?: (id: string) => void;
  children: ReactNode;
}) {
  const [bus] = useState(() => createPageStateBus(context ?? {}));
  bus.onNavigate = onNavigate;
  bus.onSelectSession = onSelectSession;
  return (
    <PageStateBusContext.Provider value={bus}>
      {children}
    </PageStateBusContext.Provider>
  );
}

type LegacyPagePanelNode = {
  kind: "panel";
  id?: string;
  title?: string;
  mode?: "list" | "tabs";
  activeTab?: string;
  columnSpan?: number;
  rowSpan?: number;
  items?: Array<{ widget?: WidgetBase }>;
};

type LegacyPageGridNode = {
  kind: "grid";
  id?: string;
  columns: number;
  gap?: number;
  templateColumns?: string[];
  templateRows?: string[];
  children?: Array<PageLayoutInput>;
};

type PageLayoutInput = LayoutNode | LegacyPagePanelNode | LegacyPageGridNode;

const chevron = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
);

function BlockShell({
  title,
  size,
  blockId,
  userProfile,
  cwd,
  defaultCollapsed,
  children,
}: {
  title: string;
  size?: WidgetSize;
  blockId: string;
  userProfile: string | null;
  cwd?: string;
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useWidgetUiState(
    { userProfile, cwd },
    blockId,
    "collapsed",
    defaultCollapsed ?? false,
  );
  const [headerSuffix, setHeaderSuffix] = useState<string | null>(null);

  return (
    <div className={`widget widget--${size ?? "full"}`}>
      <button className="widget-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="widget-title">{title}{collapsed && headerSuffix ? ` ${headerSuffix}` : ""}</span>
        <span className={`widget-chevron ${collapsed ? "" : "widget-chevron--open"}`}>
          {chevron}
        </span>
      </button>
      <div className={`panel-collapse ${collapsed ? "" : "panel-collapse--open"}`}>
        <div className="panel-collapse-clip">
          <WidgetChromeContext.Provider value={{ setHeaderSuffix }}>
            {children}
          </WidgetChromeContext.Provider>
        </div>
      </div>
    </div>
  );
}

function WidgetBlock({
  config,
  index,
  userProfile,
  cwd,
  onNavigate,
  onSelectSession,
}: {
  config: WidgetBase;
  index: number;
  userProfile: string | null;
  cwd?: string;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
}) {
  const Widget = WIDGETS[config.type];
  if (!Widget) return null;

  const widgetId = getWidgetInstanceId(config, index);
  return (
    <BlockShell
      title={config.title ?? config.type}
      size={config.size}
      blockId={widgetId}
      userProfile={userProfile}
      cwd={cwd}
      defaultCollapsed={config.collapsed}
    >
      <Widget
        config={config}
        widgetId={widgetId}
        onNavigate={onNavigate}
        onSelectSession={onSelectSession}
      />
    </BlockShell>
  );
}

function ModuleBlock({
  module,
  onSelectSession,
  cwd,
}: {
  module: DashboardModule;
  onSelectSession: (id: string) => void;
  cwd?: string;
}) {
  if (module === "actions") {
    return <Actions onSelectSession={onSelectSession} />;
  }
  if (module === "git") {
    return <GitPanel cwd={cwd ?? null} />;
  }
  return null;
}

function PageBlock({
  block,
  index,
  userProfile,
  cwd,
  onNavigate,
  onSelectSession,
}: {
  block: DashboardBlock;
  index: number;
  userProfile: string | null;
  cwd?: string;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
}) {
  if (block.kind === "widget") {
    return (
      <WidgetBlock
        config={block.widget}
        index={index}
        userProfile={userProfile}
        cwd={cwd}
        onNavigate={onNavigate}
        onSelectSession={onSelectSession}
      />
    );
  }

  if (block.kind === "module") {
    const blockId = block.id?.trim() || `${block.module}-${index}`;
    return (
      <BlockShell
        title={block.title ?? block.module}
        size={block.size}
        blockId={blockId}
        userProfile={userProfile}
        cwd={cwd}
        defaultCollapsed={block.collapsed}
      >
        <ModuleBlock
          module={block.module}
          onSelectSession={onSelectSession}
          cwd={cwd}
        />
      </BlockShell>
    );
  }

  const blockId = block.id?.trim() || `text-${index}`;
  return (
    <BlockShell
      title={block.title ?? "notes"}
      size={block.size}
      blockId={blockId}
      userProfile={userProfile}
      cwd={cwd}
      defaultCollapsed={block.collapsed}
    >
      <div className="message-content">
        <Markdown content={block.markdown} />
      </div>
    </BlockShell>
  );
}

export function PageRenderer({
  blocks,
  onNavigate,
  onSelectSession,
}: {
  blocks: DashboardBlock[];
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
}) {
  const { activeCwd, activeUserProfile } = useProfiles();

  return (
    <div className="dashboard-widgets">
      {blocks.map((block, index) => (
        <PageBlock
          key={
            block.kind === "widget"
              ? getWidgetInstanceId(block.widget, index)
              : block.id?.trim() || `${block.kind}-${index}`
          }
          block={block}
          index={index}
          userProfile={activeUserProfile}
          cwd={activeCwd}
          onNavigate={onNavigate}
          onSelectSession={onSelectSession}
        />
      ))}
    </div>
  );
}

export function PageView({
  blocks,
  layout,
  context,
  padding,
  onNavigate,
  onSelectSession,
  hashSessionId,
}: {
  blocks?: DashboardBlock[];
  layout?: PageLayoutInput;
  context?: Record<string, unknown>;
  padding?: number;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  /** Current hash session id — enables scope nodes with bindUrlSession to deep-link */
  hashSessionId?: string | null;
}) {
  const { activeCwd } = useProfiles();
  const normalizedLayout = layout ? normalizePageLayoutNode(layout) : undefined;
  // Stable ref — only create bus once per mount
  const [bus] = useState(() => createPageStateBus(context ?? {}));
  // Attach navigation callbacks so canNavigate widgets can escape the page
  bus.onNavigate = onNavigate as (view: string) => void;
  bus.onSelectSession = onSelectSession;

  if (normalizedLayout) {
    return (
      <PageStateBusContext.Provider value={bus}>
        <PageUrlProvider hashSessionId={hashSessionId ?? null}>
          <div className="dashboard" style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                padding: `${padding ?? 0}px`,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <PanelTreeRenderer
                node={normalizedLayout}
                onNavigate={onNavigate}
                onSelectSession={onSelectSession}
              />
            </div>
          </div>
        </PageUrlProvider>
      </PageStateBusContext.Provider>
    );
  }

  const resolvedBlocks = blocks ?? [];

  if (resolvedBlocks.length === 1 && resolvedBlocks[0]?.kind === "module") {
    return (
      <div className="dashboard">
        <div className="dashboard-inner">
          <ModuleBlock
            module={resolvedBlocks[0].module}
            onSelectSession={onSelectSession}
            cwd={activeCwd}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="dashboard-inner">
        <PageRenderer
          blocks={resolvedBlocks}
          onNavigate={onNavigate}
          onSelectSession={onSelectSession}
        />
      </div>
    </div>
  );
}

function normalizePageLayoutNode(node: PageLayoutInput): LayoutNode {
  if (node.kind === "panel") {
    return {
      kind: node.mode === "list" ? "list" : "tabs",
      id: node.id,
      title: node.title,
      activeTab: node.activeTab,
      columnSpan: node.columnSpan,
      rowSpan: node.rowSpan,
      children: (node.items ?? [])
        .filter((item): item is { widget: WidgetBase } => !!item?.widget)
        .map((item) => ({
          kind: "widget",
          id: item.widget.id,
          widget: item.widget,
        })),
    };
  }

  if (node.kind === "grid") {
    return {
      ...node,
      children: (node.children ?? []).map(normalizePageLayoutNode),
    };
  }

  if (node.kind === "split") {
    return {
      ...node,
      children: node.children.map(normalizePageLayoutNode),
    };
  }

  if (node.kind === "scope") {
    return {
      ...node,
      children: node.children.map(normalizePageLayoutNode),
    };
  }

  if (node.kind === "tabs" || node.kind === "list") {
    return {
      ...node,
      children: node.children ?? [],
    };
  }

  return node;
}
