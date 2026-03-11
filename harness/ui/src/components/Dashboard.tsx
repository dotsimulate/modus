import { useState, useCallback } from "react";
import type { View } from "../views";
import { useProfiles } from "../providers/ProfileProvider";
import { ProjectSetup } from "./ProjectSetup";
import { ModusPrompt } from "./ModusPrompt";
import { WIDGETS, DEFAULT_DASHBOARD } from "../widgets";
import type { WidgetBase } from "../widgets";
import { getWidgetInstanceId, useWidgetUiState } from "../widgets/ui-state";

type Props = {
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  forceSetup?: boolean;
  onSetupDone?: () => void;
};

const chevron = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
);

function WidgetSlot({
  config,
  widgetId,
  userProfile,
  cwd,
  onNavigate,
  onSelectSession,
}: {
  config: WidgetBase;
  widgetId: string;
  userProfile: string | null;
  cwd?: string;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useWidgetUiState(
    { userProfile, cwd },
    widgetId,
    "collapsed",
    config.collapsed ?? false,
  );
  const Widget = WIDGETS[config.type];
  if (!Widget) return null;

  const title = config.title ?? config.type;

  return (
    <div className={`widget widget--${config.size ?? "full"}`}>
      <button className="widget-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="widget-title">{title}</span>
        <span className={`widget-chevron ${collapsed ? "" : "widget-chevron--open"}`}>
          {chevron}
        </span>
      </button>
      <div className={`panel-collapse ${collapsed ? "" : "panel-collapse--open"}`}>
        <div className="panel-collapse-clip">
          <Widget
            config={config}
            widgetId={widgetId}
            onNavigate={onNavigate}
            onSelectSession={onSelectSession}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Dashboard — home/landing page.
 *
 * Shows ProjectSetup only when no user profile exists (project creation).
 * Once a project exists, ModusPrompt handles everything — including agent
 * setup via prompt presets (explore, set up agents, configure).
 */
export function Dashboard({ onNavigate, onSelectSession, forceSetup, onSetupDone }: Props) {
  const {
    activeUP,
    activeCwd,
    activeUserProfile,
    userProfiles,
    refreshProfiles,
    refreshUserProfiles,
  } = useProfiles();
  const [setupDismissed, setSetupDismissed] = useState(false);
  const dashboard = activeUP?.dashboard ?? DEFAULT_DASHBOARD;

  const needsProject = userProfiles.length === 0;
  const needsAgents = activeUP && (!activeUP.agentProfiles || activeUP.agentProfiles.length === 0);
  const showProjectSetup = forceSetup || (!setupDismissed && needsProject);

  const handleSetupComplete = useCallback(() => {
    setSetupDismissed(true);
    onSetupDone?.();
    refreshProfiles();
    refreshUserProfiles();
  }, [refreshProfiles, refreshUserProfiles, onSetupDone]);

  return (
    <div className="dashboard">
      <div className="dashboard-inner">
        {showProjectSetup ? (
          <ProjectSetup
            onComplete={handleSetupComplete}
            onSelectSession={onSelectSession}
          />
        ) : (
          <ModusPrompt
            onSelectSession={onSelectSession}
            isNewProject={!!needsAgents}
          />
        )}

        {/* Widgets — always visible */}
        <div className="dashboard-widgets">
          {dashboard.widgets.map((config: WidgetBase, i: number) => (
            <WidgetSlot
              key={getWidgetInstanceId(config, i)}
              config={config}
              widgetId={getWidgetInstanceId(config, i)}
              userProfile={activeUserProfile}
              cwd={activeCwd}
              onNavigate={onNavigate}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
