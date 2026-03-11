import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import {
  createSession, sendMessage as apiSendMessage, stopSessionApi, stopTaskApi,
  archiveSessionApi, fetchSessions, fetchSessionsScoped,
  createEmptySession, getDraft, saveDraft,
  updateSessionConfig, respondToPermission, nextMsgId,
  branchSessionApi, switchSessionProfile,
} from "../api";
import type { Session, SessionInfo, Attachment, ApiAttachment } from "../api";
import { createInitialState } from "../eventReducer";
import {
  agentConfigToOverrides,
  agentConfigToUpdatePayload,
  createEmptyAgentConfig,
  isAgentConfigEqual,
  type AgentConfigState,
} from "../components/AgentConfig";
import { useProfiles } from "./ProfileProvider";
import {
  useSessionState, setSessionState, getSessionState,
  setSessionNextAgentConfig,
  setSessionNextProfile,
  subscribeSession, unsubscribeSession, isSubscribed,
  rekeySession, removeSession,
} from "../sessionStore";

export type QueuedMessage = {
  text: string;
  attachments: Attachment[];
};

type SessionContextValue = {
  activeSession: Session | null;
  serverSessions: SessionInfo[];
  input: string;
  handleInputChange: (text: string) => void;
  send: (attachments: Attachment[]) => Promise<void>;
  stop: () => Promise<void>;
  stopTask: (taskId: string) => Promise<void>;
  newSession: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  archiveSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  handlePermissionResponse: (
    requestId: string,
    behavior: "allow" | "deny",
    updatedInput?: Record<string, unknown>,
    scope?: "once" | "session",
  ) => Promise<void>;
  queuedMessage: QueuedMessage | null;
  cancelQueued: () => void;
  updateActiveSessionConfig: (config: AgentConfigState) => Promise<void>;
  updateActiveSessionProfile: (profile: string) => void;
  branchFromMessage: (seq: number, prefill?: string) => Promise<void>;
};

