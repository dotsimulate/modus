import { useEffect, useRef, useState, type ReactNode } from "react";
import type { View } from "../views";
import { useProfiles } from "../providers/ProfileContext";
import { Markdown } from "./Markdown";
import { Actions } from "./Actions";
import { GitPanel } from "./GitPanel";
import { WIDGETS, WidgetChromeContext } from "../widgets";
import type { DashboardBlock, DashboardModule, LayoutNode, ScopeBinding, WidgetBase, WidgetSize } from "../widgets";
import { getWidgetInstanceId, useWidgetUiState } from "../widgets/ui-state";
import { PanelTreeRenderer } from "./PanelTreeRenderer";
import { PageInspectProbe } from "./PageInspectProbe";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";
import {
  PageStateBusContext,
  PageUrlProvider,
  ScopeBindingBridge,
  ScopeProvider,
  ScopeUrlSessionBinder,
  createPageStateBus,
  useLeafVisible,
  usePageContext,
  usePageUrl,
  useScopeBus,
} from "./pageScope";

export {
  PageUrlProvider,
  ScopeProvider,
  ScopeUrlSessionBinder,
  useLeafVisible,
  usePageContext,
  usePageUrl,
  useScopeBus,
};


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
type ResponsivePageLayouts = {
  mobile?: PageLayoutInput;
};

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
            <WidgetErrorBoundary label={title} logLabel="page widget">
              {children}
            </WidgetErrorBoundary>
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
  layouts,
  context,
  padding,
  onNavigate,
  onSelectSession,
  onActivateSession,
  hashSessionId,
  pageId,
  parentBus,
  bindings,
}: {
  blocks?: DashboardBlock[];
  layout?: PageLayoutInput;
  layouts?: ResponsivePageLayouts;
  context?: Record<string, unknown>;
  padding?: number;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  onActivateSession?: (id: string, project?: string | null) => void;
  /** Current hash session id — enables scope nodes with bindUrlSession to deep-link */
  hashSessionId?: string | null;
  /** Page id, used only to label measurements from the page inspector. */
  pageId?: string;
  /** Optional outer page bus for a nested, directionally-bound layout. */
  parentBus?: import("./pageScope").PageStateBus | null;
  bindings?: ScopeBinding[];
}) {
  const { activeCwd } = useProfiles();
  const isMobile = useMediaQuery("(max-width: 640px)");
  const inspectRef = useRef<HTMLDivElement>(null);
  const selectedLayout = isMobile && layouts?.mobile ? layouts.mobile : layout;
  const normalizedLayout = selectedLayout ? normalizePageLayoutNode(selectedLayout) : undefined;
  // Stable ref — only create bus once per mount
  const [bus] = useState(() => createPageStateBus(context ?? {}));
  // Attach navigation callbacks so canNavigate widgets can escape the page
  bus.onNavigate = onNavigate as (view: string) => void;
  bus.onSelectSession = onSelectSession;
  bus.onActivateSession = onActivateSession;

  if (normalizedLayout) {
    return (
      <PageStateBusContext.Provider value={bus}>
        <PageUrlProvider hashSessionId={hashSessionId ?? null}>
          {parentBus && bindings && bindings.length > 0 && (
            <ScopeBindingBridge parentBus={parentBus} bindings={bindings} />
          )}
          <div className="dashboard" style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
            <div
              ref={inspectRef}
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
                onActivateSession={onActivateSession}
              />
            </div>
            <PageInspectProbe
              containerRef={inspectRef}
              pageId={pageId ?? "unknown"}
              {...(isMobile && layouts?.mobile ? { layoutName: "mobile" } : {})}
            />
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

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(query);
    const handleChange = () => setMatches(media.matches);
    handleChange();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
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

  if (node.kind === "overlay") {
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
