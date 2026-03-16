/**
 * useSessionComposer — shared data/logic layer for session creation and configuration.
 *
 * Encapsulates profile resolution, config derivation, and session creation.
 * Any UI surface (chat page, web view, floating panel) can use this hook
 * to get everything ConfigBar and ChatInput need.
 *
 * Two modes:
 *   1. **Active session** — pass session state, profile is resolved from session
 *   2. **Pre-session** — no session, profile is resolved from selection
 */

import { useState, useCallback } from "react";
import { useProfiles } from "../providers/ProfileProvider";
import { createEmptyAgentConfig, type AgentConfigState } from "../components/AgentConfig";
import { createSession, createEmptySession } from "../api/sessions";
import type { Profile } from "../api/types";

// ── Types ──

/** Minimal session shape — what we need for profile resolution */
export type ComposerSessionState = {
  id?: string;
  profile?: string;
  provider?: string;
  model?: string;
  status?: string;
  messages: { role: string }[];
  agentConfig: AgentConfigState;
  nextProfile?: string;
  nextAgentConfig?: AgentConfigState;
  availableTools?: string[];
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  totalCost?: number;
};

/** Server-side session info (from sessions list) */
export type ComposerServerSession = {
  id: string;
  provider?: string | null;
};

export type SessionComposerResult = {
  // ── Profile resolution (ConfigBar props) ──
  activeProfileName: string;
  profileData: Profile | undefined;
  editorProfileName: string;
  editorProfileData: Profile | undefined;
  liveProvider: string | undefined;
  liveModel: string;
  editorProfileProvider: string | undefined;
  editorProfileModel: string | undefined;
  sessionProviderLocked: boolean;
  pendingProfileProviderMatches: boolean;
  editorAgentConfig: AgentConfigState;
  profileEffort: string | undefined;
  editorProfileEffort: string | undefined;
  editorProfileMaxTurns: number | undefined;

  // ── Profile lists ──
  profiles: Profile[];
  visibleProfiles: Profile[];
  availableProviders: string[];

  // ── Pre-session config editing ──
  selectedProfile: string;
  selectProfile: (name: string) => void;
  agentConfig: AgentConfigState;
  setAgentConfig: (config: AgentConfigState) => void;

  // ── Session creation ──
  createAndSend: (prompt: string, opts?: {
    profile?: string;
    attachments?: Array<{ type: string; mediaType?: string; data?: string; name?: string }>;
  }) => Promise<{ sessionId: string }>;
  createEmpty: (profile?: string) => Promise<{ sessionId: string }>;

  // ── Context ──
  projectCwd: string | undefined;
  userProfile: string | undefined;
};

export function useSessionComposer(
  /** Active session state (pass null for pre-session mode) */
  session?: ComposerSessionState | null,
  /** Server session info (for provider resolution from DB) */
  serverSessionInfo?: ComposerServerSession | null,
): SessionComposerResult {
  const {
    profiles, visibleProfiles, availableProviders,
    activeUserProfile, activeUP,
    selectedProfile: globalSelectedProfile, selectProfile: globalSelectProfile,
  } = useProfiles();

  // ── Local pre-session state ──
  const [localSelectedProfile, setLocalSelectedProfile] = useState<string | null>(null);
  const [localAgentConfig, setLocalAgentConfig] = useState<AgentConfigState>(() => createEmptyAgentConfig());

  // ── Profile resolution ──
  // If we have an active session, use its profile. Otherwise use local selection
  // or fall back to the global selected profile.
  const selectedProfile = session?.profile ?? localSelectedProfile ?? globalSelectedProfile;
  const selectProfile = useCallback((name: string) => {
    if (session) {
      // Active session mode — delegate to global (which triggers SessionProvider)
      globalSelectProfile(name);
    } else {
      setLocalSelectedProfile(name);
      // Reset agent config when switching profiles in pre-session mode
      setLocalAgentConfig(createEmptyAgentConfig());
    }
  }, [session, globalSelectProfile]);

  const activeProfileName = session?.profile ?? selectedProfile;
  const profileData = profiles.find(p => p.name === activeProfileName);

  const editorProfileName = session?.nextProfile ?? activeProfileName;
  const editorProfileData = profiles.find(p => p.name === editorProfileName);

  const sessionProviderLocked = !!session && session.messages.length > 0;
  const liveProvider = serverSessionInfo?.provider
    || session?.provider
    || profileData?.provider
    || activeUP?.provider;
  const liveModel = session?.model || profileData?.model || activeUP?.model || "";
  const editorProfileProvider = editorProfileData?.provider ?? activeUP?.provider;
  const editorProfileModel = editorProfileData?.model ?? activeUP?.model;
  const pendingProfileProviderMatches = !sessionProviderLocked
    || !liveProvider
    || !editorProfileProvider
    || editorProfileProvider === liveProvider;

  const editorAgentConfig = session
    ? (session.nextAgentConfig
      ?? (session.nextProfile && session.nextProfile !== session.profile
        ? createEmptyAgentConfig()
        : session.agentConfig)
    )
    : localAgentConfig;

  const agentConfig = session?.agentConfig ?? localAgentConfig;

  const profileEffort = session
    ? (profileData?.effort ?? activeUP?.effort)
    : (activeUP?.effort ?? profileData?.effort);
  const editorProfileEffort = session
    ? (editorProfileData?.effort ?? activeUP?.effort)
    : (activeUP?.effort ?? editorProfileData?.effort);

  const projectCwd = activeUP?.projects?.[0];

  // ── Session creation ──
  const createAndSend = useCallback(async (
    prompt: string,
    opts?: {
      profile?: string;
      attachments?: Array<{ type: string; mediaType?: string; data?: string; name?: string }>;
    },
  ) => {
    const profile = opts?.profile ?? activeProfileName;
    const result = await createSession({
      prompt,
      profile: profile || undefined,
      userProfile: activeUserProfile ?? undefined,
      cwd: projectCwd ?? undefined,
      attachments: opts?.attachments,
      provider: localAgentConfig.provider || undefined,
      model: localAgentConfig.model || undefined,
      effort: localAgentConfig.effort || undefined,
      maxTurns: localAgentConfig.maxTurns || undefined,
      toolStates: Object.keys(localAgentConfig.toolStates).length > 0
        ? localAgentConfig.toolStates : undefined,
    });
    return { sessionId: result.sessionId };
  }, [activeProfileName, activeUserProfile, projectCwd, localAgentConfig]);

  const createEmpty = useCallback(async (profile?: string) => {
    const sessionId = await createEmptySession({
      profile: profile ?? activeProfileName ?? undefined,
      userProfile: activeUserProfile ?? undefined,
      cwd: projectCwd ?? undefined,
    });
    return { sessionId };
  }, [activeProfileName, activeUserProfile, projectCwd]);

  return {
    activeProfileName,
    profileData,
    editorProfileName,
    editorProfileData,
    liveProvider,
    liveModel,
    editorProfileProvider,
    editorProfileModel,
    sessionProviderLocked,
    pendingProfileProviderMatches,
    editorAgentConfig,
    profileEffort,
    editorProfileEffort,
    editorProfileMaxTurns: editorProfileData?.maxTurns,

    profiles,
    visibleProfiles,
    availableProviders,

    selectedProfile,
    selectProfile,
    agentConfig,
    setAgentConfig: session ? (() => {}) : setLocalAgentConfig,

    createAndSend,
    createEmpty,

    projectCwd,
    userProfile: activeUserProfile ?? undefined,
  };
}