const SessionContext = createContext<SessionContextValue>(null!);
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const {
    selectedProfile, profiles, buildSessionOpts, setupState, activeUserProfile,
    setSelectedProfile,
  } = useProfiles();

  const [serverSessions, setServerSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [queuedMessage, setQueuedMessage] = useState<QueuedMessage | null>(null);

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevActiveStatusRef = useRef<Session["status"] | null>(null);

  const [pendingHashId, setPendingHashId] = useState<string | null>(() => {
    // Extract session UUID from hash: #profile/uuid or #uuid
    const raw = window.location.hash.replace(/^#\/?/, "");
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const slash = raw.indexOf("/");
    const candidate = slash >= 0 ? raw.slice(slash + 1) : raw;
    return UUID_RE.test(candidate) ? candidate : null;
  });

  // Derive activeSession from the store
  const activeSession = useSessionState(activeSessionId);

  const hasPendingProfileChange = useCallback((session: Session | null) => (
    !!session?.nextProfile && session.nextProfile !== session.profile
  ), []);

  const getQueuedAgentConfig = useCallback((session: Session | null, liveConfig: AgentConfigState) => {
    if (session?.nextAgentConfig) return session.nextAgentConfig;
    if (hasPendingProfileChange(session)) return createEmptyAgentConfig();
    return liveConfig;
  }, [hasPendingProfileChange]);

  const getLockedSessionProvider = useCallback((session: Session | null) => {
    if (!session) return undefined;
    if (session.agentConfig.provider) return session.agentConfig.provider;
    return profiles.find((p) => p.name === session.profile)?.provider;
  }, [profiles]);

  const profileProviderMatchesSession = useCallback((session: Session | null, profileName?: string) => {
    const lockedProvider = getLockedSessionProvider(session);
    const targetProvider = profiles.find((p) => p.name === profileName)?.provider;
    return !lockedProvider || !targetProvider || lockedProvider === targetProvider;
  }, [getLockedSessionProvider, profiles]);

  const getProfileToolsForStartedSession = useCallback((session: Session | null, profileName?: string) => {
    const targetProfile = profiles.find((p) => p.name === profileName);
    if (!session || profileProviderMatchesSession(session, profileName)) {
      return targetProfile?.tools ?? "all";
    }
    const currentProfile = profiles.find((p) => p.name === session.profile);
    return currentProfile?.tools ?? "all";
  }, [profileProviderMatchesSession, profiles]);

  const resolveAppliedModel = useCallback((
    config: AgentConfigState,
    session: Session | null,
    profileName?: string,
    fallback?: string,
  ) => {
    if (config.model.trim()) return config.model;
    if (!profileProviderMatchesSession(session, profileName)) return fallback ?? "";
    const profile = profiles.find((p) => p.name === profileName);
    return profile?.model ?? fallback ?? "";
  }, [profileProviderMatchesSession, profiles]);

  const updateActiveSessionProfile = useCallback((profile: string) => {
    if (!activeSessionId) return;
    const nextProfile = profile.trim();
    const currentProfile = activeSession?.profile ?? "";
    const pendingProfile = nextProfile && nextProfile !== currentProfile ? nextProfile : undefined;
    setSessionNextProfile(activeSessionId, pendingProfile);
    setSessionNextAgentConfig(activeSessionId, undefined);
  }, [activeSession?.profile, activeSessionId]);

  // ── Refresh sessions ──

  const refreshSessions = useCallback(async () => {
    try {
      const s = activeUserProfile
        ? await fetchSessionsScoped(50, activeUserProfile)
        : await fetchSessions();
      setServerSessions(s);
    } catch { /* silent */ }
  }, [activeUserProfile]);

  // Load sessions on mount + poll every 10s for status updates
  useEffect(() => {
    refreshSessions();
    const interval = setInterval(refreshSessions, 10_000);
    return () => clearInterval(interval);
  }, [refreshSessions]);

  useEffect(() => {
    const prev = prevActiveStatusRef.current;
    const next = activeSession?.status ?? null;
    if (
      prev
      && (prev === "running" || prev === "starting")
      && next
      && (next === "idle" || next === "error")
    ) {
      refreshSessions();
    }
    prevActiveStatusRef.current = next;
  }, [activeSession?.status, refreshSessions]);

  // ── URL hash sync ──

  const updateHash = useCallback((id: string | null) => {
    if (id && !id.startsWith("pending-")) {
      const profile = activeUserProfile ?? "";
      const hash = profile ? `${profile}/${id}` : id;
      window.history.replaceState(null, "", `#${hash}`);
    } else {
      // Keep profile in URL even when no session
      const profile = activeUserProfile ?? "";
      window.history.replaceState(null, "", profile ? `#${profile}` : window.location.pathname);
    }
  }, [activeUserProfile]);

  // ── Draft management ──

  const saveDraftForCurrent = useCallback(async (text?: string) => {
    if (activeSessionId && !activeSessionId.startsWith("pending-")) {
      await saveDraft(activeSessionId, text ?? input).catch(() => {});
    }
  }, [activeSessionId, input]);

  const handleInputChange = useCallback((text: string) => {
    setInput(text);
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    if (activeSessionId && !activeSessionId.startsWith("pending-")) {
      draftTimerRef.current = setTimeout(() => {
        saveDraft(activeSessionId, text).catch(() => {});
      }, 1000);
    }
  }, [activeSessionId]);

  // ── Session actions ──

  const getEffectiveSeed = useCallback(() => {
    if (!setupState.useManualSetup && activeSession && !activeSession.id.startsWith("pending-")) {
      // Inherit EXACTLY what's in the Config Bar (current or pending changes)
      return {
        profile: activeSession.nextProfile ?? activeSession.profile ?? (selectedProfile || undefined),
        agent: activeSession.nextAgentConfig ?? activeSession.agentConfig,
        cwd: activeSession.cwd || setupState.cwd,
        loadProjectSettings: activeSession.loadProjectSettings ?? setupState.loadProjectSettings,
      };
    }
    return {
      profile: selectedProfile || undefined,
      agent: setupState.agent,
      cwd: setupState.cwd,
      loadProjectSettings: setupState.loadProjectSettings,
    };
  }, [setupState, activeSession, selectedProfile]);

  const newSession = useCallback(async () => {
    await saveDraftForCurrent();

    const seed = getEffectiveSeed();
    const profile = seed.profile;
    try {
      const id = await createEmptySession(
        profile,
        seed.agent.model || undefined,
        seed.agent.provider || undefined,
      );
      const rs = createInitialState(id);
      rs.status = "idle";
      rs.agentConfig = seed.agent;
      rs.model = seed.agent.model;
      rs.cwd = seed.cwd;
      rs.loadProjectSettings = seed.loadProjectSettings;
      setSessionState(id, rs, profile);
      setActiveSessionId(id);
      updateHash(id);
      refreshSessions();
    } catch {
      setActiveSessionId(null);
      updateHash(null);
    }

    setInput("");
    setQueuedMessage(null);
  }, [updateHash, saveDraftForCurrent, refreshSessions, getEffectiveSeed]);

  const selectSession = useCallback(async (id: string) => {
    await saveDraftForCurrent();

    const info = serverSessions.find((s) => s.id === id);
    const sessionProfile = info?.profile ?? undefined;

    // Reuse existing store entry if available, otherwise create fresh
    const existing = getSessionState(id);
    if (!existing) {
      const rs = createInitialState(id);
      rs.status = (info?.status as Session["status"]) ?? "idle";
      rs.model = info?.model ?? "";
      rs.cwd = info?.cwd ?? "";
      setSessionState(id, rs, sessionProfile);
    }
    setActiveSessionId(id);

    // Subscribe from last known seq (avoids full replay if store has state)
    const afterSeq = existing?.lastSeq ?? 0;
    if (!isSubscribed(id)) {
      subscribeSession(id, afterSeq, sessionProfile, refreshSessions);
    }

    if (sessionProfile) setSelectedProfile(sessionProfile);
    updateHash(id);

    const draft = await getDraft(id).catch(() => "");
    setInput(draft);

    setQueuedMessage(null);
  }, [serverSessions, updateHash, saveDraftForCurrent, setSelectedProfile, refreshSessions]);

  const archiveSession = useCallback(async (id: string) => {
    await archiveSessionApi(id).catch(() => {});
    if (activeSessionId === id) {
      unsubscribeSession(id);
      removeSession(id);
      newSession();
    }
    refreshSessions();
  }, [activeSessionId, newSession, refreshSessions]);

  // ── Send message ──

  const send = useCallback(async (sendAttachments: Attachment[]) => {
    const prompt = input.trim();
    if (!prompt && sendAttachments.length === 0) return;
    setInput("");

    if (activeSessionId) saveDraft(activeSessionId, "").catch(() => {});

    const apiAtts: ApiAttachment[] | undefined = sendAttachments.length > 0
      ? sendAttachments.map((a) => ({ type: a.type, mediaType: a.mediaType, data: a.data, name: a.name }))
      : undefined;

    const currentState = activeSessionId ? getSessionState(activeSessionId) : null;
    const activeServerSession = activeSessionId
      ? serverSessions.find((session) => session.id === activeSessionId)
      : null;
    const hasPersistedHistory = !!activeServerSession?.preview || (currentState?.lastSeq ?? 0) > 0;
    const isEmptySession = activeSessionId
      && currentState?.status === "idle"
      && currentState.messages.length === 0
      && !hasPersistedHistory;
    const needsNewSession = !activeSessionId || !currentState || currentState.status === "done" || currentState.status === "error" || activeSessionId.startsWith("pending-") || isEmptySession;
    if (needsNewSession) {
      if (isEmptySession && activeSessionId) archiveSessionApi(activeSessionId).catch(() => {});

      const seedState = getEffectiveSeed();
      const queuedProfile = seedState.profile;
      const queuedAgentConfig = seedState.agent;

      const rs = createInitialState();
      rs.messages.push({
        id: nextMsgId(), role: "user", content: prompt, timestamp: Date.now(),
        attachments: sendAttachments.length > 0 ? sendAttachments : undefined,
      });
      rs.status = "starting";
      rs.agentConfig = seedState.agent;
      rs.model = resolveAppliedModel(seedState.agent, null, queuedProfile);
      rs.cwd = seedState.cwd;
      rs.loadProjectSettings = seedState.loadProjectSettings;
      const tempId = rs.sessionId;
      setSessionState(tempId, rs, queuedProfile);
      setActiveSessionId(tempId);

      try {
        const opts = buildSessionOpts(prompt, queuedProfile, seedState as any);
        if (apiAtts) opts.attachments = apiAtts;
        const { sessionId: realId } = await createSession(opts);

        rekeySession(tempId, realId);
        setSessionNextProfile(realId, undefined);
        setSessionNextAgentConfig(realId, undefined);
        setActiveSessionId(realId);
        updateHash(realId);
        subscribeSession(realId, 0, queuedProfile, refreshSessions);
        refreshSessions();
      } catch (err) {
        const errState = getSessionState(tempId);
        if (errState) {
          const updated = { ...errState, status: "error" as const };
          updated.messages = [...updated.messages, { id: nextMsgId(), role: "assistant" as const, content: `Error: ${err}` }];
          setSessionState(tempId, updated, queuedProfile);
        }
      }
    } else {
      // Follow-up to existing session
      const isActive = currentState.status === "running" || currentState.status === "starting";

      if (isActive) {
        // Model is mid-turn — queue for later
        setQueuedMessage({ text: prompt, attachments: sendAttachments });
        return;
      }

      let effectiveProfile = activeSession?.profile;
      try {
        const hasPendingProfile = hasPendingProfileChange(activeSession);
        const nextTurnConfig = getQueuedAgentConfig(activeSession, currentState.agentConfig);
        if (hasPendingProfile && activeSession?.nextProfile) {
          await switchSessionProfile(activeSessionId!, activeSession.nextProfile);
          effectiveProfile = activeSession.nextProfile;
        }
        if (activeSession?.nextAgentConfig) {
          await updateSessionConfig(activeSessionId!, {
            ...agentConfigToUpdatePayload(
              nextTurnConfig,
              getProfileToolsForStartedSession(activeSession, effectiveProfile),
            ),
            cwd: currentState.cwd,
            loadProjectSettings: currentState.loadProjectSettings,
          });
        }
        const rs = getSessionState(activeSessionId!) ?? currentState;
        const updated = {
          ...rs,
          status: "running" as const,
          agentConfig: nextTurnConfig,
          model: resolveAppliedModel(nextTurnConfig, activeSession, effectiveProfile, rs.model),
        };
        updated.messages = [...updated.messages, {
          id: nextMsgId(), role: "user" as const, content: prompt, timestamp: Date.now(),
          attachments: sendAttachments.length > 0 ? sendAttachments : undefined,
        }];
        setSessionState(activeSessionId!, updated, effectiveProfile);
        setSessionNextProfile(activeSessionId!, undefined);
        setSessionNextAgentConfig(activeSessionId!, undefined);

        const overrides = agentConfigToOverrides(
          nextTurnConfig,
          getProfileToolsForStartedSession(activeSession, effectiveProfile),
        );
        await apiSendMessage(activeSessionId!, prompt, apiAtts, {
          profile: effectiveProfile,
          provider: overrides.provider,
          model: overrides.model,
          effort: overrides.effort,
          maxTurns: overrides.maxTurns,
          tools: overrides.tools,
          disallowedTools: overrides.disallowedTools,
          toolStates: overrides.toolStates,
          providerControls: overrides.providerControls,
          cwd: rs.cwd,
          loadProjectSettings: rs.loadProjectSettings,
        });
        if (!isSubscribed(activeSessionId!)) {
          const latest = getSessionState(activeSessionId!);
          subscribeSession(activeSessionId!, latest?.lastSeq ?? 0, effectiveProfile, refreshSessions);
        }
      } catch (err) {
        const latest = getSessionState(activeSessionId!);
        if (latest) {
          const errState = { ...latest };
          errState.messages = [...errState.messages, { id: nextMsgId(), role: "assistant" as const, content: `Error: ${err}` }];
          setSessionState(activeSessionId!, errState, effectiveProfile);
        }
      }
    }
  }, [
    input,
    activeSession,
    activeSessionId,
    selectedProfile,
    buildSessionOpts,
    getQueuedAgentConfig,
    getProfileToolsForStartedSession,
    getLockedSessionProvider,
    hasPendingProfileChange,
    profileProviderMatchesSession,
    updateHash,
    refreshSessions,
    resolveAppliedModel,
    setupState,
    profiles,
    serverSessions,
  ]);

  // ── Auto-send queued message when model finishes ──

  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (!queuedMessage) return;
    if (!activeSession) return;
    const status = activeSession.status;
    if (status === "running" || status === "starting") return;
    // Model finished — flush the queued message
    const { text, attachments } = queuedMessage;
    setQueuedMessage(null);
    setInput(text);
    // Defer send to next tick so input state is set
    setTimeout(() => sendRef.current(attachments), 0);
  }, [activeSession?.status, queuedMessage]);

  const cancelQueued = useCallback(() => {
    if (!queuedMessage) return;
    // Restore text back to input
    setInput(queuedMessage.text);
    setQueuedMessage(null);
  }, [queuedMessage]);

  const stop = useCallback(async () => {
    if (activeSessionId) {
      await stopSessionApi(activeSessionId).catch(() => {});
      const rs = getSessionState(activeSessionId);
      if (rs) {
        setSessionState(activeSessionId, { ...rs, status: "idle" }, activeSession?.profile);
      }
    }
  }, [activeSessionId, activeSession?.profile]);

  const stopTask = useCallback(async (taskId: string) => {
    if (activeSessionId) {
      await stopTaskApi(activeSessionId, taskId).catch(() => {});
    }
  }, [activeSessionId]);

  const handlePermissionResponse = useCallback(async (
    requestId: string,
    behavior: "allow" | "deny",
    updatedInput?: Record<string, unknown>,
    scope?: "once" | "session",
  ) => {
    if (!activeSessionId) return;
    await respondToPermission(activeSessionId, { requestId, behavior, updatedInput, scope }).catch(() => {});
  }, [activeSessionId]);

  // ── Auto-load session from URL hash ──

  useEffect(() => {
    if (pendingHashId) {
      selectSession(pendingHashId);
      setPendingHashId(null);
    }
  }, [pendingHashId, selectSession]);

  const updateActiveSessionConfig = useCallback(async (config: AgentConfigState) => {
    if (!activeSessionId) return;
    const baseline = hasPendingProfileChange(activeSession)
      ? createEmptyAgentConfig()
      : (activeSession?.agentConfig ?? createEmptyAgentConfig());
    setSessionNextAgentConfig(
      activeSessionId,
      isAgentConfigEqual(config, baseline) ? undefined : config,
    );
  }, [activeSession, activeSessionId, hasPendingProfileChange]);

  const branchFromMessage = useCallback(async (seq: number, prefill?: string) => {
    if (!activeSessionId) return;
    try {
      // Branch at seq-1: copy everything before this user message
      const branchAt = prefill ? Math.max(1, seq - 1) : seq;
      const newId = await branchSessionApi(activeSessionId, branchAt);
      await refreshSessions();
      await selectSession(newId);
      if (prefill) setInput(prefill);
    } catch (err) {
      console.error("Branch failed:", err);
    }
  }, [activeSessionId, selectSession, refreshSessions]);

  return (
    <SessionContext.Provider value={{
      activeSession, serverSessions,
      input, handleInputChange,
      send, stop, stopTask, newSession, selectSession, archiveSession,
      refreshSessions, handlePermissionResponse,
      queuedMessage, cancelQueued, updateActiveSessionConfig, updateActiveSessionProfile,
      branchFromMessage,
    }}>
      {children}
    </SessionContext.Provider>
  );
}
