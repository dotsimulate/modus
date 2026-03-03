import { useState, useEffect, useRef, useCallback } from "react";
import {
  createSession, sendMessage as apiSendMessage, stopSessionApi,
  deleteSessionApi,
  fetchProfiles, fetchSessions,
  subscribeEvents, healthCheck,
} from "./api";
import type { Profile, SessionInfo, CreateSessionOpts } from "./api";
import type { Session } from "./types";
import { createInitialState, reduceEvent, type ReducerState } from "./eventReducer";
import { nextMsgId } from "./types";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { ChatInput } from "./components/ChatInput";
import { ConfigBar } from "./components/ConfigBar";
import { getProfileUi } from "./profileUi";
import { createDefaultSetupState, type SessionSetupState } from "./components/SessionSetup";
import { addRecentPath } from "./recentPaths";
import { agentConfigToOverrides, type AgentConfigState } from "./components/AgentConfig";

function App() {
  const [serverSessions, setServerSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("test-harness");
  const [input, setInput] = useState("");
  const [harnessUp, setHarnessUp] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // New: structured setup state replaces old sessionOverrides
  const [setupState, setSetupState] = useState<SessionSetupState>(createDefaultSetupState());

  // Agent config for mid-session use (popover in ChatInput)
  const [liveAgentConfig, setLiveAgentConfig] = useState<AgentConfigState>({
    toolStates: {},
    effort: "",
    maxTurns: "",
  });

  // Event reducer state — ref for performance
  const reducerState = useRef<ReducerState>(createInitialState());
  const unsubRef = useRef<(() => void) | null>(null);
  const sseConnectedRef = useRef(false);

  const [pendingHashId, setPendingHashId] = useState<string | null>(() => {
    const hash = window.location.hash.slice(1);
    return hash || null;
  });

  // ── Load profiles + sessions ──

  useEffect(() => {
    const loadInitial = async () => {
      try {
        const [p, s] = await Promise.all([fetchProfiles(), fetchSessions()]);
        setProfiles(p);
        setServerSessions(s);
        setHarnessUp(true);
      } catch {
        setHarnessUp(false);
      }
    };
    loadInitial();

    const interval = setInterval(() => {
      healthCheck().then(() => setHarnessUp(true)).catch(() => setHarnessUp(false));
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const s = await fetchSessions();
      setServerSessions(s);
    } catch { /* silent */ }
  }, []);

  // ── URL hash sync ──

  const updateHash = useCallback((id: string | null) => {
    if (id && !id.startsWith("pending-")) {
      window.history.replaceState(null, "", `#${id}`);
    } else {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // ── Apply reducer state to React state ──

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
    });
  }, []);

  // ── Subscribe to event stream ──

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
        // Server sent "done" — clean close. Set to idle.
        if (reducerState.current.status === "running" || reducerState.current.status === "starting") {
          reducerState.current = { ...reducerState.current, status: "idle" };
        }
        syncSessionFromReducer(reducerState.current, profile);
        refreshSessions();
      },
      onDisconnect: () => {
        sseConnectedRef.current = false;
        // Network drop — auto-reconnect after a short delay
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

  // ── Session Actions ──

  const newSession = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    setActiveSession(null);
    reducerState.current = createInitialState();
    updateHash(null);
    setInput("");
    setLiveAgentConfig({ toolStates: {}, effort: "", maxTurns: "" });
    setSidebarOpen(false);
  }, [updateHash]);

  const selectSession = useCallback(async (id: string) => {
    const info = serverSessions.find((s) => s.id === id);
    const sessionProfile = info?.profile ?? undefined;

    // Always reconstruct state from events — single source of truth
    reducerState.current = createInitialState(id);
    syncSessionFromReducer(reducerState.current, sessionProfile);

    // Subscribe to event stream (catches up from DB first, then live if active)
    subscribeToSession(id, 0, sessionProfile);

    if (sessionProfile) setSelectedProfile(sessionProfile);
    updateHash(id);
    setInput("");
    setLiveAgentConfig({ toolStates: {}, effort: "", maxTurns: "" });
    setSidebarOpen(false);
  }, [serverSessions, updateHash, subscribeToSession, syncSessionFromReducer]);

  const deleteSession = useCallback(async (id: string) => {
    await deleteSessionApi(id).catch(() => {});
    if (activeSession?.id === id) {
      newSession();
    }
    refreshSessions();
  }, [activeSession, newSession, refreshSessions]);

  // Auto-load from hash
  useEffect(() => {
    if (pendingHashId && serverSessions.length > 0) {
      if (serverSessions.some((s) => s.id === pendingHashId)) {
        selectSession(pendingHashId);
      }
      setPendingHashId(null);
    }
  }, [pendingHashId, serverSessions, selectSession]);

  /** Build CreateSessionOpts from setup state */
  const buildSessionOpts = useCallback((prompt: string, profile?: string): CreateSessionOpts => {
    const profileData = profiles.find((p) => p.name === profile);
    const agentOverrides = agentConfigToOverrides(
      setupState.agent,
      profileData?.tools ?? "all",
    );
    const cwd = setupState.cwd.trim();
    if (cwd) addRecentPath(cwd);
    return {
      prompt,
      profile,
      ...(setupState.model ? { model: setupState.model } : {}),
      ...(cwd ? { cwd } : {}),
      loadProjectSettings: setupState.loadProjectSettings,
      ...agentOverrides,
    };
  }, [setupState, profiles]);

  const handleSend = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt) return;
    setInput("");

    if (!activeSession || activeSession.status === "done" || activeSession.status === "error" || !activeSession.id || activeSession.id.startsWith("pending-")) {
      // Create new session
      const profile = selectedProfile || undefined;
      reducerState.current = createInitialState();
      reducerState.current.messages.push({ id: nextMsgId(), role: "user", content: prompt });
      reducerState.current.status = "starting";
      syncSessionFromReducer(reducerState.current, profile);

      try {
        const opts = buildSessionOpts(prompt, profile);
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
      // Send to existing session
      reducerState.current.messages.push({ id: nextMsgId(), role: "user", content: prompt });
      reducerState.current.status = "running";
      syncSessionFromReducer(reducerState.current, activeSession.profile);

      try {
        await apiSendMessage(activeSession.id, prompt);
        // Always re-subscribe to ensure we pick up new events.
        // Catch-up from lastSeq covers any events between abort and reconnect.
        subscribeToSession(activeSession.id, reducerState.current.lastSeq, activeSession.profile);
      } catch (err) {
        reducerState.current.messages.push({ id: nextMsgId(), role: "assistant", content: `Error: ${err}` });
        syncSessionFromReducer(reducerState.current, activeSession.profile);
      }
    }
  }, [input, activeSession, selectedProfile, buildSessionOpts, updateHash, subscribeToSession, syncSessionFromReducer, refreshSessions]);

  const handleStop = useCallback(async () => {
    if (activeSession?.id) {
      await stopSessionApi(activeSession.id).catch(() => {});
      reducerState.current.status = "idle";
      syncSessionFromReducer(reducerState.current, activeSession.profile);
    }
  }, [activeSession, syncSessionFromReducer]);

  // ── Render ──

  const activeProfileName = activeSession?.profile ?? selectedProfile;
  const ui = getProfileUi(activeProfileName);
  const isStreaming = activeSession?.status === "running" || activeSession?.status === "starting";
  const profileData = profiles.find((p) => p.name === activeProfileName);

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        sessions={serverSessions}
        activeSessionId={activeSession?.id ?? null}
        profiles={profiles}
        selectedProfile={selectedProfile}
        harnessUp={harnessUp}
        onNewSession={newSession}
        onSelectSession={selectSession}
        onDeleteSession={deleteSession}
        onSelectProfile={setSelectedProfile}
        onSetupChange={setSetupState}
        setupState={setupState}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="chat">
        <div className="chat-header">
          <button className="menu-btn" onClick={() => setSidebarOpen(true)}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M3 4.5h12M3 9h12M3 13.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
          <span className="chat-header-profile">{ui.label}</span>
          {activeSession?.status && activeSession.status !== "done" && (
            <span className={`chat-header-status ${activeSession.status}`}>{activeSession.status}</span>
          )}
        </div>

        <ChatView
          messages={activeSession?.messages ?? []}
          streaming={isStreaming}
          showThinking={ui.showThinking}
          showMeta={ui.showMeta}
          showToolCalls={ui.showToolCalls}
          emptyTitle={ui.emptyTitle ?? activeProfileName}
          emptySubtitle={ui.emptySubtitle}
        />

        <ConfigBar
          profileName={activeProfileName}
          model={activeSession?.model ?? profileData?.model}
          agentConfig={liveAgentConfig}
          onAgentConfigChange={setLiveAgentConfig}
          profileTools={profileData?.tools ?? "all"}
          profileEffort={profileData?.effort}
          profileMaxTurns={profileData?.maxTurns}
        />
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          onStop={handleStop}
          sessionStatus={activeSession?.status ?? null}
          disabled={harnessUp === false}
          placeholder={ui.placeholder}
          activeToolName={activeSession?.activeToolName}
          activeToolElapsed={activeSession?.activeToolElapsed}
        />
      </div>
    </div>
  );
}

export default App;
