import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import type { Profile, UserProfile, UserProfileState, CreateSessionOpts } from "../api";
import {
  fetchProfiles, fetchProviders, fetchUserProfiles, fetchUserProfileState,
  patchUserProfileStateApi,
} from "../api";
import { createDefaultSetupState, type SessionSetupState } from "../components/SessionSetup";
import { agentConfigToOverrides, type AgentConfigState } from "../components/AgentConfig";
import { addRecentPath } from "../recentPaths";

const USER_PROFILE_KEY = "harness:active-user-profile";

type ProfileContextValue = {
  profiles: Profile[];
  visibleProfiles: Profile[];
  availableProviders: string[];
  userProfiles: UserProfile[];
  activeUserProfile: string | null;
  activeUP: UserProfile | null;
  selectedProfile: string;
  selectProfile: (name: string) => void;
  setSelectedProfile: (name: string) => void;
  setupState: SessionSetupState;
  setSetupState: React.Dispatch<React.SetStateAction<SessionSetupState>>;
  liveAgentConfig: AgentConfigState;
  setLiveAgentConfig: React.Dispatch<React.SetStateAction<AgentConfigState>>;
  uiState: UserProfileState;
  saveUiState: (patch: Partial<UserProfileState>) => void;
  switchUserProfile: (name: string | null) => void;
  refreshProfiles: () => Promise<void>;
  refreshUserProfiles: () => Promise<void>;
  buildSessionOpts: (prompt: string, profile?: string) => CreateSessionOpts;
};

const ProfileContext = createContext<ProfileContextValue>(null!);
export const useProfiles = () => useContext(ProfileContext);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("test-harness");
  const [userProfiles, setUserProfiles] = useState<UserProfile[]>([]);
  const [activeUserProfile, setActiveUserProfile] = useState<string | null>(
    () => localStorage.getItem(USER_PROFILE_KEY),
  );
  const [uiState, setUiState] = useState<UserProfileState>({});
  const uiSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [setupState, setSetupState] = useState<SessionSetupState>(createDefaultSetupState());
  const [liveAgentConfig, setLiveAgentConfig] = useState<AgentConfigState>({
    toolStates: {},
    provider: "",
    effort: "",
    maxTurns: "",
  });

  // Derived
  const activeUP = userProfiles.find((p) => p.name === activeUserProfile) ?? null;
  const visibleProfiles = activeUP?.agentProfiles
    ? profiles.filter((p) => activeUP.agentProfiles!.includes(p.name))
    : profiles;

  // Switch user profile
  const switchUserProfile = useCallback((name: string | null) => {
    if (name) {
      localStorage.setItem(USER_PROFILE_KEY, name);
    } else {
      localStorage.removeItem(USER_PROFILE_KEY);
    }
    setActiveUserProfile(name);
  }, []);

  // Refresh agent profiles from server
  const refreshProfiles = useCallback(async () => {
    const p = await fetchProfiles();
    setProfiles(p);
  }, []);

  // Refresh user profiles from server
  const refreshUserProfiles = useCallback(async () => {
    const ups = await fetchUserProfiles();
    setUserProfiles(ups);
  }, []);

  // Debounced UI state save
  const saveUiState = useCallback((patch: Partial<UserProfileState>) => {
    if (!activeUserProfile) return;
    if (uiSaveTimer.current) clearTimeout(uiSaveTimer.current);
    uiSaveTimer.current = setTimeout(() => {
      patchUserProfileStateApi(activeUserProfile, patch).catch(() => {});
    }, 500);
  }, [activeUserProfile]);

  // Select profile — persists to user profile state
  const selectProfile = useCallback((name: string) => {
    setSelectedProfile(name);
    saveUiState({ lastAgentProfile: name });
  }, [saveUiState]);

  // Build session creation opts from current setup state
  const buildSessionOpts = useCallback((prompt: string, profile?: string): CreateSessionOpts => {
    const profileData = profiles.find((p) => p.name === profile);
    const agentOverrides = agentConfigToOverrides(
      setupState.agent,
      profileData?.tools ?? "all",
    );
    const cwd = setupState.cwd.trim();
    if (cwd) addRecentPath(cwd);
    return {
      prompt,
      profile,
      ...(setupState.model ? { model: setupState.model } : {}),
      ...(cwd ? { cwd } : {}),
      loadProjectSettings: setupState.loadProjectSettings,
      ...agentOverrides,
    };
  }, [setupState, profiles]);

  // Initial load
  useEffect(() => {
    const loadInitial = async () => {
      try {
        const [p, up, prov] = await Promise.all([fetchProfiles(), fetchUserProfiles(), fetchProviders()]);
        setProfiles(p);
        setUserProfiles(up);
        setAvailableProviders(prov);

        if (activeUserProfile) {
          const state = await fetchUserProfileState(activeUserProfile);
          setUiState(state);
          if (state.lastAgentProfile) setSelectedProfile(state.lastAgentProfile);
          const activeUp = up.find((u) => u.name === activeUserProfile);
          const defaultCwd = state.lastCwd ?? activeUp?.projects?.[0] ?? "";
          if (defaultCwd) setSetupState((prev) => ({ ...prev, cwd: defaultCwd }));
        } else {
          const activeUp = up.find((u) => u.name === activeUserProfile);
          if (activeUp?.projects?.[0]) {
            setSetupState((prev) => ({ ...prev, cwd: activeUp.projects![0] }));
          }
        }
      } catch { /* silent — health check will catch */ }
    };
    loadInitial();
  }, []);

  // Reload when user profile changes
  useEffect(() => {
    Promise.all([
      fetchUserProfiles(),
      activeUserProfile
        ? fetchUserProfileState(activeUserProfile)
        : Promise.resolve({} as UserProfileState),
    ]).then(([ups, state]) => {
      setUserProfiles(ups);
      setUiState(state);
      const up = ups.find((u) => u.name === activeUserProfile);
      if (up) {
        const cwd = state.lastCwd ?? up.projects?.[0] ?? "";
        setSetupState((prev) => ({ ...prev, cwd }));
        if (state.lastAgentProfile) setSelectedProfile(state.lastAgentProfile);
      }
    }).catch(() => {});
  }, [activeUserProfile]);

  return (
    <ProfileContext.Provider value={{
      profiles, visibleProfiles, availableProviders, userProfiles,
      activeUserProfile, activeUP,
      selectedProfile, selectProfile, setSelectedProfile,
      setupState, setSetupState,
      liveAgentConfig, setLiveAgentConfig,
      uiState, saveUiState, switchUserProfile, refreshProfiles, refreshUserProfiles,
      buildSessionOpts,
    }}>
      {children}
    </ProfileContext.Provider>
  );
}
