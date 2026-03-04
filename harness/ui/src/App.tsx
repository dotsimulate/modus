import { useState, useEffect, useRef, useCallback } from "react";
import {
  createSession, sendMessage as apiSendMessage, stopSessionApi,
  archiveSessionApi,
  fetchProfiles, fetchSessions,
  subscribeEvents, healthCheck,
  createEmptySession, getDraft, saveDraft,
  authStatus, clearAuthToken, lockAll, checkToken,
  updateSessionConfig,
} from "./api";
import { LoginScreen } from "./components/LoginScreen";
import type { Profile, SessionInfo, CreateSessionOpts } from "./api";
import type { Session, Attachment } from "./types";
import { createInitialState, reduceEvent, type ReducerState } from "./eventReducer";
import { nextMsgId } from "./types";
import type { ApiAttachment } from "./api";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { ChatInput } from "./components/ChatInput";
import { ConfigBar } from "./components/ConfigBar";
import { getProfileUi } from "./profileUi";
import { createDefaultSetupState, type SessionSetupState } from "./components/SessionSetup";
import { addRecentPath } from "./recentPaths";
import { agentConfigToOverrides, type AgentConfigState } from "./components/AgentConfig";
import { Dashboard } from "./components/Dashboard";
import { MemoryViz } from "./components/MemoryViz";

