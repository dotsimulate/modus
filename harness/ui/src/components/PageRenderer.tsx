import type { ReactNode } from "react";
import type { View } from "../views";
import { useProfiles } from "../providers/ProfileProvider";
import { Markdown } from "./Markdown";
import { Actions } from "./Actions";
import { GitPanel } from "./GitPanel";
import { WIDGETS } from "../widgets";
import type { DashboardBlock, DashboardModule, WidgetBase, WidgetSize } from "../widgets";
import { getWidgetInstanceId, useWidgetUiState } from "../widgets/ui-state";

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

  return (
    <div className={`widget widget--${size ?? "full"}`}>
      <button className="widget-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="widget-title">{title}</span>
        <span className={`widget-chevron ${collapsed ? "" : "widget-chevron--open"}`}>
          {chevron}
        </span>
      </button>
      <div className={`panel-collapse ${collapsed ? "" : "panel-collapse--open"}`}>
        <div className="panel-collapse-clip">
          {children}
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
  onNavigate,
  onSelectSession,
}: {
  blocks: DashboardBlock[];
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
}) {
  const { activeCwd } = useProfiles();

  if (blocks.length === 1 && blocks[0]?.kind === "module") {
    return (
      <div className="dashboard">
        <div className="dashboard-inner">
          <ModuleBlock
            module={blocks[0].module}
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
          blocks={blocks}
          onNavigate={onNavigate}
          onSelectSession={onSelectSession}
        />
      </div>
    </div>
  );
}
