import { useState, useCallback } from "react";
import type { View } from "../views";
import { useProfiles } from "../providers/ProfileProvider";
import { ProjectSetup } from "./ProjectSetup";
import { ModusPrompt } from "./ModusPrompt";
import { DEFAULT_DASHBOARD } from "../widgets";
import { PageRenderer } from "./PageRenderer";

type Props = {
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  forceSetup?: boolean;
  onSetupDone?: () => void;
};

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
    userProfiles,
    refreshProfiles,
    refreshUserProfiles,
  } = useProfiles();
  const [setupDismissed, setSetupDismissed] = useState(false);
  const widgets = activeUP?.dashboard?.widgets ?? DEFAULT_DASHBOARD.widgets ?? [];

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

        <PageRenderer
          blocks={widgets.map((widget) => ({ kind: "widget" as const, widget }))}
          onNavigate={onNavigate}
          onSelectSession={onSelectSession}
        />
      </div>
    </div>
  );
}
