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
  profiles: Profile[],
  lastAgentProfile?: string,
  defaultAgentProfile?: string,
): string {
  if (!profiles.length) return "";
  const resolveReference = (reference?: string) => {
    if (!reference) return undefined;
    const exact = profiles.find((profile) => profile.name === reference);
    if (exact) return exact.name;
    const matches = profiles.filter((profile) => profile.displayName === reference);
    return matches.find((profile) => profile.origin === "project")?.name
      ?? matches.find((profile) => profile.origin === "user")?.name
      ?? matches[0]?.name;
  };
  return resolveReference(lastAgentProfile)
    ?? resolveReference(defaultAgentProfile)
    ?? profiles[0]!.name;
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
  //   - PROJECT-LOCAL profiles (in `<cwd>/.modus/profiles/agents/`) ALWAYS appear.
  //   - Manifest-exposed PLUGIN profiles appear globally unless explicitly suppressed.
  //     they're scoped to this project by definition. Hiding them was a bug: our
  //     scaffolding moves (create-profile, etc.) write to `.modus/` and users expected
  //     those to show up without manually editing the user profile's whitelist.
  //   - Sorted by most recently used profile first (uiState.lastAgentProfile), then the
  //     rest in their original order.
  const visibleProfiles = useMemo(() => {
    const lastProfile = activeUP ? uiState.lastAgentProfile : undefined;
    const hiddenPluginProfiles = new Set(activeUP?.hiddenPluginProfiles ?? []);
    let result = activeUP?.agentProfiles?.length
      ? profiles.filter((p) =>
          p.origin === "project"
          || (p.origin === "plugin" && !hiddenPluginProfiles.has(p.name))
          || activeUP.agentProfiles!.includes(p.name)
          || (!!p.displayName && activeUP.agentProfiles!.includes(p.displayName)))
      : profiles.filter((p) => p.origin !== "plugin" || !hiddenPluginProfiles.has(p.name));
    if (lastProfile) {
      const lastIdx = result.findIndex((p) => p.name === lastProfile || p.displayName === lastProfile);
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
  const themeCwd = projectRoot || setupState.cwd.trim() || undefined;

  // Switch user profile
  const switchUserProfile = useCallback((name: string | null) => {
    if (name) {
      localStorage.setItem(USER_PROFILE_KEY, name);
    } else {
      localStorage.removeItem(USER_PROFILE_KEY);
    }
    setActiveUserProfile(name);
  }, []);

  /**
   * Fetch agent profiles with their UI config resolved server-side.
   *
   * This used to list profiles and then request `getProfileUiConfig` once per
   * profile — 1+N round trips, re-run on every project-root change, which is what
   * made themes and profile-driven UI settle seconds after everything else. The
   * server resolves all of it from local config in one pass.
   */
  const listProfilesWithUi = useCallback(async (cwd?: string): Promise<Profile[]> => {
    try {
      return await modus.listProfiles(cwd, { includeUi: true });
    } catch {
      // Older backend, or the batch call failed: fall back to the per-profile
      // path so a remote client pointed at a stale harness still works.
      const items = await modus.listProfiles(cwd);
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
    }
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

  /** Same batching as {@link listProfilesWithUi}; client extensions ride in this payload. */
  const listUserProfilesWithUi = useCallback(async (): Promise<UserProfile[]> => {
    try {
      return await modus.listUserProfiles({ includeUi: true });
    } catch {
      return hydrateUserProfilesWithUi(await modus.listUserProfiles());
    }
  }, [hydrateUserProfilesWithUi]);

  // Refresh agent profiles from server — always scoped to project root
  const refreshProfiles = useCallback(async () => {
    const cwd = projectRoot || setupState.cwd.trim() || undefined;
    setProfiles(await listProfilesWithUi(cwd));
  }, [listProfilesWithUi, projectRoot, setupState.cwd]);

  // Refresh user profiles from server
  const refreshUserProfiles = useCallback(async () => {
    const ups = await listUserProfilesWithUi();
    setUserProfiles(ups);
  }, [listUserProfilesWithUi]);

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
    const profileData = profiles.find((p) => p.name === profile || p.displayName === profile);
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
          listUserProfilesWithUi(),
          modus.listProviders(),
          modus.getProviderCapabilities(),
        ]);
        setUserProfiles(up);
        setAvailableProviders(prov);
        const capabilitiesByName: Record<string, ProviderCapabilities> = {};
        for (const cap of caps) {
          capabilitiesByName[cap.name] = cap;
          for (const alias of cap.aliases ?? []) capabilitiesByName[alias] = cap;
        }
        setProviderCapabilities(capabilitiesByName);

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
        setProfiles(await listProfilesWithUi(initialCwd || undefined));
      } catch { /* silent — health check will catch */ }
    };
    loadInitial();
  }, [activeUserProfile, listProfilesWithUi, listUserProfilesWithUi]);

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
    listProfilesWithUi(cwd || undefined)
      .then(setProfiles)
      .catch(() => {});
  }, [listProfilesWithUi, projectRoot, setupState.cwd]);

  // Apply project theme — always from project root, not a profile subfolder
  useEffect(() => {
    loadAndApplyProjectUiState(themeCwd, "profile-project");
  }, [themeCwd]);

  // Reload when user profile changes
  useEffect(() => {
    setSelectedProfile("");
    Promise.all([
      listUserProfilesWithUi(),
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
  }, [activeUserProfile, listUserProfilesWithUi]);

  useEffect(() => {
    if (!visibleProfiles.length) {
      if (selectedProfile) setSelectedProfile("");
      return;
    }
    if (selectedProfile && visibleProfiles.some((profile) => profile.name === selectedProfile)) return;
    const nextProfile = resolvePreferredProfile(
      visibleProfiles,
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
    const profileAdditional = profileData?.additionalDirectories ?? [];
    const combineAdditional = (...groups: Array<string[] | undefined>) =>
      [...new Set(groups.flatMap((group) => group ?? []).filter((entry) => entry.trim()))];
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
        additionalDirectories: combineAdditional(profileAdditional, suggestions),
      }));
    } else if (profileData?.cwdSuggestions && profileData.cwdSuggestions.length > 0) {
      setSetupState((prev) => ({
        ...prev,
        cwd: profileData!.cwdSuggestions![0],
        additionalDirectories: combineAdditional(
          profileAdditional,
          profileData!.cwdSuggestions!.slice(1),
        ),
      }));
    } else {
      const defaultCwd = projectRoot;
      setSetupState((prev) => ({
        ...prev,
        cwd: defaultCwd || prev.cwd,
        additionalDirectories: profileAdditional,
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
