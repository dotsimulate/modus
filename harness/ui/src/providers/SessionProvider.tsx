import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { modus } from "../modusClient";
import { nextMsgId } from "../../../sdk/index";
import { setInputValue, getInputValue, shouldApplyFetchedDraft } from "../inputStore";
import type {
  Session, SessionInfo, SessionProjectSummary, Attachment, MoveBinding, RewindPreview,
} from "../../../sdk/index";
import { toApiAttachments } from "../api-attachments";
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
  ensureSubscribed, unsubscribeSession,
  rekeySession, removeSession, evictInactiveSessions, onSessionRekey,
  useSessionHistoryLoadState, shouldRefetchEmptyResolvedHistory,
} from "../sessionStore";
import { loadAndApplyProjectUiState } from "../project-ui-theme";
import {
  refreshSessionIndex,
  subscribeSessionIndex,
  type SessionIndexConnectionState,
} from "../sessionIndexSync";
import { SessionContext, type QueuedMessage, type DeliverMode, type SendOpts } from "./SessionContext";

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const {
    selectedProfile, profiles, buildSessionOpts, setupState, activeUserProfile, activeUP,
    projectRoot,
  } = useProfiles();

  const [allServerSessions, setAllServerSessions] = useState<SessionInfo[]>([]);
  const [sessionProjects, setSessionProjects] = useState<SessionProjectSummary[]>([]);
  const [sessionIndexConnection, setSessionIndexConnection] = useState<SessionIndexConnectionState>({
    status: "offline",
    role: "standalone",
    lastEventAt: null,
    reconnects: 0,
  });
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [queuedMessage, setQueuedMessage] = useState<QueuedMessage | null>(null);
  const [rewindNotice, setRewindNotice] = useState<{
    sessionId: string;
    checkpointId: number;
    label: string;
    preview?: RewindPreview;
    busy?: boolean;
    error?: string;
  } | null>(null);

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevActiveStatusRef = useRef<Session["status"] | null>(null);
  const selectionRequestRef = useRef(0);

  const serverSessions = useMemo(() => (
    activeUserProfile
      ? allServerSessions.filter((session) => session.project_id === activeUserProfile)
      : allServerSessions
  ), [activeUserProfile, allServerSessions]);

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

  const applySessionIndex = useCallback((index: Awaited<ReturnType<typeof refreshSessionIndex>>) => {
    if (!Array.isArray(index.sessions)) return;
    setAllServerSessions(index.sessions);
    setSessionProjects(Array.isArray(index.projects) ? index.projects : []);
    setSessionsLoaded(true);
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      applySessionIndex(await refreshSessionIndex());
    } catch (err) {
      console.error("[refreshSessions] failed", err);
    }
  }, [applySessionIndex]);

  // Exactly one elected tab owns the lifecycle stream and fallback index poll.
  // Followers receive compact snapshots and live patches over BroadcastChannel.
  useEffect(() => subscribeSessionIndex(applySessionIndex, setSessionIndexConnection), [applySessionIndex]);

  useEffect(() => {
    const prev = prevActiveStatusRef.current;
    const next = activeSession?.status ?? null;
    if (
      prev
      && (prev === "running" || prev === "starting" || prev === "interrupting")
      && next
      && (next === "idle" || next === "error")
    ) {
      refreshSessions();
      loadAndApplyProjectUiState(projectRoot || undefined);
    }
    prevActiveStatusRef.current = next;
  }, [activeSession?.status, projectRoot, refreshSessions]);

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
      await modus.saveDraft(activeSessionId, text ?? getInputValue()).catch(() => {});
    }
  }, [activeSessionId]);

  const handleInputChange = useCallback((text: string) => {
    setInputValue(text);
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

  const newSession = useCallback(async (profileOverride?: string) => {
    await saveDraftForCurrent();

    const seed = getEffectiveSeed();
    const profile = profileOverride || seed.profile;
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
      // Deliberately no setInputValue("") here. The composer is keyed to the
      // active session and a brand-new id has no stored draft, so it already
      // paints empty. Clearing after an awaited refresh instead wiped whatever
      // the user had typed into the new chat while the list request was in
      // flight — seconds of typing, erased with no explanation.
      setQueuedMessage(null);
      return id;
    } catch {
      setActiveSessionId(null);
      setInputValue("");
      setQueuedMessage(null);
      return null;
    }
  }, [activeUserProfile, getEffectiveSeed, refreshSessions, resolveAppliedModel, resolveProfileProvider, saveDraftForCurrent]);

  const selectSession = useCallback(async (id: string) => {
    const selectionRequest = ++selectionRequestRef.current;
    const isStaleSelection = () => selectionRequestRef.current !== selectionRequest;

    // Set up the new session SYNCHRONOUSLY before any async work.
    // This prevents a render gap where activeSession is stale/null and
    // the ConfigBar falls back to the sidebar's selectedProfile.
    const info = allServerSessions.find((s) => s.id === id);
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

    // Park old inactive sessions and cap the warm transcript cache.
    evictInactiveSessions(id);

    // History and the draft are independent, so start both together — but do not
    // wait for history before applying the draft. History is a transcript fetch
    // that can take seconds on a cold, long, or remote session; the composer
    // paints immediately and the user starts typing into it. Awaiting both here
    // is what erased a half-written message several seconds after it was typed.
    const draftPromise = modus.getDraft(id).catch(() => "");
    const historyPromise = ensureSubscribed(id, {
      profile: sessionProfile,
      activeStatus: info?.status as Session["status"] | undefined,
      onDone: refreshSessions,
      forceHistoryRefresh: true,
    });

    // NOTE: do NOT write selectedProfile here. selectedProfile is the sidebar's
    // seed for the next new session (Domain B) and must not be contaminated by
    // which session the user navigates to (Domain A).

    const draft = await draftPromise;
    if (!isStaleSelection() && shouldApplyFetchedDraft(getInputValue())) setInputValue(draft);

    await historyPromise;
    if (isStaleSelection()) return;

    setQueuedMessage(null);
  }, [allServerSessions, saveDraftForCurrent, refreshSessions]);

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

  const send = useCallback(async (sendAttachments: Attachment[], textOverride?: string, moves?: MoveBinding[], deliver: DeliverMode = "queue", sendOpts?: SendOpts) => {
    const prompt = (textOverride ?? getInputValue()).trim();
    if (!prompt && sendAttachments.length === 0) return;

    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }

    setInputValue("");

    if (activeSessionId) modus.saveDraft(activeSessionId, "").catch(() => {});

    const apiAtts = toApiAttachments(sendAttachments);

    let currentState = activeSessionId ? getSessionState(activeSessionId) : null;
    const activeServerSession = activeSessionId
      ? allServerSessions.find((session) => session.id === activeSessionId)
      : null;

    // A selected persisted session can briefly have an empty local placeholder
    // while its history snapshot is still loading. Do not let that transient UI
    // state classify the session as a brand-new disposable draft.
    if (activeSessionId && !activeSessionId.startsWith("pending-") && !currentState?.messages.length && !(currentState?.lastSeq ?? 0)) {
      await ensureSubscribed(activeSessionId, {
        profile: activeServerSession?.profile ?? activeSession?.profile ?? undefined,
        activeStatus: activeServerSession?.status as Session["status"] | undefined,
        onDone: refreshSessions,
      }).catch(() => {});
      currentState = getSessionState(activeSessionId);
    }

    if (activeSessionId && !activeSessionId.startsWith("pending-") && !currentState) {
      const rs = createInitialState(activeSessionId);
      rs.status = (activeServerSession?.status as Session["status"]) ?? "idle";
      rs.model = activeServerSession?.model ?? "";
      rs.cwd = activeServerSession?.cwd ?? "";
      setSessionState(activeSessionId, rs, activeServerSession?.profile ?? activeSession?.profile ?? undefined);
      currentState = rs;
    }

    const hasPersistedHistory = (activeServerSession?.message_count ?? 0) > 0
      || !!activeServerSession?.preview
      || (currentState?.lastSeq ?? 0) > 0;
    const serverConfirmsEmpty = !!activeServerSession && activeServerSession.message_count === 0 && !activeServerSession.preview;
    const isEmptyStatus = currentState?.status === "idle"
      || (currentState?.status === "done" && serverConfirmsEmpty);
    const isEmptySession = sessionsLoaded && activeSessionId
      && currentState
      && isEmptyStatus
      && currentState.messages.length === 0
      && serverConfirmsEmpty
      && !hasPersistedHistory;
    const needsNewSession = !activeSessionId || activeSessionId.startsWith("pending-") || isEmptySession;
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
        // A move attached in the composer has to ride the create call: this
        // message is the session's first, so there is no sendMessage to carry
        // it. Without this the binding was silently dropped for new chats.
        if (moves?.length) opts.moves = moves;
        // Profile bindings the user removed after seeing what they would inject.
        if (sendOpts?.skipProfileMoves?.length) opts.skipProfileMoves = sendOpts.skipProfileMoves;
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
        void ensureSubscribed(realId, {
          profile: queuedProfile,
          activeStatus: "starting",
          onDone: refreshSessions,
        });
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
      const existingState = currentState!;
      const isActive = existingState.status === "running" || existingState.status === "starting" || existingState.status === "interrupting";

      if (isActive) {
        if (deliver === "steer") {
          // Interject into the turn in flight. On success the backend persists
          // and broadcasts the user message itself, so it arrives over SSE like
          // any other — nothing to stage here. Only a fallback to the queue
          // needs the pending strip, and it says so.
          modus.steerSession(activeSessionId!, prompt, apiAtts, moves)
            .then((result) => {
              if (result.mode === "queued") {
                setQueuedMessage({
                  text: prompt,
                  attachments: sendAttachments,
                  serverQueued: true,
                  dispatchId: result.dispatchId,
                  steerDeclined: true,
                });
              }
            })
            .catch(() => {});
          return;
        }
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
        const nextTurnConfig = getQueuedAgentConfig(activeSession, existingState.agentConfig);
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
            cwd: existingState.cwd,
            loadProjectSettings: existingState.loadProjectSettings,
          });
        }
        const rs = getSessionState(activeSessionId!) ?? existingState;
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
        void ensureSubscribed(activeSessionId!, {
          profile: effectiveProfile,
          activeStatus: "running",
          onDone: refreshSessions,
        });
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
    allServerSessions,
  ]);

  // ── Auto-send queued message when model finishes ──

  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (!queuedMessage) return;
    if (!activeSession) return;
    const status = activeSession.status;
    if (status === "running" || status === "starting" || status === "interrupting") return;
    if (queuedMessage.serverQueued) {
      // Already committed to backend — backend will process it; just clear the display
      setQueuedMessage(null);
      return;
    }
    // Legacy path: was queued frontend-only (shouldn't happen with new flow)
    const { text, attachments } = queuedMessage;
    setQueuedMessage(null);
    setInputValue(text);
    setTimeout(() => sendRef.current(attachments), 0);
  }, [activeSession?.status, queuedMessage]);

  // ── Self-heal a resolved-but-empty thread ──
  // Last-resort insurance for the "chat shows no messages until reload" class of
  // bug: the store thinks history is settled, nothing is on screen, but the
  // server index says this session has content. One forced refetch per session,
  // and it can never fire on a conversation that painted normally.

  const healedHistoryRef = useRef(new Set<string>());
  const activeHistoryLoad = useSessionHistoryLoadState(activeSessionId);

  useEffect(() => {
    if (!activeSessionId || !sessionsLoaded) return;
    const info = allServerSessions.find((session) => session.id === activeSessionId);
    if (!info) return;
    const shouldHeal = shouldRefetchEmptyResolvedHistory({
      historyStatus: activeHistoryLoad.status,
      messageCount: activeSession?.messages.length ?? 0,
      serverMessageCount: info.message_count,
      serverPreview: info.preview,
      alreadyAttempted: healedHistoryRef.current.has(activeSessionId),
    });
    if (!shouldHeal) return;
    healedHistoryRef.current.add(activeSessionId);
    void ensureSubscribed(activeSessionId, {
      profile: info.profile ?? undefined,
      forceHistoryRefresh: true,
      onDone: refreshSessions,
    }).catch(() => {});
  }, [
    activeSessionId,
    sessionsLoaded,
    allServerSessions,
    activeHistoryLoad.status,
    activeSession?.messages.length,
    refreshSessions,
  ]);

  const cancelQueued = useCallback(() => {
    if (!queuedMessage) return;
    if (queuedMessage.serverQueued && queuedMessage.dispatchId && activeSessionId) {
      modus.cancelQueuedDispatch(activeSessionId, queuedMessage.dispatchId).catch(() => {});
    }
    // Restore text back to input
    setInputValue(queuedMessage.text);
    setQueuedMessage(null);
  }, [activeSessionId, queuedMessage]);

  const stop = useCallback(async () => {
    if (activeSessionId) {
      await modus.stopSession(activeSessionId).catch(() => {});
      const rs = getSessionState(activeSessionId);
      if (rs) {
        setSessionState(activeSessionId, { ...rs, status: "interrupting" }, activeSession?.profile);
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

  const branchFromSessionMessage = useCallback(async (sourceSessionId: string, seq: number, prefill?: string, restoreCode?: boolean, providerMessageId?: string) => {
    if (!sourceSessionId) return;
    try {
      // Branch at seq-1: copy everything before this user message.
      // checkpointSeq stays at the message's own seq — the checkpoint captured
      // at its dispatch is the code state before its turn ran.
      const branchAt = prefill ? Math.max(1, seq - 1) : seq;
      const result = await modus.branchSession(sourceSessionId, branchAt, {
        ...(restoreCode ? { restoreCode: true, checkpointSeq: seq, providerMessageId } : {}),
        confirmed: true,
      });
      if (result.workspace?.undoCheckpointId) {
        setRewindNotice({
          sessionId: sourceSessionId,
          checkpointId: result.workspace.undoCheckpointId,
          label: result.workspace.status === "partial"
            ? `Partial workspace rewind applied; ${result.workspace.excluded.length} excluded path${result.workspace.excluded.length === 1 ? " was" : "s were"} left untouched.`
            : result.workspace.providerChanged?.length
            ? `Provider-native workspace rewind applied to ${result.workspace.providerChanged.length} file${result.workspace.providerChanged.length === 1 ? "" : "s"}.`
            : `Workspace rewind applied (${result.workspace.restored.length} restored, ${result.workspace.deleted.length} deleted).`,
        });
      }
      await refreshSessions();
      await selectSession(result.sessionId);
      if (prefill) setInputValue(prefill);
    } catch (err) {
      console.error("Branch failed:", err);
      throw err;
    }
  }, [selectSession, refreshSessions]);

  const reviewRewindUndo = useCallback(async () => {
    if (!rewindNotice) return;
    setRewindNotice({ ...rewindNotice, busy: true, error: undefined });
    try {
      const preview = await modus.previewCheckpointRestore(rewindNotice.sessionId, rewindNotice.checkpointId);
      setRewindNotice({ ...rewindNotice, preview, busy: false });
    } catch (err: any) {
      setRewindNotice({ ...rewindNotice, busy: false, error: err?.message ?? String(err) });
    }
  }, [rewindNotice]);

  const confirmRewindUndo = useCallback(async () => {
    if (!rewindNotice?.preview || rewindNotice.preview.status === "unsupported") return;
    setRewindNotice({ ...rewindNotice, busy: true, error: undefined });
    try {
      const result = await modus.restoreCheckpoint(rewindNotice.sessionId, rewindNotice.checkpointId, true);
      if (result.undoCheckpointId) {
        setRewindNotice({
          sessionId: rewindNotice.sessionId,
          checkpointId: result.undoCheckpointId,
          label: `Undo applied (${result.restored.length} restored, ${result.deleted.length} deleted).`,
        });
      } else {
        setRewindNotice(null);
      }
    } catch (err: any) {
      setRewindNotice({ ...rewindNotice, busy: false, error: err?.message ?? String(err) });
    }
  }, [rewindNotice]);

  const branchFromMessage = useCallback(async (seq: number, prefill?: string, restoreCode?: boolean, providerMessageId?: string) => {
    if (!activeSessionId) return;
    await branchFromSessionMessage(activeSessionId, seq, prefill, restoreCode, providerMessageId);
  }, [activeSessionId, branchFromSessionMessage]);

  return (
    <SessionContext.Provider value={{
      activeSession, serverSessions, allServerSessions, sessionsLoaded, sessionProjects, sessionIndexConnection,
      handleInputChange,
      send, stop, stopTask, newSession, selectSession, archiveSession,
      refreshSessions, handlePermissionResponse,
      queuedMessage, cancelQueued, updateActiveSessionConfig, updateActiveSessionProfile,
      branchFromMessage, branchFromSessionMessage,
    }}>
      {children}
      {rewindNotice && (
        <aside className="rewind-notice" aria-live="polite">
          <div><strong>{rewindNotice.label}</strong></div>
          {rewindNotice.error && <div className="rewind-dialog-error">{rewindNotice.error}</div>}
          {rewindNotice.preview && (
            <div>
              Undo would perform {rewindNotice.preview.files.length} managed-file action{rewindNotice.preview.files.length === 1 ? "" : "s"}.
              {rewindNotice.preview.files.length > 0 && <ul className="rewind-file-list">{rewindNotice.preview.files.map((file) => <li key={`${file.action}:${file.path}`}><b>{file.action}</b> {file.path}</li>)}</ul>}
              {rewindNotice.preview.excluded.length > 0 && <div>{rewindNotice.preview.excluded.length} excluded path{rewindNotice.preview.excluded.length === 1 ? " is" : "s are"} protected.</div>}
            </div>
          )}
          <div className="rewind-dialog-actions">
            <button type="button" onClick={() => setRewindNotice(null)} disabled={rewindNotice.busy}>Dismiss</button>
            {!rewindNotice.preview ? (
              <button type="button" onClick={() => void reviewRewindUndo()} disabled={rewindNotice.busy}>{rewindNotice.busy ? "Reviewing…" : "Review undo"}</button>
            ) : (
              <button type="button" className="rewind-confirm" onClick={() => void confirmRewindUndo()} disabled={rewindNotice.busy || rewindNotice.preview.status === "unsupported"}>
                {rewindNotice.busy ? "Applying…" : "Confirm undo"}
              </button>
            )}
          </div>
        </aside>
      )}
    </SessionContext.Provider>
  );
}
