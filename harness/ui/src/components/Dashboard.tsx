import { useState, useCallback } from "react";
import type { View } from "../views";
import { useProfiles } from "../providers/ProfileProvider";
import { ProjectSetup } from "./ProjectSetup";
import { ModusPrompt } from "./ModusPrompt";
import { WIDGETS, DEFAULT_DASHBOARD } from "../widgets";
import type { WidgetBase } from "../widgets";

type Props = {
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
};

const chevron = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
);

function WidgetSlot({
  config,
  onNavigate,
  onSelectSession,
}: {
  config: WidgetBase;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(config.collapsed ?? false);
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
          <Widget config={config} onNavigate={onNavigate} onSelectSession={onSelectSession} />
        </div>
      </div>
    </div>
  );
}

/**
 * Dashboard — home/landing page.
 *
 * Shows ProjectSetup when no user profile exists or when the active
 * profile has no agent profiles configured. Otherwise shows widgets.
 */
export function Dashboard({ onNavigate, onSelectSession }: Props) {
  const { activeUP, userProfiles, refreshProfiles, refreshUserProfiles } = useProfiles();
  const [setupDismissed, setSetupDismissed] = useState(false);
  const dashboard = activeUP?.dashboard ?? DEFAULT_DASHBOARD;

  const needsProject = userProfiles.length === 0;
  const needsAgents = activeUP && (!activeUP.agentProfiles || activeUP.agentProfiles.length === 0);
  const showSetup = !setupDismissed && (needsProject || needsAgents);

  const handleSetupComplete = useCallback(() => {
    setSetupDismissed(true);
    refreshProfiles();
    refreshUserProfiles();
  }, [refreshProfiles, refreshUserProfiles]);

  return (
    <div className="dashboard">
      {showSetup ? (
        <ProjectSetup
          existingProject={needsAgents && !needsProject ? activeUP!.name : undefined}
          onComplete={handleSetupComplete}
          onSelectSession={onSelectSession}
        />
      ) : (
        <ModusPrompt onSelectSession={onSelectSession} />
      )}

      {/* Widgets — always visible (setup/prompt is above, not replacing) */}
      <div className="dashboard-widgets">
        {dashboard.widgets.map((config: WidgetBase, i: number) => (
          <WidgetSlot
            key={`${config.type}-${i}`}
            config={config}
            onNavigate={onNavigate}
            onSelectSession={onSelectSession}
          />
        ))}
      </div>
    </div>
  );
}
