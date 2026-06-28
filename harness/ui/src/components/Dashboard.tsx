import { useState, useCallback } from "react";
import type { View } from "../views";
import { useProfiles } from "../providers/ProfileContext";
import { LAUNCH_CWD } from "../launchParams";
import { ProjectSetup } from "./ProjectSetup";
import { ModusPrompt } from "./ModusPrompt";
import { Missions } from "./Missions";
import { WidgetPicker } from "./WidgetPicker";
import { DEFAULT_DASHBOARD, type WidgetBase } from "../widgets";
import { PageRenderer } from "./PageRenderer";
import { modus } from "../modusClient";

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
    activeUserProfile,
    visibleProfiles,
    userProfiles,
    refreshProfiles,
    refreshUserProfiles,
  } = useProfiles();
  const [setupDismissed, setSetupDismissed] = useState(false);
  const configuredWidgets = activeUP?.dashboard?.widgets ?? DEFAULT_DASHBOARD.widgets ?? [];
  const hasExtensions = configuredWidgets.some((w) => w.type === "extensions");
  const widgets = hasExtensions
    ? configuredWidgets
    : [...configuredWidgets, { id: "extensions-auto", type: "extensions", title: "extensions", size: "full" as const, collapsed: true }];

  const handleDashboardWidgetsChange = useCallback((next: WidgetBase[]) => {
    if (!activeUserProfile) return;
    modus.patchUserProfileUiConfig(activeUserProfile, {
      dashboard: { ...activeUP?.dashboard, widgets: next },
    }).then(() => refreshUserProfiles()).catch(() => {});
  }, [activeUserProfile, activeUP?.dashboard, refreshUserProfiles]);
  const hasUsableAgentProfile = visibleProfiles.length > 0;

  const needsProject = userProfiles.length === 0;
  // If launched with a cwd that isn't an exact match for any existing user profile's
  // project path, treat it as a new project request — show ProjectSetup with path pre-filled.
  const launchCwdIsNew = LAUNCH_CWD
    && !userProfiles.some((up) => up.projects?.includes(LAUNCH_CWD));
  const needsAgents = !!activeUP && !hasUsableAgentProfile;
  const showProjectSetup = forceSetup || (!setupDismissed && (needsProject || launchCwdIsNew));

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
          <>
            <ModusPrompt
              onSelectSession={onSelectSession}
              onNavigate={onNavigate}
              isNewProject={needsAgents}
            />
            <Missions />
          </>
        )}

        {activeUserProfile && (
          <div className="dashboard-widgets-picker">
            <WidgetPicker
              zone="dashboard"
              current={widgets as WidgetBase[]}
              onChange={handleDashboardWidgetsChange}
            />
          </div>
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
