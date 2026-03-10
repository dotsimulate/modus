import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import {
  createSession, sendMessage as apiSendMessage, stopSessionApi, stopTaskApi,
  archiveSessionApi, fetchSessions, fetchSessionsScoped,
  createEmptySession, getDraft, saveDraft,
  updateSessionConfig, respondToPermission, nextMsgId,
  branchSessionApi,
} from "../api";
import type { Session, SessionInfo, Attachment, ApiAttachment } from "../api";
import { createInitialState } from "../eventReducer";
import { agentConfigToOverrides, type AgentConfigState } from "../components/AgentConfig";
import { useProfiles } from "./ProfileProvider";
import {
  useSessionState, setSessionState, getSessionState,
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

  const applyAgentConfigToState = useCallback((sessionId: string, config: AgentConfigState) => {
    const rs = getSessionState(sessionId);
    if (!rs) return;
    setSessionState(sessionId, {
      ...rs,
      agentConfig: config,
      model: config.model || rs.model,
    }, activeSession?.profile);
  }, [activeSession?.profile]);

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

  const newSession = useCallback(async () => {
    await saveDraftForCurrent();

    const profile = selectedProfile || undefined;
    try {
      const id = await createEmptySession(profile, setupState.agent.model || undefined);
      const rs = createInitialState(id);
      rs.status = "idle";
      rs.agentConfig = setupState.agent;
      rs.model = setupState.agent.model;
      rs.cwd = setupState.cwd;
      rs.loadProjectSettings = setupState.loadProjectSettings;
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
  }, [updateHash, selectedProfile, saveDraftForCurrent, refreshSessions, setupState]);

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

      const profile = selectedProfile || undefined;
      const rs = createInitialState();
      const seedState = currentState
        ? {
            agent: currentState.agentConfig,
            cwd: currentState.cwd,
            loadProjectSettings: currentState.loadProjectSettings,
          }
        : setupState;
      rs.messages.push({
        id: nextMsgId(), role: "user", content: prompt, timestamp: Date.now(),
        attachments: sendAttachments.length > 0 ? sendAttachments : undefined,
      });
      rs.status = "starting";
      rs.agentConfig = seedState.agent;
      rs.model = seedState.agent.model;
      rs.cwd = seedState.cwd;
      rs.loadProjectSettings = seedState.loadProjectSettings;
      const tempId = rs.sessionId;
      setSessionState(tempId, rs, profile);
      setActiveSessionId(tempId);

      try {
        const opts = buildSessionOpts(prompt, profile, seedState);
        if (apiAtts) opts.attachments = apiAtts;
        const { sessionId: realId } = await createSession(opts);

        rekeySession(tempId, realId);
        setActiveSessionId(realId);
        updateHash(realId);
        subscribeSession(realId, 0, profile, refreshSessions);
        refreshSessions();
      } catch (err) {
        const errState = getSessionState(tempId);
        if (errState) {
          const updated = { ...errState, status: "error" as const };
          updated.messages = [...updated.messages, { id: nextMsgId(), role: "assistant" as const, content: `Error: ${err}` }];
          setSessionState(tempId, updated, profile);
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

      const rs = getSessionState(activeSessionId!)!;
      const updated = { ...rs, status: "running" as const };
      updated.messages = [...updated.messages, {
        id: nextMsgId(), role: "user" as const, content: prompt, timestamp: Date.now(),
        attachments: sendAttachments.length > 0 ? sendAttachments : undefined,
      }];
      setSessionState(activeSessionId!, updated, activeSession?.profile);

      try {
        const profile = profiles.find((p) => p.name === activeSession?.profile);
        const overrides = agentConfigToOverrides(rs.agentConfig, profile?.tools ?? "all");
        await apiSendMessage(activeSessionId!, prompt, apiAtts, {
          profile: activeSession?.profile,
          provider: overrides.provider,
          model: overrides.model,
          effort: overrides.effort,
          maxTurns: overrides.maxTurns,
          tools: overrides.tools,
          disallowedTools: overrides.disallowedTools,
          toolStates: overrides.toolStates,
          cwd: rs.cwd,
          loadProjectSettings: rs.loadProjectSettings,
        });
        if (!isSubscribed(activeSessionId!)) {
          const latest = getSessionState(activeSessionId!);
          subscribeSession(activeSessionId!, latest?.lastSeq ?? 0, activeSession?.profile, refreshSessions);
        }
      } catch (err) {
        const latest = getSessionState(activeSessionId!);
        if (latest) {
          const errState = { ...latest };
          errState.messages = [...errState.messages, { id: nextMsgId(), role: "assistant" as const, content: `Error: ${err}` }];
          setSessionState(activeSessionId!, errState, activeSession?.profile);
        }
      }
    }
  }, [input, activeSessionId, activeSession?.profile, selectedProfile, buildSessionOpts, updateHash, refreshSessions, setupState, profiles, serverSessions]);

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
    applyAgentConfigToState(activeSessionId, config);
    // Skip PATCH for sessions without messages — config will be applied on first send
    const state = getSessionState(activeSessionId);
    if (activeSessionId.startsWith("pending-") || !state || state.messages.length === 0) return;
    const profile = profiles.find((p) => p.name === activeSession?.profile);
    const overrides = agentConfigToOverrides(config, profile?.tools ?? "all");
    await updateSessionConfig(activeSessionId, {
      ...overrides,
      cwd: getSessionState(activeSessionId)?.cwd,
      loadProjectSettings: getSessionState(activeSessionId)?.loadProjectSettings,
    }).catch(() => {});
  }, [activeSessionId, activeSession?.profile, applyAgentConfigToState, profiles]);

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
      queuedMessage, cancelQueued, updateActiveSessionConfig,
      branchFromMessage,
    }}>
      {children}
    </SessionContext.Provider>
  );
}
