import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import {
  createSession, sendMessage as apiSendMessage, stopSessionApi,
  archiveSessionApi, fetchSessions, fetchSessionsScoped,
  createEmptySession, getDraft, saveDraft,
  updateSessionConfig, respondToPermission, nextMsgId,
} from "../api";
import type { Session, SessionInfo, Attachment, ApiAttachment } from "../api";
import { createInitialState } from "../eventReducer";
import { agentConfigToOverrides } from "../components/AgentConfig";
import { useProfiles } from "./ProfileProvider";
import {
  useSessionState, setSessionState, getSessionState,
  subscribeSession, unsubscribeSession, isSubscribed,
  rekeySession, removeSession,
} from "../sessionStore";

type SessionContextValue = {
  activeSession: Session | null;
  serverSessions: SessionInfo[];
  input: string;
  handleInputChange: (text: string) => void;
  send: (attachments: Attachment[]) => Promise<void>;
  stop: () => Promise<void>;
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
};

const SessionContext = createContext<SessionContextValue>(null!);
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const {
    selectedProfile, profiles, buildSessionOpts,
    liveAgentConfig, setLiveAgentConfig, activeUserProfile,
    setSelectedProfile,
  } = useProfiles();

  const [serverSessions, setServerSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [pendingHashId, setPendingHashId] = useState<string | null>(() => {
    const hash = window.location.hash.slice(1);
    return hash || null;
  });

  // Derive activeSession from the store
  const activeSession = useSessionState(activeSessionId);

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
      window.history.replaceState(null, "", `#${id}`);
    } else {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

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
      const id = await createEmptySession(profile);
      const rs = createInitialState(id);
      rs.status = "idle";
      setSessionState(id, rs, profile);
      setActiveSessionId(id);
      updateHash(id);
      refreshSessions();
    } catch {
      setActiveSessionId(null);
      updateHash(null);
    }

    setInput("");
    setLiveAgentConfig({ toolStates: {}, provider: "", effort: "", maxTurns: "" });
  }, [updateHash, selectedProfile, saveDraftForCurrent, refreshSessions, setLiveAgentConfig]);

  const selectSession = useCallback(async (id: string) => {
    await saveDraftForCurrent();

    const info = serverSessions.find((s) => s.id === id);
    const sessionProfile = info?.profile ?? undefined;

    // Create store entry and subscribe
    const rs = createInitialState(id);
    setSessionState(id, rs, sessionProfile);
    setActiveSessionId(id);
    subscribeSession(id, 0, sessionProfile, refreshSessions);

    if (sessionProfile) setSelectedProfile(sessionProfile);
    updateHash(id);

    const draft = await getDraft(id).catch(() => "");
    setInput(draft);

    setLiveAgentConfig({ toolStates: {}, provider: "", effort: "", maxTurns: "" });
  }, [serverSessions, updateHash, saveDraftForCurrent, setSelectedProfile, setLiveAgentConfig, refreshSessions]);

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
    const isEmptySession = activeSessionId && currentState?.status === "idle" && currentState.messages.length === 0;
    const needsNewSession = !activeSessionId || !currentState || currentState.status === "done" || currentState.status === "error" || activeSessionId.startsWith("pending-") || isEmptySession;

    if (needsNewSession) {
      if (isEmptySession && activeSessionId) archiveSessionApi(activeSessionId).catch(() => {});

      const profile = selectedProfile || undefined;
      const rs = createInitialState();
      rs.messages.push({
        id: nextMsgId(), role: "user", content: prompt,
        attachments: sendAttachments.length > 0 ? sendAttachments : undefined,
      });
      rs.status = "starting";
      const tempId = rs.sessionId;
      setSessionState(tempId, rs, profile);
      setActiveSessionId(tempId);

      try {
        const opts = buildSessionOpts(prompt, profile);
        if (apiAtts) opts.attachments = apiAtts;
        const { sessionId } = await createSession(opts);

        let realId = sessionId;
        if (realId.startsWith("pending-")) {
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const sessions = await fetchSessions(1).catch(() => []);
            if (sessions.length > 0 && !sessions[0].id.startsWith("pending-")) {
              realId = sessions[0].id;
              break;
            }
          }
        }

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
      const rs = getSessionState(activeSessionId!)!;
      const updated = { ...rs, status: "running" as const };
      updated.messages = [...updated.messages, {
        id: nextMsgId(), role: "user" as const, content: prompt,
        attachments: sendAttachments.length > 0 ? sendAttachments : undefined,
      }];
      setSessionState(activeSessionId!, updated, activeSession?.profile);

      try {
        await apiSendMessage(activeSessionId!, prompt, apiAtts);
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
  }, [input, activeSessionId, activeSession?.profile, selectedProfile, buildSessionOpts, updateHash, refreshSessions]);

  const stop = useCallback(async () => {
    if (activeSessionId) {
      await stopSessionApi(activeSessionId).catch(() => {});
      const rs = getSessionState(activeSessionId);
      if (rs) {
        setSessionState(activeSessionId, { ...rs, status: "idle" }, activeSession?.profile);
      }
    }
  }, [activeSessionId, activeSession?.profile]);

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
    if (pendingHashId && serverSessions.length > 0) {
      if (serverSessions.some((s) => s.id === pendingHashId)) {
        selectSession(pendingHashId);
      }
      setPendingHashId(null);
    }
  }, [pendingHashId, serverSessions, selectSession]);

  // ── Sync live config overrides to backend ──

  useEffect(() => {
    if (!activeSessionId || activeSessionId.startsWith("pending-")) return;
    const hasOverrides = Object.keys(liveAgentConfig.toolStates).length > 0;
    if (!hasOverrides) return;
    const profile = profiles.find(p => p.name === activeSession?.profile);
    const overrides = agentConfigToOverrides(liveAgentConfig, profile?.tools ?? "all");
    updateSessionConfig(activeSessionId, overrides).catch(() => {});
  }, [liveAgentConfig, activeSessionId, activeSession?.profile, profiles]);

  return (
    <SessionContext.Provider value={{
      activeSession, serverSessions,
      input, handleInputChange,
      send, stop, newSession, selectSession, archiveSession,
      refreshSessions, handlePermissionResponse,
    }}>
      {children}
    </SessionContext.Provider>
  );
}
