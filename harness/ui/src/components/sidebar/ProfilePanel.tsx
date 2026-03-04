import { useState } from "react";
import type { Profile, UserProfile } from "../../api";
import { SessionSetup, type SessionSetupState } from "../SessionSetup";

type Props = {
  profiles: Profile[];
  selectedProfile: string;
  onSelectProfile: (name: string) => void;
  setupState: SessionSetupState;
  onSetupChange: (setup: SessionSetupState) => void;
  userProfiles?: UserProfile[];
  activeUserProfileObj?: UserProfile | null;
};

/** Detect which categories have overrides vs profile defaults */
function getOverrideTags(setup: SessionSetupState): string[] {
  const tags: string[] = [];
  if (setup.model) tags.push("model");
  if (setup.cwd.trim()) tags.push("cwd");
  if (setup.agent.effort) tags.push("effort");
  if (setup.agent.maxTurns) tags.push("turns");
  const toolOverrides = Object.keys(setup.agent.toolStates).length;
  if (toolOverrides > 0) tags.push(`${toolOverrides} tools`);
  if (!setup.loadProjectSettings) tags.push("no claude.md");
  return tags;
}

export function ProfilePanel({
  profiles, selectedProfile, onSelectProfile,
  setupState, onSetupChange,
  userProfiles, activeUserProfileObj,
}: Props) {
  const [configExpanded, setConfigExpanded] = useState(false);
  const selectedProfileData = profiles.find((p) => p.name === selectedProfile);
  const overrideTags = getOverrideTags(setupState);

  const profileSummary = selectedProfileData
    ? `${selectedProfileData.model?.replace("claude-", "").replace(/-\d.*/, "") ?? "?"} / ${selectedProfileData.effort ?? "default"} / ${
        typeof selectedProfileData.tools === "string"
          ? selectedProfileData.tools
          : selectedProfileData.tools?.length + " tools"
      }`
    : "";

  return (
    <div className="profile-panel">
      <button
        className="profile-panel-header"
        onClick={() => setConfigExpanded(!configExpanded)}
      >
        <div className="profile-panel-left">
          <span className="profile-panel-name">{selectedProfile}</span>
          <span className="profile-panel-summary">{profileSummary}</span>
        </div>
        <div className="profile-panel-right">
          {overrideTags.length > 0 && (
            <span className="profile-panel-overrides">
              {overrideTags.map((t) => (
                <span key={t} className="override-tag">{t}*</span>
              ))}
            </span>
          )}
          <span className={`profile-panel-chevron ${configExpanded ? "profile-panel-chevron--open" : ""}`}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M3 4l2 2.5L7 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        </div>
      </button>

      <div className={`panel-collapse ${configExpanded ? "panel-collapse--open" : ""}`}>
        <div className="panel-collapse-clip">
          <div className="profile-panel-body">
            <label className="agent-config-field">
              <span>profile</span>
              <select
                value={selectedProfile}
                onChange={(e) => onSelectProfile(e.target.value)}
              >
                {profiles.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </label>

            <SessionSetup
              config={setupState}
              profileTools={selectedProfileData?.tools ?? "all"}
              profileEffort={selectedProfileData?.effort}
              profileMaxTurns={selectedProfileData?.maxTurns}
              profileModel={selectedProfileData?.model}
              onChange={onSetupChange}
              projectPaths={
                activeUserProfileObj?.showAllProjectPaths && userProfiles
                  ? [...new Set(userProfiles.flatMap((u) => u.projects))]
                  : activeUserProfileObj?.projects
              }
              showAllProjectPaths={activeUserProfileObj?.showAllProjectPaths}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
