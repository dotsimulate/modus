import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type {
  ProfileUi, Profile, UserProfile, UserProfileState, UserProfileUiConfig,
  ProviderCapabilities, CreateSessionOpts,
} from "../../../sdk/index";
import { modus } from "../modusClient";
import { createDefaultSetupState, type SessionSetupState } from "../components/SessionSetup";
import { agentConfigToOverrides } from "../components/AgentConfig";
import { addRecentPath } from "../recentPaths";
import { loadAndApplyProjectUiState } from "../project-ui-theme";
import { applyInterfaceSettings, resolveInterfaceSettings } from "../interface-settings";
import { ProfileContext } from "./ProfileContext";
import { backendStorageKey } from "../backendTarget";

const USER_PROFILE_KEY = backendStorageKey("harness:active-user-profile");

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

function normalizeRootPath(value: string): string {
  const slashed = value.trim().replace(/\\/g, "/");
  const normalized = slashed === "/" ? "/" : slashed.replace(/\/+$/, "");
  return /^[A-Za-z]:(?:\/|$)/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function activeProjectRoot(roots: string[] | undefined, cwd: string): string {
  if (!roots?.length) return "";
  const candidate = normalizeRootPath(cwd);
  return [...roots]
    .filter((root) => {
      const boundary = normalizeRootPath(root);
      if (boundary === "/") return candidate.startsWith("/");
      return candidate === boundary || candidate.startsWith(`${boundary}/`);
    })
    .sort((a, b) => normalizeRootPath(b).length - normalizeRootPath(a).length)[0]
    ?? roots[0]
    ?? "";
}

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
  // Visibility rule:
  //   - When the active user profile has an `agentProfiles` whitelist, it constrains
  //     USER-HOME profiles (shared across projects — the user curates which show).
  //   - PROJECT-LOCAL profiles (in `<cwd>/.modus/profiles/agents/`) ALWAYS appear —
  //     they're scoped to this project by definition. Hiding them was a bug: our
  //     scaffolding moves (create-profile, etc.) write to `.modus/` and users expected
  //     those to show up without manually editing the user profile's whitelist.
  //   - Sorted by most recently used profile first (uiState.lastAgentProfile), then the
  //     rest in their original order.
  const visibleProfiles = useMemo(() => {
    const lastProfile = activeUP ? uiState.lastAgentProfile : undefined;
    let result = activeUP?.agentProfiles?.length
      ? profiles.filter((p) => p.origin === "project" || activeUP.agentProfiles!.includes(p.name))
      : profiles;
    if (lastProfile) {
      const lastIdx = result.findIndex((p) => p.name === lastProfile);
      if (lastIdx >= 0) {
        result = [result[lastIdx], ...result.slice(0, lastIdx), ...result.slice(lastIdx + 1)];
      }
    }
    return result;
  }, [profiles, activeUP, uiState.lastAgentProfile]);

  // Resolve the configured root containing the selected CWD. Multi-root projects
  // can load root-local profiles and themes without becoming separate projects.
  const projectRoot = useMemo(
    () => activeProjectRoot(activeUP?.projects, setupState.cwd),
    [activeUP?.projects, setupState.cwd],
  );

  // Switch user profile
  const switchUserProfile = useCallback((name: string | null) => {
    if (name) {
      localStorage.setItem(USER_PROFILE_KEY, name);
    } else {
      localStorage.removeItem(USER_PROFILE_KEY);
    }
    setActiveUserProfile(name);
  }, []);

  const hydrateProfilesWithUi = useCallback(async (items: Profile[], cwd?: string): Promise<Profile[]> => {
    const uiByName = Object.fromEntries(await Promise.all(items.map(async (profile) => {
      try {
        return [profile.name, await modus.getProfileUiConfig(profile.name, cwd)] as const;
      } catch {
        return [profile.name, profile.ui ?? {}] as const;
      }
    }))) as Record<string, ProfileUi>;
    return items.map((profile) => {
      const ui = uiByName[profile.name];
      return ui && Object.keys(ui).length > 0 ? { ...profile, ui } : profile;
    });
  }, []);

  const hydrateUserProfilesWithUi = useCallback(async (items: UserProfile[]): Promise<UserProfile[]> => {
    const uiByName = Object.fromEntries(await Promise.all(items.map(async (profile) => {
      try {
        return [profile.name, await modus.getUserProfileUiConfig(profile.name)] as const;
      } catch {
        const fallback: UserProfileUiConfig = {
          dashboard: profile.dashboard,
          leftPanel: profile.leftPanel,
          pageNav: profile.pageNav,
          layouts: profile.layouts,
          computer: profile.computer,
          editor: profile.editor,
          interface: profile.interface,
          clientExtensions: profile.clientExtensions,
        };
        return [profile.name, fallback] as const;
      }
    }))) as Record<string, UserProfileUiConfig>;
    return items.map((profile) => ({
      ...profile,
      ...uiByName[profile.name],
    }));
  }, []);

  // Refresh agent profiles from server — always scoped to project root
  const refreshProfiles = useCallback(async () => {
    const cwd = projectRoot || setupState.cwd.trim() || undefined;
    const p = await hydrateProfilesWithUi(await modus.listProfiles(cwd), cwd);
    setProfiles(p);
  }, [hydrateProfilesWithUi, projectRoot, setupState.cwd]);

  // Refresh user profiles from server
  const refreshUserProfiles = useCallback(async () => {
    const ups = await hydrateUserProfilesWithUi(await modus.listUserProfiles());
    setUserProfiles(ups);
  }, [hydrateUserProfilesWithUi]);

  // Debounced UI state save
  const saveUiState = useCallback((patch: Partial<UserProfileState>) => {
    if (!activeUserProfile) return;
    if (uiSaveTimer.current) clearTimeout(uiSaveTimer.current);
    uiSaveTimer.current = setTimeout(() => {
      modus.patchUserProfileState(activeUserProfile, patch).catch(() => {});
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
    // When the profile has a cwd override, send the project root as the session cwd.
    // The backend resolves the profile's cwd field against this root in startSession().
    // This ensures getProfile() can find the profile at the project root's .modus/.
    const cwd = (profileData?.cwd ? projectRoot : source.cwd.trim()) || source.cwd.trim();
    if (cwd) addRecentPath(cwd);
    const additionalDirs = (source.additionalDirectories ?? []).filter((d) => d.trim());
    return {
      prompt,
      profile,
      ...(activeUserProfile ? { userProfile: activeUserProfile } : {}),
      ...(cwd ? { cwd } : {}),
      ...(additionalDirs.length > 0 ? { additionalDirectories: additionalDirs } : {}),
      loadProjectSettings: source.loadProjectSettings,
      ...agentOverrides,
    };
  }, [setupState, profiles, activeUserProfile]);

  // Initial load
  useEffect(() => {
    const loadInitial = async () => {
      try {
        const [up, prov, caps] = await Promise.all([
          modus.listUserProfiles().then(hydrateUserProfilesWithUi),
          modus.listProviders(),
          modus.getProviderCapabilities(),
        ]);
        setUserProfiles(up);
        setAvailableProviders(prov);
        setProviderCapabilities(Object.fromEntries(caps.map((cap) => [cap.name, cap])));

        // Resolve CWD before profile fetch so project-local profiles are included
        const activeUp = up.find((u) => u.name === activeUserProfile);
        let initialCwd = activeUp?.projects?.[0] ?? "";

        if (activeUserProfile) {
          const state = await modus.getUserProfileState(activeUserProfile);
          setUiState(state);
          initialCwd = state.lastCwd ?? initialCwd;
          if (initialCwd) setSetupState((prev) => ({ ...prev, cwd: initialCwd }));
        } else if (initialCwd) {
          setSetupState((prev) => ({ ...prev, cwd: initialCwd }));
        }

        // Fetch profiles with resolved CWD for project-local merging
        const p = await hydrateProfilesWithUi(await modus.listProfiles(initialCwd || undefined), initialCwd || undefined);
        setProfiles(p);
      } catch { /* silent — health check will catch */ }
    };
    loadInitial();
  }, [activeUserProfile, hydrateProfilesWithUi, hydrateUserProfilesWithUi]);

  useEffect(() => {
    applyInterfaceSettings(resolveInterfaceSettings(activeUP?.interface));
  }, [activeUP?.interface]);

  // Reload profiles when project root changes (project-local profiles may differ).
  // Uses projectRoot, NOT setupState.cwd — a profile's subfolder cwd override
  // should not trigger a profile refetch that loses project-local profiles.
  const prevProjectRootRef = useRef<string>("");
  useEffect(() => {
    const cwd = projectRoot || setupState.cwd.trim();
    if (cwd === prevProjectRootRef.current) return;
    prevProjectRootRef.current = cwd;
    modus.listProfiles(cwd || undefined)
      .then((items) => hydrateProfilesWithUi(items, cwd || undefined))
      .then(setProfiles)
      .catch(() => {});
  }, [hydrateProfilesWithUi, projectRoot, setupState.cwd]);

  // Apply project theme — always from project root, not a profile subfolder
  useEffect(() => {
    const cwd = projectRoot || setupState.cwd.trim();
    loadAndApplyProjectUiState(cwd || undefined);
  }, [projectRoot, setupState.cwd]);

  // Reload when user profile changes
  useEffect(() => {
    setSelectedProfile("");
    Promise.all([
      modus.listUserProfiles().then(hydrateUserProfilesWithUi),
      activeUserProfile
        ? modus.getUserProfileState(activeUserProfile)
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
  }, [activeUserProfile, hydrateUserProfilesWithUi]);

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

  // When selected profile changes, auto-fill CWD from profile.cwd (hard default),
  // cwdSuggestions (soft hint), or the active configured project root (fallback).
  const prevSelectedProfileRef = useRef<string>("");
  useEffect(() => {
    if (selectedProfile === prevSelectedProfileRef.current) return;
    prevSelectedProfileRef.current = selectedProfile;
    const profileData = profiles.find((p) => p.name === selectedProfile);
    if (profileData?.cwd) {
      // Profile has a hard CWD — resolve relative paths and set into setupState.cwd
      // so the sidebar dropdown displays the session's working directory.
      const baseCwd = projectRoot;
      let resolved = profileData.cwd;
      if (resolved && !resolved.match(/^(?:\/|[A-Za-z]:)/)) {
        const sep = baseCwd.includes("\\") ? "\\" : "/";
        resolved = baseCwd ? `${baseCwd.replace(/[/\\]+$/, "")}${sep}${resolved.replace(/^\.\//, "").replace(/^\.\\/, "")}` : resolved;
      }
      const suggestions = profileData.cwdSuggestions;
      setSetupState((prev) => ({
        ...prev,
        cwd: resolved,
        additionalDirectories: suggestions?.slice(0) ?? [],
      }));
    } else if (profileData?.cwdSuggestions && profileData.cwdSuggestions.length > 0) {
      setSetupState((prev) => ({
        ...prev,
        cwd: profileData!.cwdSuggestions![0],
        additionalDirectories: profileData!.cwdSuggestions!.slice(1),
      }));
    } else {
      const defaultCwd = projectRoot;
      setSetupState((prev) => ({
        ...prev,
        cwd: defaultCwd || prev.cwd,
        additionalDirectories: [],
      }));
    }
  }, [selectedProfile, profiles, activeUP, projectRoot]);

  return (
    <ProfileContext.Provider value={{
      profiles, visibleProfiles, availableProviders, userProfiles,
      providerCapabilities,
      activeUserProfile, activeUP,
      activeCwd: setupState.cwd.trim() || projectRoot || undefined,
      projectRoot: projectRoot || setupState.cwd.trim() || undefined,
      selectedProfile, selectProfile, setSelectedProfile,
      setupState, setSetupState,
      uiState, saveUiState, switchUserProfile, refreshProfiles, refreshUserProfiles,
      buildSessionOpts,
    }}>
      {children}
    </ProfileContext.Provider>
  );
}
