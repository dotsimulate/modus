import { useState, useCallback, useEffect, useRef } from "react";
import { modus } from "../modusClient";
import { nextMsgId } from "../../../sdk/index";
import type { Session, SessionInfo, Attachment, ApiAttachment, MoveBinding } from "../../../sdk/index";
import { createInitialState } from "../eventReducer";
import {
  agentConfigToOverrides,
  agentConfigToUpdatePayload,
  createEmptyAgentConfig,
  isAgentConfigEqual,
  type AgentConfigState,
} from "../components/AgentConfig";
import { useProfiles } from "./ProfileContext";
import {
  useSessionState, setSessionState, getSessionState,
  setSessionNextAgentConfig,
  setSessionNextProfile,
  hydrateSessionHistorySnapshot,
  subscribeSession, unsubscribeSession, isSubscribed,
  rekeySession, removeSession, evictInactiveSessions, onSessionRekey,
} from "../sessionStore";
import { loadAndApplyProjectUiState } from "../project-ui-theme";
import { SessionContext } from "./SessionContext";

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const {
    selectedProfile, profiles, buildSessionOpts, setupState, activeUserProfile, activeUP,
  } = useProfiles();

  const [serverSessions, setServerSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [queuedMessage, setQueuedMessage] = useState<QueuedMessage | null>(null);

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevActiveStatusRef = useRef<Session["status"] | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const applyUserDefaultAgentConfig = useCallback((agent: AgentConfigState): AgentConfigState => ({
    ...agent,
    effort: agent.effort.trim() || activeUP?.effort || "",
  }), [activeUP?.effort]);

  const resolveProfileProvider = useCallback((profileName?: string) => {
    const profile = profiles.find((p) => p.name === profileName);
    return profile?.provider ?? activeUP?.provider;
  }, [activeUP?.provider, profiles]);

  const getLockedSessionProvider = useCallback((session: Session | null) => {
    if (!session) return undefined;
    if (session.agentConfig.provider) return session.agentConfig.provider;
    return resolveProfileProvider(session.profile);
  }, [resolveProfileProvider]);

  const profileProviderMatchesSession = useCallback((session: Session | null, profileName?: string) => {
    const lockedProvider = getLockedSessionProvider(session);
    const targetProvider = resolveProfileProvider(profileName);
    return !lockedProvider || !targetProvider || lockedProvider === targetProvider;
  }, [getLockedSessionProvider, resolveProfileProvider]);

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
    return profile?.model ?? activeUP?.model ?? fallback ?? "";
  }, [activeUP?.model, profileProviderMatchesSession, profiles]);

  const updateActiveSessionProfile = useCallback((profile: string) => {
    if (!activeSessionId) return;
    const nextProfile = profile.trim();
    const currentProfile = activeSession?.profile ?? "";
    const pendingProfile = nextProfile && nextProfile !== currentProfile ? nextProfile : undefined;
    setSessionNextProfile(activeSessionId, pendingProfile);
  }, [activeSession?.profile, activeSessionId]);

  // ── Refresh sessions ──

  const refreshSessions = useCallback(async () => {
    try {
      const s = activeUserProfile
        ? await modus.listSessions({ limit: 50, userProfile: activeUserProfile })
        : await modus.listSessions({ limit: 50 });
      if (!Array.isArray(s)) {
        console.error("[refreshSessions] non-array response", s);
        return;
      }
      setServerSessions(s);
      setSessionsLoaded(true);
    } catch (err) {
      console.error("[refreshSessions] failed", err);
    }
  }, [activeUserProfile]);

  const scheduleRefreshSessions = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refreshSessions();
    }, 150);
  }, [refreshSessions]);

  // Load sessions on mount + slow fallback poll.
  useEffect(() => {
    refreshSessions();
    const interval = setInterval(refreshSessions, 60_000);
    return () => {
      clearInterval(interval);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [refreshSessions]);

  // Prefer backend session lifecycle SSE over periodic polling.
  useEffect(() => {
    let cancelled = false;
    const handle = modus.subscribeGlobalEvents();
    (async () => {
      try {
        for await (const _evt of handle.events) {
          if (cancelled) break;
          scheduleRefreshSessions();
        }
      } catch {
        // Fallback poll remains active.
      }
    })();
    return () => {
      cancelled = true;
      handle.abort();
    };
  }, [scheduleRefreshSessions]);

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
      loadAndApplyProjectUiState(activeSession?.cwd || undefined);
    }
    prevActiveStatusRef.current = next;
  }, [activeSession?.cwd, activeSession?.status, refreshSessions]);

  // ── URL hash sync ──

  const updateHash = useCallback((id: string | null) => {
    const profile = activeUserProfile ?? "";
    if (id && !id.startsWith("pending-")) {
      const hash = profile ? `${profile}/${id}` : id;
      window.location.hash = hash;
    } else {
      const hash = profile ? `${profile}/chat` : "chat";
      window.location.hash = hash;
    }
  }, [activeUserProfile]);

  const rekeyLinkedSessionState = useCallback((oldId: string, newId: string) => {
    if (!oldId || !newId || oldId === newId) return;
    modus.rekeyMoveSession(oldId, newId).catch((e) => {
      console.error(`[session] rekeyMoveSession FAILED:`, e);
    });
    modus.rekeyTerminalSession(oldId, newId).catch((e) => {
      console.error(`[session] rekeyTerminalSession FAILED:`, e);
    });
  }, []);

  // ── Auto-rekey: when a provider's init event changes the session ID (ses-* → UUID),
  // update the active session ID and URL hash so the UI stays in sync.
  useEffect(() => {
    return onSessionRekey((oldId, newId) => {
      rekeyLinkedSessionState(oldId, newId);
      setActiveSessionId((current) => {
        if (current === oldId) {
          updateHash(newId);
          return newId;
        }
        return current;
      });
    });
  }, [rekeyLinkedSessionState, updateHash]);

  // ── Draft management ──

  const saveDraftForCurrent = useCallback(async (text?: string) => {
    if (activeSessionId && !activeSessionId.startsWith("pending-")) {
      await modus.saveDraft(activeSessionId, text ?? input).catch(() => {});
    }
  }, [activeSessionId, input]);

  const handleInputChange = useCallback((text: string) => {
    setInput(text);
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    if (activeSessionId && !activeSessionId.startsWith("pending-")) {
      draftTimerRef.current = setTimeout(() => {
        modus.saveDraft(activeSessionId, text).catch(() => {});
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
        additionalDirectories: activeSession.additionalDirectories ?? setupState.additionalDirectories,
        loadProjectSettings: activeSession.loadProjectSettings ?? setupState.loadProjectSettings,
      };
    }
    return {
      profile: selectedProfile || undefined,
      agent: applyUserDefaultAgentConfig(setupState.agent),
      cwd: setupState.cwd,
      additionalDirectories: setupState.additionalDirectories,
      loadProjectSettings: setupState.loadProjectSettings,
    };
  }, [setupState, activeSession, selectedProfile, applyUserDefaultAgentConfig]);

  const getSendSeed = useCallback((sessionState: ReturnType<typeof getSessionState> | null) => {
    if (activeSession && !activeSession.id.startsWith("pending-")) {
      // Use the session's own profile — never fall back to selectedProfile
      // (the sidebar seed). If the session has no profile, use user default.
      const sessionOwnProfile = activeSession.nextProfile
        ?? activeSession.profile
        ?? activeUP?.defaultAgentProfile
        ?? (selectedProfile || undefined);
      return {
        profile: sessionOwnProfile,
        agent: getQueuedAgentConfig(activeSession, sessionState?.agentConfig ?? activeSession.agentConfig),
        cwd: sessionState?.cwd || activeSession.cwd || setupState.cwd,
        additionalDirectories: sessionState?.additionalDirectories ?? activeSession.additionalDirectories ?? setupState.additionalDirectories,
        loadProjectSettings: sessionState?.loadProjectSettings ?? activeSession.loadProjectSettings ?? setupState.loadProjectSettings,
      };
    }
    return getEffectiveSeed();
  }, [activeSession, activeUP?.defaultAgentProfile, getEffectiveSeed, getQueuedAgentConfig, selectedProfile, setupState.cwd, setupState.additionalDirectories, setupState.loadProjectSettings]);

  const newSession = useCallback(async () => {
    await saveDraftForCurrent();

    const seed = getEffectiveSeed();
    const profile = seed.profile;
    const resolvedProvider = seed.agent.provider.trim() || resolveProfileProvider(profile);
    const resolvedModel = resolveAppliedModel(seed.agent, null, profile);
    try {
      const id = await modus.createEmptySession({
        profile,
        model: resolvedModel || undefined,
        provider: resolvedProvider || undefined,
        cwd: seed.cwd || undefined,
        userProfile: activeUserProfile ?? undefined,
      });
      const rs = createInitialState(id);
      rs.status = "idle";
      rs.agentConfig = seed.agent;
      rs.model = resolvedModel;
      rs.cwd = seed.cwd;
      rs.additionalDirectories = seed.additionalDirectories ?? [];
      rs.loadProjectSettings = seed.loadProjectSettings;
      setSessionState(id, rs, profile);
      setActiveSessionId(id);
      evictInactiveSessions(id);
      await refreshSessions();
      setInput("");
      setQueuedMessage(null);
      return id;
    } catch {
      setActiveSessionId(null);
      setInput("");
      setQueuedMessage(null);
      return null;
    }
  }, [activeUserProfile, getEffectiveSeed, refreshSessions, resolveAppliedModel, resolveProfileProvider, saveDraftForCurrent]);

  const selectSession = useCallback(async (id: string) => {
    // Set up the new session SYNCHRONOUSLY before any async work.
    // This prevents a render gap where activeSession is stale/null and
    // the ConfigBar falls back to the sidebar's selectedProfile.
    const info = serverSessions.find((s) => s.id === id);
    const sessionProfile = info?.profile ?? undefined;

    const existing = getSessionState(id);
    if (!existing) {
      const rs = createInitialState(id);
      rs.status = (info?.status as Session["status"]) ?? "idle";
      rs.model = info?.model ?? "";
      rs.cwd = info?.cwd ?? "";
      setSessionState(id, rs, sessionProfile);
    } else {
      const updatedState = !existing.model && info?.model
        ? { ...existing, model: info.model }
        : existing;
      setSessionState(id, updatedState, sessionProfile);
    }
    setActiveSessionId(id);

    // Save draft for previous session (fire-and-forget — uses captured refs
    // from the previous render, so it saves the OLD session's draft).
    saveDraftForCurrent();

    // Evict old inactive sessions from the store to free memory
    evictInactiveSessions(id);

    let afterSeq = existing?.lastSeq ?? 0;
    const shouldHydrateHistory = !!info?.status
      && info.status !== "running"
      && info.status !== "starting"
      && info.status !== "paused";

    if (shouldHydrateHistory) {
      try {
        const snapshot = await modus.getSessionHistorySnapshot(id);
        const hasAssistantToolCalls = snapshot.messages.some((msg) => (
          msg.role === "assistant" && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0
        ));
        if (hasAssistantToolCalls) {
          const rs = createInitialState(id);
          rs.status = (info?.status as Session["status"]) ?? "idle";
          rs.model = info?.model ?? "";
          rs.cwd = info?.cwd ?? "";
          setSessionState(id, rs, sessionProfile);
          afterSeq = 0;
        } else {
          const latest = getSessionState(id);
          // Skip empty snapshots — the backend maps idle sessions to "done"
          // which would overwrite fresh "idle" state and break needsNewSession.
          const isSnapshotMeaningful = snapshot.messages.length > 0 || snapshot.lastSeq > 0;
          const shouldApplySnapshot = isSnapshotMeaningful
            && (!latest
              || snapshot.lastSeq > latest.lastSeq
              || snapshot.messages.length >= latest.messages.length);
          if (shouldApplySnapshot) {
            hydrateSessionHistorySnapshot(snapshot, sessionProfile);
            afterSeq = snapshot.lastSeq;
          } else {
            afterSeq = latest?.lastSeq ?? 0;
          }
        }
      } catch {
        // Fall back to event replay if snapshot hydration fails.
      }
    }

    // Subscribe from last known seq (avoids full replay if store has state)
    if (!isSubscribed(id)) {
      subscribeSession(id, afterSeq, sessionProfile, refreshSessions);
    }

    // NOTE: do NOT write selectedProfile here. selectedProfile is the sidebar's
    // seed for the next new session (Domain B) and must not be contaminated by
    // which session the user navigates to (Domain A).

    const draft = await modus.getDraft(id).catch(() => "");
    setInput(draft);

    setQueuedMessage(null);
  }, [serverSessions, saveDraftForCurrent, refreshSessions]);

  const archiveSession = useCallback(async (id: string) => {
    await modus.archiveSession(id).catch(() => {});
    if (activeSessionId === id) {
      unsubscribeSession(id);
      removeSession(id);
      newSession();
    }
    refreshSessions();
  }, [activeSessionId, newSession, refreshSessions]);

  // ── Send message ──

  const send = useCallback(async (sendAttachments: Attachment[], textOverride?: string, moves?: MoveBinding[]) => {
    const prompt = (textOverride ?? input).trim();
    if (!prompt && sendAttachments.length === 0) return;

    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }

    setInput("");

    if (activeSessionId) modus.saveDraft(activeSessionId, "").catch(() => {});

    const apiAtts: ApiAttachment[] | undefined = sendAttachments.length > 0
      ? sendAttachments.map((a) => ({ type: a.type, mediaType: a.mediaType, data: a.data, name: a.name }))
      : undefined;

    const currentState = activeSessionId ? getSessionState(activeSessionId) : null;
    const activeServerSession = activeSessionId
      ? serverSessions.find((session) => session.id === activeSessionId)
      : null;
    const hasPersistedHistory = !!activeServerSession?.preview || (currentState?.lastSeq ?? 0) > 0;
    const isEmptySession = sessionsLoaded && activeSessionId
      && currentState?.status === "idle"
      && currentState.messages.length === 0
      && !hasPersistedHistory;
    const needsNewSession = !activeSessionId || !currentState || activeSessionId.startsWith("pending-") || isEmptySession;
    if (needsNewSession) {
      const prevSessionId = activeSessionId; // capture before archiving — move registry may reference this
      if (isEmptySession && activeSessionId) modus.archiveSession(activeSessionId).catch(() => {});

      const seedState = getSendSeed(currentState);
      const queuedProfile = seedState.profile;

      const rs = createInitialState();
      rs.messages.push({
        id: nextMsgId(), role: "user", content: prompt, timestamp: Date.now(),
        attachments: sendAttachments.length > 0 ? sendAttachments : undefined,
      });
      rs.status = "starting";
      rs.agentConfig = seedState.agent;
      rs.model = resolveAppliedModel(seedState.agent, null, queuedProfile);
      rs.cwd = seedState.cwd;
      rs.additionalDirectories = seedState.additionalDirectories ?? [];
      rs.loadProjectSettings = seedState.loadProjectSettings;
      const tempId = rs.sessionId;
      setSessionState(tempId, rs, queuedProfile);
      setActiveSessionId(tempId);

      try {
        const opts = buildSessionOpts(prompt, queuedProfile, seedState as any);
        if (apiAtts) opts.attachments = apiAtts;
        const { sessionId: realId } = await modus.createSession(opts);

        rekeySession(tempId, realId);
        // Rekey move registry — mountOnAttach moves registered with empty sessionId
        // need an explicit rekey from "" since prevSessionId/tempId won't match them
        modus.rekeyMoveSession("", realId).catch(() => {});
        const linkedOldIds = new Set<string>();
        if (prevSessionId) linkedOldIds.add(prevSessionId);
        linkedOldIds.add(tempId);
        for (const oldId of linkedOldIds) {
          rekeyLinkedSessionState(oldId, realId);
        }
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
        // Commit to backend queue immediately — survives page navigation
        modus.sendMessage(activeSessionId!, prompt, apiAtts, moves ? { moves } : undefined)
          .then((result) => {
            setQueuedMessage({
              text: prompt,
              attachments: sendAttachments,
              serverQueued: true,
              dispatchId: result.dispatchId,
            });
          })
          .catch(() => {});
        return;
      }

      let effectiveProfile = activeSession?.profile;
      try {
        const hasPendingProfile = hasPendingProfileChange(activeSession);
        const nextTurnConfig = getQueuedAgentConfig(activeSession, currentState.agentConfig);
        if (hasPendingProfile && activeSession?.nextProfile) {
          await modus.switchProfile(activeSessionId!, activeSession.nextProfile);
          effectiveProfile = activeSession.nextProfile;
        }
        if (activeSession?.nextAgentConfig) {
          await modus.updateConfig(activeSessionId!, {
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
        await modus.sendMessage(activeSessionId!, prompt, apiAtts, {
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
          additionalDirectories: rs.additionalDirectories.length > 0 ? rs.additionalDirectories : undefined,
          loadProjectSettings: rs.loadProjectSettings,
          moves,
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
    getSendSeed,
    getProfileToolsForStartedSession,
    getLockedSessionProvider,
    hasPendingProfileChange,
    profileProviderMatchesSession,
    rekeyLinkedSessionState,
    updateHash,
    refreshSessions,
    resolveAppliedModel,
    resolveProfileProvider,
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
    if (queuedMessage.serverQueued) {
      // Already committed to backend — backend will process it; just clear the display
      setQueuedMessage(null);
      return;
    }
    // Legacy path: was queued frontend-only (shouldn't happen with new flow)
    const { text, attachments } = queuedMessage;
    setQueuedMessage(null);
    setInput(text);
    setTimeout(() => sendRef.current(attachments), 0);
  }, [activeSession?.status, queuedMessage]);

  const cancelQueued = useCallback(() => {
    if (!queuedMessage) return;
    if (queuedMessage.serverQueued && queuedMessage.dispatchId && activeSessionId) {
      modus.cancelQueuedDispatch(activeSessionId, queuedMessage.dispatchId).catch(() => {});
    }
    // Restore text back to input
    setInput(queuedMessage.text);
    setQueuedMessage(null);
  }, [activeSessionId, queuedMessage]);

  const stop = useCallback(async () => {
    if (activeSessionId) {
      await modus.stopSession(activeSessionId).catch(() => {});
      const rs = getSessionState(activeSessionId);
      if (rs) {
        setSessionState(activeSessionId, { ...rs, status: "idle" }, activeSession?.profile);
      }
    }
  }, [activeSessionId, activeSession?.profile]);

  const stopTask = useCallback(async (taskId: string) => {
    if (activeSessionId) {
      await modus.stopTask(activeSessionId, taskId).catch(() => {});
    }
  }, [activeSessionId]);

  const handlePermissionResponse = useCallback(async (
    requestId: string,
    behavior: "allow" | "deny",
    updatedInput?: Record<string, unknown>,
    scope?: "once" | "session",
  ) => {
    if (!activeSessionId) return;
    await modus.respondToPermission(activeSessionId, { requestId, behavior, updatedInput, scope }).catch(() => {});
  }, [activeSessionId]);

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
      const newId = await modus.branchSession(activeSessionId, branchAt);
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