function App() {
  // ── PIN Auth Gate ──
  const [authState, setAuthState] = useState<"checking" | "login" | "setup" | "ok">("checking");
  const [userName, setUserName] = useState<string | null>(null);

  useEffect(() => {
    if (authState !== "checking") return;
    authStatus()
      .then(async ({ required, setup, name }) => {
        if (name) setUserName(name);
        if (setup) { setAuthState("setup"); return; }
        if (!required) { setAuthState("ok"); return; }
        // PIN required — validate existing token if we have one
        const existing = localStorage.getItem("harness_token");
        if (existing) {
          try {
            await checkToken();
            setAuthState("ok");
            return;
          } catch {
            // Token stale (server restarted) — clear and show login
            clearAuthToken();
          }
        }
        setAuthState("login");
      })
      .catch(() => setAuthState("ok")); // server unreachable — let AppInner handle it
  }, [authState]);

  // Poll to detect server-side lock — kicks all tabs/devices to login
  useEffect(() => {
    if (authState !== "ok") return;
    if (!localStorage.getItem("harness_token")) return; // no PIN auth, skip

    const interval = setInterval(async () => {
      try {
        await checkToken();
      } catch {
        clearAuthToken();
        setAuthState("checking");
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [authState]);

  const handleAuth = useCallback((name: string) => {
    setUserName(name || null);
    setAuthState("ok");
  }, []);

  const handleLock = useCallback(() => {
    lockAll().catch(() => {}); // invalidate all browser sessions server-side
    clearAuthToken();
    setUserName(null);
    setAuthState("checking");
  }, []);

  if (authState === "checking") return null;
  if (authState === "setup") return <LoginScreen isSetup onAuth={handleAuth} />;
  if (authState === "login") return <LoginScreen savedName={userName ?? undefined} onAuth={handleAuth} />;
  return <AppInner onLock={handleLock} userName={userName} />;
}

function AppInner({ onLock, userName }: { onLock?: () => void; userName?: string | null }) {
  const [serverSessions, setServerSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("test-harness");
  const [input, setInput] = useState("");
  const [harnessUp, setHarnessUp] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [view, setView] = useState<"chat" | "dashboard" | "memory">(() => {
    const h = window.location.hash;
    if (h === "#dashboard") return "dashboard";
    if (h === "#memory") return "memory";
    return "chat";
  });

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
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // ── Hash-based view routing ──
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash;
      if (h === "#dashboard") setView("dashboard");
      else if (h === "#memory") setView("memory");
      else setView("chat");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
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
      availableTools: rs.availableTools.length > 0 ? rs.availableTools : undefined,
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

  // Save draft for current session before navigating away
  const saveDraftForCurrent = useCallback(async (text?: string) => {
    const id = activeSession?.id;
    if (id && !id.startsWith("pending-")) {
      await saveDraft(id, text ?? input).catch(() => {});
    }
  }, [activeSession, input]);

  const newSession = useCallback(async () => {
    // Save draft for current session
    await saveDraftForCurrent();

    unsubRef.current?.();
    unsubRef.current = null;

    // Create an empty session in DB so it persists immediately
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
      // Fallback: local-only empty state
      reducerState.current = createInitialState();
      setActiveSession(null);
      updateHash(null);
    }

    setInput("");
    setLiveAgentConfig({ toolStates: {}, effort: "", maxTurns: "" });
    setSidebarOpen(false);
  }, [updateHash, selectedProfile, saveDraftForCurrent, syncSessionFromReducer, refreshSessions]);

  const selectSession = useCallback(async (id: string) => {
    // Save draft for session we're leaving
    await saveDraftForCurrent();

    const info = serverSessions.find((s) => s.id === id);
    const sessionProfile = info?.profile ?? undefined;

    // Always reconstruct state from events — single source of truth
    reducerState.current = createInitialState(id);
    syncSessionFromReducer(reducerState.current, sessionProfile);

    // Subscribe to event stream (catches up from DB first, then live if active)
    subscribeToSession(id, 0, sessionProfile);

    if (sessionProfile) setSelectedProfile(sessionProfile);
    updateHash(id);

    // Load draft for the session we're entering
    const draft = await getDraft(id).catch(() => "");
    setInput(draft);

    setLiveAgentConfig({ toolStates: {}, effort: "", maxTurns: "" });
    setSidebarOpen(false);
  }, [serverSessions, updateHash, subscribeToSession, syncSessionFromReducer, saveDraftForCurrent]);

  const archiveSession = useCallback(async (id: string) => {
    await archiveSessionApi(id).catch(() => {});
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

  const handleSend = useCallback(async (sendAttachments: Attachment[]) => {
    const prompt = input.trim();
    if (!prompt && sendAttachments.length === 0) return;
    setInput("");

    // Clear draft since we're sending
    if (activeSession?.id) saveDraft(activeSession.id, "").catch(() => {});

    // Convert UI attachments to API format
    const apiAtts: ApiAttachment[] | undefined = sendAttachments.length > 0
      ? sendAttachments.map((a) => ({ type: a.type, mediaType: a.mediaType, data: a.data, name: a.name }))
      : undefined;

    // Is this an empty session (created by "new session" but no messages yet)?
    const isEmptySession = activeSession?.id && activeSession.status === "idle" && activeSession.messages.length === 0;
    const needsNewSession = !activeSession || activeSession.status === "done" || activeSession.status === "error" || !activeSession.id || activeSession.id.startsWith("pending-") || isEmptySession;

    if (needsNewSession) {
      // Archive the empty placeholder if it exists
      const emptyId = isEmptySession ? activeSession!.id : null;
      if (emptyId) archiveSessionApi(emptyId).catch(() => {});

      // Create new SDK session
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
      // Send to existing session
      reducerState.current.messages.push({
        id: nextMsgId(), role: "user", content: prompt,
        attachments: sendAttachments.length > 0 ? sendAttachments : undefined,
      });
      reducerState.current.status = "running";
      syncSessionFromReducer(reducerState.current, activeSession.profile);

      try {
        await apiSendMessage(activeSession.id, prompt, apiAtts);
        // Only re-subscribe if SSE is disconnected — prevents thrashing during mid-turn sends
        if (!sseConnectedRef.current) {
          subscribeToSession(activeSession.id, reducerState.current.lastSeq, activeSession.profile);
        }
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

  // Sync tool/config overrides to backend when session is active
  useEffect(() => {
    const id = activeSession?.id;
    if (!id || id.startsWith("pending-")) return;
    const hasOverrides = Object.keys(liveAgentConfig.toolStates).length > 0;
    if (!hasOverrides) return;
    const profile = profiles.find(p => p.name === activeSession?.profile);
    const overrides = agentConfigToOverrides(liveAgentConfig, profile?.tools ?? "all");
    updateSessionConfig(id, overrides).catch(() => {});
  }, [liveAgentConfig, activeSession?.id, activeSession?.profile, profiles]);

  // Debounced draft save on input change (1s after last keystroke)
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

  // ── Render ──

  const activeProfileName = activeSession?.profile ?? selectedProfile;
  const ui = getProfileUi(activeProfileName);
  const isStreaming = activeSession?.status === "running" || activeSession?.status === "starting";
  const profileData = profiles.find((p) => p.name === activeProfileName);

  const handleDashboardSelect = useCallback((id: string) => {
    window.location.hash = id;
    setView("chat");
    selectSession(id);
  }, [selectSession]);

  if (view === "memory") {
    return (
      <MemoryViz onBack={() => { window.location.hash = ""; setView("chat"); }} />
    );
  }

  if (view === "dashboard") {
    return (
      <Dashboard
        onSelectSession={handleDashboardSelect}
        onBack={() => { window.location.hash = ""; setView("chat"); }}
      />
    );
  }

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        sessions={serverSessions}
        activeSessionId={activeSession?.id ?? null}
        profiles={profiles}
        selectedProfile={selectedProfile}
        harnessUp={harnessUp}
        onNewSession={newSession}
        onSelectSession={selectSession}
        onArchiveSession={archiveSession}
        onSelectProfile={setSelectedProfile}
        onSetupChange={setSetupState}
        setupState={setupState}
        onClose={() => setSidebarOpen(false)}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        onLock={onLock}
        userName={userName}
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
          <a className="dash-link" href="#memory">memory</a>
          <a className="dash-link" href="#dashboard">dashboard</a>
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
          availableTools={activeSession?.availableTools}
        />
        <ChatInput
          value={input}
          onChange={handleInputChange}
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
