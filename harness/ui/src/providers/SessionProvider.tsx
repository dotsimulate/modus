import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import {
  createSession, sendMessage as apiSendMessage, stopSessionApi,
  archiveSessionApi, fetchSessions, fetchSessionsScoped,
  subscribeEvents, createEmptySession, getDraft, saveDraft,
  updateSessionConfig, respondToPermission, nextMsgId,
} from "../api";
import type { Session, SessionInfo, Attachment, ApiAttachment } from "../api";
import { createInitialState, reduceEvent, type ReducerState } from "../eventReducer";
import { agentConfigToOverrides } from "../components/AgentConfig";
import { useProfiles } from "./ProfileProvider";

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
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [input, setInput] = useState("");

  const reducerState = useRef<ReducerState>(createInitialState());
  const unsubRef = useRef<(() => void) | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sseConnectedRef = useRef(false);

  const [pendingHashId, setPendingHashId] = useState<string | null>(() => {
    const hash = window.location.hash.slice(1);
    return hash || null;
  });

  // ── Refresh sessions ──

  const refreshSessions = useCallback(async () => {
    try {
      const s = activeUserProfile
        ? await fetchSessionsScoped(50, activeUserProfile)
        : await fetchSessions();
      setServerSessions(s);
    } catch { /* silent */ }
  }, [activeUserProfile]);

  // Load sessions on mount + when user profile changes
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // ── URL hash sync ──

  const updateHash = useCallback((id: string | null) => {
    if (id && !id.startsWith("pending-")) {
      window.history.replaceState(null, "", `#${id}`);
    } else {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // ── Sync reducer state to React state ──

  const syncSessionFromReducer = useCallback((rs: ReducerState, profile?: string) => {
    setActiveSession({
      id: rs.sessionId,
      status: rs.status,
      preview: rs.messages[0]?.content?.slice(0, 60) ?? "",
      profile,
      model: rs.model,
      messages: rs.messages,
      totalCost: rs.totalCost,
      lastSeq: rs.lastSeq,
      createdAt: rs.createdAt,
      updatedAt: Date.now(),
      activeToolName: rs.activeToolName,
      activeToolElapsed: rs.activeToolElapsed,
      availableTools: rs.availableTools.length > 0 ? rs.availableTools : undefined,
      pendingPermissions: rs.pendingPermissions.length > 0 ? rs.pendingPermissions : undefined,
    });
  }, []);

  // ── SSE subscription ──

  const subscribeToSession = useCallback((sessionId: string, afterSeq: number, profile?: string) => {
    unsubRef.current?.();

    sseConnectedRef.current = true;
    const unsub = subscribeEvents(sessionId, afterSeq, {
      onEvent: (event, seq) => {
        reducerState.current = reduceEvent(reducerState.current, event, seq);
        syncSessionFromReducer(reducerState.current, profile);
      },
      onDone: () => {
        sseConnectedRef.current = false;
        if (reducerState.current.status === "running" || reducerState.current.status === "starting") {
          reducerState.current = { ...reducerState.current, status: "idle" };
        }
        syncSessionFromReducer(reducerState.current, profile);
        refreshSessions();
      },
      onDisconnect: () => {
        sseConnectedRef.current = false;
        console.warn(`SSE disconnected for ${sessionId}, reconnecting...`);
        setTimeout(() => {
          if (unsubRef.current === unsub) {
            subscribeToSession(sessionId, reducerState.current.lastSeq, profile);
          }
        }, 2000);
      },
      onError: (error) => {
        sseConnectedRef.current = false;
        reducerState.current = { ...reducerState.current, status: "error" };
        syncSessionFromReducer(reducerState.current, profile);
        console.error("Event stream error:", error);
      },
    });
    unsubRef.current = unsub;
  }, [syncSessionFromReducer, refreshSessions]);

  // ── Draft management ──

  const saveDraftForCurrent = useCallback(async (text?: string) => {
    const id = activeSession?.id;
    if (id && !id.startsWith("pending-")) {
      await saveDraft(id, text ?? input).catch(() => {});
    }
  }, [activeSession, input]);

  const handleInputChange = useCallback((text: string) => {
    setInput(text);
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    const id = activeSession?.id;
    if (id && !id.startsWith("pending-")) {
      draftTimerRef.current = setTimeout(() => {
        saveDraft(id, text).catch(() => {});
      }, 1000);
    }
  }, [activeSession]);

  // ── Session actions ──

  const newSession = useCallback(async () => {
    await saveDraftForCurrent();
    unsubRef.current?.();
    unsubRef.current = null;

    const profile = selectedProfile || undefined;
    try {
      const id = await createEmptySession(profile);
      const rs = createInitialState(id);
      rs.status = "idle";
      reducerState.current = rs;
      syncSessionFromReducer(rs, profile);
      updateHash(id);
      refreshSessions();
    } catch {
      reducerState.current = createInitialState();
      setActiveSession(null);
      updateHash(null);
    }

    setInput("");
    setLiveAgentConfig({ toolStates: {}, effort: "", maxTurns: "" });
  }, [updateHash, selectedProfile, saveDraftForCurrent, syncSessionFromReducer, refreshSessions, setLiveAgentConfig]);

  const selectSession = useCallback(async (id: string) => {
    await saveDraftForCurrent();

    const info = serverSessions.find((s) => s.id === id);
    const sessionProfile = info?.profile ?? undefined;

    reducerState.current = createInitialState(id);
    syncSessionFromReducer(reducerState.current, sessionProfile);
    subscribeToSession(id, 0, sessionProfile);

    if (sessionProfile) setSelectedProfile(sessionProfile);
    updateHash(id);

    const draft = await getDraft(id).catch(() => "");
    setInput(draft);

    setLiveAgentConfig({ toolStates: {}, effort: "", maxTurns: "" });
  }, [serverSessions, updateHash, subscribeToSession, syncSessionFromReducer, saveDraftForCurrent, setSelectedProfile, setLiveAgentConfig]);

  const archiveSession = useCallback(async (id: string) => {
    await archiveSessionApi(id).catch(() => {});
    if (activeSession?.id === id) {
      newSession();
    }
    refreshSessions();
  }, [activeSession, newSession, refreshSessions]);

  // ── Send message ──

  const send = useCallback(async (sendAttachments: Attachment[]) => {
    const prompt = input.trim();
    if (!prompt && sendAttachments.length === 0) return;
    setInput("");

    if (activeSession?.id) saveDraft(activeSession.id, "").catch(() => {});

    const apiAtts: ApiAttachment[] | undefined = sendAttachments.length > 0
      ? sendAttachments.map((a) => ({ type: a.type, mediaType: a.mediaType, data: a.data, name: a.name }))
      : undefined;

    const isEmptySession = activeSession?.id && activeSession.status === "idle" && activeSession.messages.length === 0;
    const needsNewSession = !activeSession || activeSession.status === "done" || activeSession.status === "error" || !activeSession.id || activeSession.id.startsWith("pending-") || isEmptySession;

    if (needsNewSession) {
      const emptyId = isEmptySession ? activeSession!.id : null;
      if (emptyId) archiveSessionApi(emptyId).catch(() => {});

      const profile = selectedProfile || undefined;
      reducerState.current = createInitialState();
      reducerState.current.messages.push({
        id: nextMsgId(), role: "user", content: prompt,
        attachments: sendAttachments.length > 0 ? sendAttachments : undefined,
      });
      reducerState.current.status = "starting";
      syncSessionFromReducer(reducerState.current, profile);

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

        reducerState.current.sessionId = realId;
        updateHash(realId);
        syncSessionFromReducer(reducerState.current, profile);
        subscribeToSession(realId, 0, profile);
        refreshSessions();
      } catch (err) {
        reducerState.current.status = "error";
        reducerState.current.messages.push({ id: nextMsgId(), role: "assistant", content: `Error: ${err}` });
        syncSessionFromReducer(reducerState.current, selectedProfile);
      }
    } else {
      reducerState.current.messages.push({
        id: nextMsgId(), role: "user", content: prompt,
        attachments: sendAttachments.length > 0 ? sendAttachments : undefined,
      });
      reducerState.current.status = "running";
      syncSessionFromReducer(reducerState.current, activeSession.profile);

      try {
        await apiSendMessage(activeSession.id, prompt, apiAtts);
        if (!sseConnectedRef.current) {
          subscribeToSession(activeSession.id, reducerState.current.lastSeq, activeSession.profile);
        }
      } catch (err) {
        reducerState.current.messages.push({ id: nextMsgId(), role: "assistant", content: `Error: ${err}` });
        syncSessionFromReducer(reducerState.current, activeSession.profile);
      }
    }
  }, [input, activeSession, selectedProfile, buildSessionOpts, updateHash, subscribeToSession, syncSessionFromReducer, refreshSessions]);

  const stop = useCallback(async () => {
    if (activeSession?.id) {
      await stopSessionApi(activeSession.id).catch(() => {});
      reducerState.current.status = "idle";
      syncSessionFromReducer(reducerState.current, activeSession.profile);
    }
  }, [activeSession, syncSessionFromReducer]);

  const handlePermissionResponse = useCallback(async (
    requestId: string,
    behavior: "allow" | "deny",
    updatedInput?: Record<string, unknown>,
    scope?: "once" | "session",
  ) => {
    if (!activeSession?.id) return;
    await respondToPermission(activeSession.id, { requestId, behavior, updatedInput, scope }).catch(() => {});
  }, [activeSession]);

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
    const id = activeSession?.id;
    if (!id || id.startsWith("pending-")) return;
    const hasOverrides = Object.keys(liveAgentConfig.toolStates).length > 0;
    if (!hasOverrides) return;
    const profile = profiles.find(p => p.name === activeSession?.profile);
    const overrides = agentConfigToOverrides(liveAgentConfig, profile?.tools ?? "all");
    updateSessionConfig(id, overrides).catch(() => {});
  }, [liveAgentConfig, activeSession?.id, activeSession?.profile, profiles]);

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
