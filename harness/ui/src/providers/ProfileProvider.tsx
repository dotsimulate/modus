import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import type { Profile, ProviderCapabilities, UserProfile, UserProfileState, CreateSessionOpts } from "../api";
import {
  fetchProfiles, fetchProviderCapabilities, fetchProviders, fetchUserProfiles, fetchUserProfileState,
  patchUserProfileStateApi,
} from "../api";
import { createDefaultSetupState, type SessionSetupState } from "../components/SessionSetup";
import { agentConfigToOverrides } from "../components/AgentConfig";
import { addRecentPath } from "../recentPaths";

const USER_PROFILE_KEY = "harness:active-user-profile";

function resolvePreferredProfile(
  names: string[],
  lastAgentProfile?: string,
  defaultAgentProfile?: string,
): string {
  if (!names.length) return "";
  if (lastAgentProfile && names.includes(lastAgentProfile)) return lastAgentProfile;
  if (defaultAgentProfile && names.includes(defaultAgentProfile)) return defaultAgentProfile;
  return names[0] ?? "";
}

type ProfileContextValue = {
  profiles: Profile[];
  visibleProfiles: Profile[];
  availableProviders: string[];
  providerCapabilities: Record<string, ProviderCapabilities>;
  userProfiles: UserProfile[];
  activeUserProfile: string | null;
  activeUP: UserProfile | null;
  activeCwd: string | undefined;
  selectedProfile: string;
  selectProfile: (name: string) => void;
  setSelectedProfile: (name: string) => void;
  setupState: SessionSetupState;
  setSetupState: React.Dispatch<React.SetStateAction<SessionSetupState>>;
  uiState: UserProfileState;
  saveUiState: (patch: Partial<UserProfileState>) => void;
  switchUserProfile: (name: string | null) => void;
  refreshProfiles: () => Promise<void>;
  refreshUserProfiles: () => Promise<void>;
  buildSessionOpts: (prompt: string, profile?: string, seed?: SessionSetupState) => CreateSessionOpts;
};

const ProfileContext = createContext<ProfileContextValue>(null!);
export const useProfiles = () => useContext(ProfileContext);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [providerCapabilities, setProviderCapabilities] = useState<Record<string, ProviderCapabilities>>({});
  const [selectedProfile, setSelectedProfile] = useState("");
  const [userProfiles, setUserProfiles] = useState<UserProfile[]>([]);
  const [activeUserProfile, setActiveUserProfile] = useState<string | null>(
    () => localStorage.getItem(USER_PROFILE_KEY),
  );
  const [uiState, setUiState] = useState<UserProfileState>({});
  const uiSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [setupState, setSetupState] = useState<SessionSetupState>(createDefaultSetupState());

  // Derived
  const activeUP = userProfiles.find((p) => p.name === activeUserProfile) ?? null;
  const visibleProfiles = activeUP?.agentProfiles?.length
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

  // Refresh agent profiles from server (scoped to current CWD for project-local merging)
  const refreshProfiles = useCallback(async () => {
    const cwd = setupState.cwd.trim() || undefined;
    const p = await fetchProfiles(cwd);
    setProfiles(p);
  }, [setupState.cwd]);

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
  const buildSessionOpts = useCallback((prompt: string, profile?: string, seed?: SessionSetupState): CreateSessionOpts => {
    const source = seed ?? setupState;
    const profileData = profiles.find((p) => p.name === profile);
    const agentOverrides = agentConfigToOverrides(
      source.agent,
      profileData?.tools ?? "all",
    );
    const cwd = source.cwd.trim();
    if (cwd) addRecentPath(cwd);
    return {
      prompt,
      profile,
      ...(activeUserProfile ? { userProfile: activeUserProfile } : {}),
      ...(cwd ? { cwd } : {}),
      loadProjectSettings: source.loadProjectSettings,
      ...agentOverrides,
    };
  }, [setupState, profiles, activeUserProfile]);

  // Initial load
  useEffect(() => {
    const loadInitial = async () => {
      try {
        const [up, prov, caps] = await Promise.all([
          fetchUserProfiles(),
          fetchProviders(),
          fetchProviderCapabilities(),
        ]);
        setUserProfiles(up);
        setAvailableProviders(prov);
        setProviderCapabilities(Object.fromEntries(caps.map((cap) => [cap.name, cap])));

        // Resolve CWD before profile fetch so project-local profiles are included
        const activeUp = up.find((u) => u.name === activeUserProfile);
        let initialCwd = activeUp?.projects?.[0] ?? "";

        if (activeUserProfile) {
          const state = await fetchUserProfileState(activeUserProfile);
          setUiState(state);
          initialCwd = state.lastCwd ?? initialCwd;
          if (initialCwd) setSetupState((prev) => ({ ...prev, cwd: initialCwd }));
        } else if (initialCwd) {
          setSetupState((prev) => ({ ...prev, cwd: initialCwd }));
        }

        // Fetch profiles with resolved CWD for project-local merging
        const p = await fetchProfiles(initialCwd || undefined);
        setProfiles(p);
      } catch { /* silent — health check will catch */ }
    };
    loadInitial();
  }, []);

  // Reload profiles when CWD changes (project-local profiles may differ)
  const prevCwdRef = useRef<string>("");
  useEffect(() => {
    const cwd = setupState.cwd.trim();
    if (cwd === prevCwdRef.current) return;
    prevCwdRef.current = cwd;
    fetchProfiles(cwd || undefined).then(setProfiles).catch(() => {});
  }, [setupState.cwd]);

  // Reload when user profile changes
  useEffect(() => {
    setSelectedProfile("");
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
      }
    }).catch(() => {});
  }, [activeUserProfile]);

  useEffect(() => {
    const availableNames = visibleProfiles.map((profile) => profile.name);
    if (!availableNames.length) {
      if (selectedProfile) setSelectedProfile("");
      return;
    }
    if (selectedProfile && availableNames.includes(selectedProfile)) return;
    const nextProfile = resolvePreferredProfile(
      availableNames,
      uiState.lastAgentProfile,
      activeUP?.defaultAgentProfile,
    );
    if (nextProfile !== selectedProfile) setSelectedProfile(nextProfile);
  }, [activeUP?.defaultAgentProfile, selectedProfile, uiState.lastAgentProfile, visibleProfiles]);

  return (
    <ProfileContext.Provider value={{
      profiles, visibleProfiles, availableProviders, userProfiles,
      providerCapabilities,
      activeUserProfile, activeUP,
      activeCwd: setupState.cwd.trim() || undefined,
      selectedProfile, selectProfile, setSelectedProfile,
      setupState, setSetupState,
      uiState, saveUiState, switchUserProfile, refreshProfiles, refreshUserProfiles,
      buildSessionOpts,
    }}>
      {children}
    </ProfileContext.Provider>
  );
}
