import { useEffect, useRef, useState } from "react";
import { fetchProviderModels, type Profile, type UserProfile } from "../../api";
import { useProfiles } from "../../providers/ProfileProvider";
import { SearchDropdown } from "../SearchDropdown";
import { SessionSetup, shortenPath, type SessionSetupState } from "../SessionSetup";

type Props = {
  profiles: Profile[];
  availableProviders?: string[];
  selectedProfile: string;
  onSelectProfile: (name: string) => void;
  setupState: SessionSetupState;
  onSetupChange: (setup: SessionSetupState) => void;
  activeUserProfileObj?: UserProfile | null;
};

/** Detect which categories have overrides vs profile defaults */
function getOverrideTags(setup: SessionSetupState): string[] {
  const tags: string[] = [];
  if (setup.agent.provider) tags.push("provider");
  if (setup.cwd.trim()) tags.push("cwd");
  if (!setup.loadProjectSettings) tags.push("no claude.md");
  return tags;
}

function providerSeedModel(provider: string): string {
  if (provider === "codex") return "gpt-5.1-codex";
  if (provider === "gemini-cli") return "auto-gemini-3";
  if (provider === "claude-code" || provider === "anthropic") return "claude-opus-4-6";
  return "";
}

export function ProfilePanel({
  profiles, availableProviders, selectedProfile, onSelectProfile,
  setupState, onSetupChange,
  activeUserProfileObj,
}: Props) {
  const { userProfiles, refreshProfiles } = useProfiles();
  const [configExpanded, setConfigExpanded] = useState(false);
  const setupStateRef = useRef(setupState);
  const selectedProfileData = profiles.find((p) => p.name === selectedProfile);
  const overrideTags = getOverrideTags(setupState);
  const effectiveProvider =
    setupState.agent.provider
    || selectedProfileData?.provider
    || activeUserProfileObj?.provider
    || "claude-code";
  const profileSummary = effectiveProvider;

  const toggleManual = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSetupChange({ ...setupState, useManualSetup: !setupState.useManualSetup });
  };

  useEffect(() => {
    setupStateRef.current = setupState;
  }, [setupState]);

  const handleProviderChange = async (provider: string) => {
    const current = setupStateRef.current;

    if (!provider) {
      onSetupChange({
        ...current,
        agent: {
          ...current.agent,
          provider: "",
          model: "",
        },
      });
      return;
    }

    const shouldSeedModel = provider !== selectedProfileData?.provider;
    const initialModel = shouldSeedModel ? providerSeedModel(provider) : "";
    onSetupChange({
      ...current,
      agent: {
        ...current.agent,
        provider,
        model: initialModel,
      },
    });

    if (!shouldSeedModel) return;

    try {
      const models = await fetchProviderModels(provider);
      const seededModel = models[0]?.id ?? initialModel;
      if (!seededModel) return;
      const latest = setupStateRef.current;
      if (latest.agent.provider !== provider) return;
      if (latest.agent.model === seededModel) return;
      onSetupChange({
        ...latest,
        agent: {
          ...latest.agent,
          provider,
          model: seededModel,
        },
      });
    } catch {
      // Keep the lightweight fallback model if model discovery fails.
    }
  };

  return (
    <div className={`profile-panel ${!setupState.useManualSetup ? "profile-panel--disabled" : ""}`}>
      <button
        className="profile-panel-header"
        onClick={() => setConfigExpanded(!configExpanded)}
      >
        <div className="profile-panel-left">
          <span className="profile-panel-name">{selectedProfile}</span>
          <span className="profile-panel-summary">{profileSummary}</span>
        </div>
        <div className="profile-panel-right">
          {overrideTags.length > 0 && setupState.useManualSetup && (
            <span className="profile-panel-overrides">
              {overrideTags.map((t) => (
                <span key={t} className="override-tag">{t}*</span>
              ))}
            </span>
          )}
          <label className="manual-toggle" onClick={toggleManual} title={setupState.useManualSetup ? "Manual seeding enabled" : "Inheriting from active chat"}>
            <input type="checkbox" checked={setupState.useManualSetup} readOnly />
          </label>
          <span className={`profile-panel-chevron ${configExpanded ? "profile-panel-chevron--open" : ""}`}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M3 4l2 2.5L7 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        </div>
      </button>

      <div className={`panel-collapse ${configExpanded ? "panel-collapse--open" : ""}`}>
        <div className="panel-collapse-clip">
          <div className={`profile-panel-body ${!setupState.useManualSetup ? "profile-panel-body--disabled" : ""}`}>
            <label className="agent-config-field">
              <span>profile</span>
              <SearchDropdown
                className="search-dropdown--compact"
                value={selectedProfile}
                options={profiles.map((p) => ({ value: p.name }))}
                placeholder="select profile"
                searchPlaceholder="search profiles..."
                clearable={false}
                onChange={onSelectProfile}
              />
            </label>

            <label className="agent-config-field">
              <span>provider</span>
              <SearchDropdown
                className="search-dropdown--compact"
                value={setupState.agent.provider}
                options={(availableProviders ?? []).map((provider) => ({ value: provider }))}
                placeholder={selectedProfileData?.provider ?? activeUserProfileObj?.provider ?? "claude-code"}
                searchPlaceholder="search providers..."
                onChange={handleProviderChange}
              />
            </label>

            <SessionSetup
              config={setupState}
              profileTools={selectedProfileData?.tools ?? "all"}
              availableProviders={availableProviders}
              profileProvider={selectedProfileData?.provider}
              profileEffort={selectedProfileData?.effort}
              profileMaxTurns={selectedProfileData?.maxTurns}
              profileModel={selectedProfileData?.model}
              onChange={onSetupChange}
              projectPaths={
                activeUserProfileObj?.showAllProjectPaths && userProfiles
                  ? [...new Set(userProfiles.flatMap((u) => u.projects ?? []))]
                  : activeUserProfileObj?.projects
              }
              showAllProjectPaths={activeUserProfileObj?.showAllProjectPaths}
              onProjectInit={refreshProfiles}
              showAgentConfig={false}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
