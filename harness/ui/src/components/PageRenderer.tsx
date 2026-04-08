import { useState, type ReactNode } from "react";
import type { View } from "../views";
import { useProfiles } from "../providers/ProfileContext";
import { Markdown } from "./Markdown";
import { Actions } from "./Actions";
import { GitPanel } from "./GitPanel";
import { WIDGETS, WidgetChromeContext } from "../widgets";
import type { DashboardBlock, DashboardModule, LayoutNode, WidgetBase, WidgetSize } from "../widgets";
import { getWidgetInstanceId, useWidgetUiState } from "../widgets/ui-state";
import { RightPanelContextProvider } from "./RightPanelContext";
import { PanelTreeRenderer } from "./PanelTreeRenderer";

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
  padding,
  onNavigate,
  onSelectSession,
}: {
  blocks?: DashboardBlock[];
  layout?: PageLayoutInput;
  padding?: number;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
}) {
  const { activeCwd } = useProfiles();
  const normalizedLayout = layout ? normalizePageLayoutNode(layout) : undefined;

  if (normalizedLayout) {
    return (
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
          <RightPanelContextProvider value={{
            messages: [],
            sessionId: null,
            browserPath: null,
            activeWidgetId: null,
            setBrowserPath: () => {},
            requestOpen: () => {},
          }}>
            <PanelTreeRenderer
              node={normalizedLayout}
              onNavigate={onNavigate}
              onSelectSession={onSelectSession}
            />
          </RightPanelContextProvider>
        </div>
      </div>
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

  if (node.kind === "tabs" || node.kind === "list") {
    return {
      ...node,
      children: node.children ?? [],
    };
  }

  return node;
}
