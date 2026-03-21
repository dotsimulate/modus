import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { ProfileUi } from "./api";
import { healthCheck, saveUserProfileApi, fetchSessionUiState, saveSessionUiState, fetchActiveWidget, addSessionTagApi, removeSessionTagApi, detachMoveApi, fetchMoves, rekeyMoveByTokenApi } from "./api";
import type { MoveListItem } from "./api";
import { customPageView, getCustomPageId, getMovePageName, movePageView, NAV_VIEWS, type View } from "./views";
import { AuthProvider, useAuth } from "./providers/AuthProvider";
import { ProfileProvider, useProfiles } from "./providers/ProfileProvider";
import { SessionProvider, useSession } from "./providers/SessionProvider";
import { getSessionState } from "./sessionStore";
import { useHashRouter } from "./hooks/useHashRouter";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { ChatInput } from "./components/ChatInput";
import { ConfigBar } from "./components/ConfigBar";
import { Dashboard } from "./components/Dashboard";
import { PageView } from "./components/PageRenderer";
import { Profiles } from "./components/Profiles";
import { Actions } from "./components/Actions";
import { MovePageView } from "./components/MovePageView";
import { PermissionOverlay } from "./components/PermissionOverlay";
import { MoLogo } from "./components/MoLogo";
import { StatusBar } from "./components/sidebar/StatusBar";
import { UserSettingsModal } from "./components/UserSettingsModal";
import { createEmptyAgentConfig } from "./components/AgentConfig";
import { FileViewerProvider, useFileViewer } from "./providers/FileViewerProvider";
import { PinboardProvider } from "./providers/PinboardProvider";
import { SessionWindow } from "./components/SessionWindow";
import { SessionWeb } from "./components/SessionWeb";
import { TraceView } from "./components/TraceView";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { ResizeHandle } from "./components/ResizeHandle";
import { PanelCollapseTab } from "./components/PanelCollapseTab";
import { ClientExtensionsBoot } from "./components/ClientExtensionsBoot";
import { AgentPortal } from "./components/AgentPortal";

import { loadAndApplyProjectUiState } from "./project-ui-theme";

function parseTagList(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function App() {
  return (
    <AuthProvider>
      <ProfileProvider>
        <SessionProvider>
          <FileViewerProvider>
            <PinboardProvider>
              <ClientExtensionsBoot />
              <AppShell />
            </PinboardProvider>
          </FileViewerProvider>
        </SessionProvider>
      </ProfileProvider>
    </AuthProvider>
  );
}

function AppShell() {
  const { handleLock } = useAuth();
  const {
    profiles, visibleProfiles, availableProviders, userProfiles,
    activeUserProfile, activeUP,
    selectedProfile, selectProfile,
    setupState, setSetupState,
    uiState, saveUiState, switchUserProfile, refreshUserProfiles,
  } = useProfiles();
  const {
    activeSession, serverSessions,
    input, handleInputChange,
    send, stop, stopTask, newSession, selectSession, archiveSession,
    refreshSessions,
    handlePermissionResponse, updateActiveSessionConfig, updateActiveSessionProfile,
    queuedMessage, cancelQueued, branchFromMessage,
  } = useSession();
  const { view, navigate, hashProfile, hashSessionId, setUrlProfile, setUrlSession, consumeHashProfile } = useHashRouter();
  const { tabs: fileViewerTabs, activePath: fileViewerActivePath, hydrate: hydrateFileViewer } = useFileViewer();

  // ── Local UI state ──
  const [harnessUp, setHarnessUp] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [forceSetup, setForceSetup] = useState(false);
  const [showUserSettings, setShowUserSettings] = useState(false);
  const [floatingSessionId, setFloatingSessionId] = useState<string | null>(null);
  const [leftPanelOpen, setLeftPanelOpen] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(280);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [rightPanelBrowserPath, setRightPanelBrowserPath] = useState<string | null>(null);
  const [requestRightPanelView, setRequestRightPanelView] = useState<string | null>(null);
  const [activeMoveWidgets, setActiveMoveWidgets] = useState<Array<{
    widget: import("./api").MoveWidgetInfo;
    apiToken: string;
    instanceId: string;
    sessionId: string;
    mountedOnAttach?: boolean;
  }>>([]);
  const widgetJustSetRef = useRef(false);
  const prevSessionIdRef = useRef<string | null>(null);
  const panelSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uiCache = useRef<Map<string, Record<string, unknown>>>(new Map());
  const fileViewerTabsRef = useRef(fileViewerTabs);
  const fileViewerActivePathRef = useRef(fileViewerActivePath);
  const rightPanelBrowserPathRef = useRef(rightPanelBrowserPath);
  fileViewerTabsRef.current = fileViewerTabs;
  fileViewerActivePathRef.current = fileViewerActivePath;
  rightPanelBrowserPathRef.current = rightPanelBrowserPath;

  // ── Panel state persistence (per-session, backend-stored) ──

  // Capture current panel + scroll state into cache and persist to backend (debounced)
  const savePanelState = useCallback((sessionId: string) => {
    if (!sessionId || sessionId.startsWith("pending-")) return;
    const scrollEl = document.querySelector(".chat-messages");
    const snapshot: Record<string, unknown> = {
      leftPanelOpen, leftPanelWidth, rightPanelOpen, rightPanelWidth,
      scrollTop: scrollEl ? scrollEl.scrollTop : 0,
      fileViewerTabs: fileViewerTabsRef.current,
      fileViewerActivePath: fileViewerActivePathRef.current,
      browserPath: rightPanelBrowserPathRef.current,
    };
    uiCache.current.set(sessionId, snapshot);
    // Cap cache at 20 entries — evict oldest
    if (uiCache.current.size > 20) {
      const oldest = uiCache.current.keys().next().value;
      if (oldest && oldest !== sessionId) uiCache.current.delete(oldest);
    }
    if (panelSaveTimer.current) clearTimeout(panelSaveTimer.current);
    panelSaveTimer.current = setTimeout(() => {
      saveSessionUiState(sessionId, snapshot).catch(() => {});
    }, 300);
  }, [leftPanelOpen, leftPanelWidth, rightPanelOpen, rightPanelWidth]);

  // Save panel state on change (debounced)
  useEffect(() => {
    const id = activeSession?.id;
    if (!id || id.startsWith("pending-")) return;
    savePanelState(id);
  }, [leftPanelOpen, leftPanelWidth, rightPanelOpen, rightPanelWidth, rightPanelBrowserPath, fileViewerTabs, fileViewerActivePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore panel + scroll state on session switch
  useEffect(() => {
    const id = activeSession?.id ?? null;
    const prevId = prevSessionIdRef.current;
    if (id === prevId) return;

    // Save outgoing session's scroll position before switching
    if (prevId && !prevId.startsWith("pending-")) {
      const scrollEl = document.querySelector(".chat-messages");
      if (scrollEl) {
        const cached = uiCache.current.get(prevId) ?? {};
        cached.scrollTop = scrollEl.scrollTop;
        uiCache.current.set(prevId, cached);
      }
    }

    prevSessionIdRef.current = id;

    if (!id || id.startsWith("pending-")) {
      setLeftPanelOpen(false);
      setLeftPanelWidth(280);
      setRightPanelOpen(false);
      setRightPanelWidth(360);
      setRightPanelBrowserPath(null);
      hydrateFileViewer([], null);
      return;
    }

    // Restore from cache (synchronous — no bounce), backfill from backend
    const applyState = (state: Record<string, unknown>) => {
      setLeftPanelOpen(!!state.leftPanelOpen);
      setLeftPanelWidth(typeof state.leftPanelWidth === "number" ? state.leftPanelWidth : 280);
      setRightPanelOpen(!!state.rightPanelOpen);
      setRightPanelWidth(typeof state.rightPanelWidth === "number" ? state.rightPanelWidth : 360);
      setRightPanelBrowserPath(typeof state.browserPath === "string" ? state.browserPath : null);
      // Restore file viewer tabs and active path
      const savedTabs = Array.isArray(state.fileViewerTabs)
        ? (state.fileViewerTabs as { path: string; pinned: boolean }[]).filter(
            (t) => typeof t?.path === "string"
          )
        : [];
      const savedActivePath = typeof state.fileViewerActivePath === "string" ? state.fileViewerActivePath : null;
      hydrateFileViewer(savedTabs, savedActivePath);
      // Restore scroll position after React renders the new layout
      if (typeof state.scrollTop === "number" && state.scrollTop > 0) {
        requestAnimationFrame(() => {
          const scrollEl = document.querySelector(".chat-messages");
          if (scrollEl) scrollEl.scrollTop = state.scrollTop as number;
        });
      }
    };

    const cached = uiCache.current.get(id);
    if (cached) {
      applyState(cached);
    } else {
      // First visit this session — fetch from backend, cache it
      setLeftPanelOpen(false);
      setLeftPanelWidth(280);
      setRightPanelOpen(false);
      setRightPanelWidth(360);
      fetchSessionUiState(id).then((state) => {
        uiCache.current.set(id, state);
        // Only apply if we're still on this session
        if (prevSessionIdRef.current === id) applyState(state);
      }).catch(() => {});
    }
  }, [activeSession?.id]);

  // Restore active move widgets on session switch / page load
  useEffect(() => {
    const id = activeSession?.id;
    if (!id || id.startsWith("pending-")) { setActiveMoveWidgets([]); return; }
    // Skip backend fetch if widget was just set by onMoveActivated — the backend
    // registry may not have the rekeyed session ID yet. Just update the sessionId.
    if (widgetJustSetRef.current) {
      widgetJustSetRef.current = false;
      setActiveMoveWidgets(prev => {
        // Rekey backend registrations for each widget whose sessionId differs
        for (const w of prev) {
          if (w.apiToken && w.sessionId !== id) {
            rekeyMoveByTokenApi(w.apiToken, id).catch((e) =>
              console.error(`[App] rekeyMoveByToken FAILED for ${w.apiToken}:`, e)
            );
          }
        }
        return prev.map(w => ({ ...w, sessionId: id }));
      });
      return;
    }
    fetchActiveWidget(id).then((widgets) => {
      if (!widgets.length) {
        // Keep existing widgets already tagged to this session (onMoveActivated set them
        // before the rekey completed); clear any that belong to a different session.
        setActiveMoveWidgets(prev => prev.filter(w => w.sessionId === id));
        return;
      }
      setActiveMoveWidgets(widgets.map(w => ({ ...w, sessionId: id })));
    }).catch(() => setActiveMoveWidgets([]));
  }, [activeSession?.id]);

  // Listen for widget-change signals from move widgets (e.g. move-launcher activating another move)
  useEffect(() => {
    const id = activeSession?.id;
    if (!id || id.startsWith("pending-")) return;
    const handler = () => {
      fetchActiveWidget(id).then((widgets) => {
        if (widgets.length) {
          setActiveMoveWidgets(prev => {
            // Merge: keep existing, add new ones
            const existing = new Set(prev.map(w => w.instanceId));
            const next = [...prev];
            for (const w of widgets) {
              if (!existing.has(w.instanceId)) {
                next.push({
                  ...w,
                  sessionId: id,
                  mountedOnAttach: w.widget.mountOnAttach ?? false,
                });
              }
            }
            return next;
          });
          setRightPanelOpen(true);
        }
      }).catch(() => {});
    };
    window.addEventListener("modus:widgets-changed", handler);
    return () => window.removeEventListener("modus:widgets-changed", handler);
  }, [activeSession?.id]);

  // Sync editor pref from active user profile into localStorage
  useEffect(() => {
    if (!activeUP) return;
    if (activeUP.editor) localStorage.setItem("mo:editor", activeUP.editor);
    else localStorage.removeItem("mo:editor");
  }, [activeUP?.editor]);

  // Health check
  useEffect(() => {
    const check = () => healthCheck().then(() => setHarnessUp(true)).catch(() => setHarnessUp(false));
    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, []);

  // Sync profile from URL hash → app state
  useEffect(() => {
    const urlProfile = consumeHashProfile();
    if (urlProfile === null) return;
    // URL had an explicit profile — switch to it (or "" for "all")
    if (urlProfile !== (activeUserProfile ?? "")) {
      switchUserProfile(urlProfile || null);
    }
  }, [hashProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wrap session actions with sidebar close
  const restorableLastSessionId = uiState.lastSessionId
    && (serverSessions.some((s) => s.id === uiState.lastSessionId) || activeSession?.id === uiState.lastSessionId)
    ? uiState.lastSessionId
    : null;
  const activeSessionTags = useMemo(
    () => parseTagList(serverSessions.find((s) => s.id === activeSession?.id)?.tags),
    [activeSession?.id, serverSessions],
  );

  const handleNewSession = useCallback(async () => {
    const id = await newSession();
    if (id) {
      setUrlSession(id, activeUserProfile);
    } else {
      navigate("chat");
    }
    setSidebarOpen(false);
  }, [activeUserProfile, navigate, newSession, setUrlSession]);

  const handleSelectSession = useCallback((id: string) => {
    selectSession(id);
    setUrlSession(id, activeUserProfile);
    setSidebarOpen(false);
  }, [activeUserProfile, selectSession, setUrlSession]);

  // Wrap switchUserProfile to also update URL
  const handleSwitchUserProfile = useCallback((name: string | null) => {
    switchUserProfile(name);
    setUrlProfile(name);
  }, [switchUserProfile, setUrlProfile]);

  // Switch profile on live session (ConfigBar controls this)
  const handleSwitchProfile = useCallback((name: string) => {
    if (activeSession?.id && !activeSession.id.startsWith("pending-")) {
      updateActiveSessionProfile(name);
    }
  }, [activeSession?.id, updateActiveSessionProfile]);

  // View-based session navigation (from dashboard/schedules)
  const handleViewSession = useCallback((id: string) => {
    selectSession(id);
    setUrlSession(id, activeUserProfile);
  }, [activeUserProfile, selectSession, setUrlSession]);

  const handleNavigate = useCallback((target: View) => {
    if (target !== "chat") {
      navigate(target);
      return;
    }
    // "sessions" nav → restore last session for this profile, or show empty chat
    if (restorableLastSessionId) {
      selectSession(restorableLastSessionId);
      setUrlSession(restorableLastSessionId, activeUserProfile);
      return;
    }
    navigate("chat");
  }, [activeUserProfile, navigate, restorableLastSessionId, selectSession, setUrlSession]);

  // Peek: pop a floating SessionWindow for any session ID
  const handlePeekSession = useCallback((id: string) => {
    setFloatingSessionId(id);
  }, []);

  const handleTogglePin = useCallback(async (id: string) => {
    const session = serverSessions.find(s => s.id === id);
    const tags = parseTagList(session?.tags);
    if (tags.includes("pinned")) {
      await removeSessionTagApi(id, "pinned").catch(() => {});
    } else {
      await addSessionTagApi(id, "pinned").catch(() => {});
    }
    refreshSessions();
  }, [serverSessions, refreshSessions]);

  const handleLeftResize = useCallback((delta: number) => {
    setLeftPanelWidth((w) => Math.max(180, Math.min(600, w + delta)));
  }, []);
  const handleRightResize = useCallback((delta: number) => {
    setRightPanelWidth((w) => Math.max(200, Math.min(800, w + delta)));
  }, []);

  // ── Profile UI resolution ──
  // Config bar shows the active session's profile. Sidebar's selectedProfile
  // is the seed for NEW sessions only — it must never leak into the active
  // session's display. When an active session has no profile (null from server),
  // fall back to the user profile default, not the sidebar selection.
  const activeProfileName = activeSession
    ? (activeSession.profile || activeUP?.defaultAgentProfile || visibleProfiles[0]?.name || selectedProfile)
    : selectedProfile;
  const profileUi = profiles.find((p) => p.name === activeProfileName)?.ui ?? {};
  const ui: Required<ProfileUi> = {
    label: profileUi.label ?? "agent",
    showThinking: profileUi.showThinking ?? true,
    showMeta: profileUi.showMeta ?? true,
    showToolCalls: profileUi.showToolCalls ?? true,
    showGitEvents: profileUi.showGitEvents ?? true,
    placeholder: profileUi.placeholder ?? "message...",
    emptyTitle: profileUi.emptyTitle ?? activeProfileName,
    emptySubtitle: profileUi.emptySubtitle ?? "start typing to begin",
    panelWidgets: profileUi.panelWidgets ?? [],
  };
  const isStreaming = activeSession?.status === "running" || activeSession?.status === "starting";
  const profileData = profiles.find((p) => p.name === activeProfileName);
  const activeSessionInfo = activeSession?.id ? serverSessions.find((s) => s.id === activeSession.id) : undefined;
  const editorProfileName = activeSession?.nextProfile ?? activeProfileName;
  const editorProfileData = profiles.find((p) => p.name === editorProfileName);
  const sessionProviderLocked = !!activeSession && activeSession.messages.length > 0;
  const liveProvider = activeSessionInfo?.provider || activeSession?.provider || profileData?.provider || activeUP?.provider;
  // Use session model when available; fall back to profile default while events
  // are still in-flight (activeSession.model may be "" before system:init arrives).
  const liveModel = activeSession?.model || profileData?.model || activeUP?.model || "";
  const editorProfileProvider = editorProfileData?.provider ?? activeUP?.provider;
  const editorProfileModel = editorProfileData?.model ?? activeUP?.model;
  const pendingProfileProviderMatches = !sessionProviderLocked
    || !liveProvider
    || !editorProfileProvider
    || editorProfileProvider === liveProvider;
  const editorAgentConfig = activeSession?.nextAgentConfig
    ?? (
      activeSession?.nextProfile && activeSession.nextProfile !== activeSession.profile
        ? createEmptyAgentConfig()
        : activeSession?.agentConfig
    )
    ?? setupState.agent;
  const activeAgentCount = serverSessions.filter(s => {
    const status = getSessionState(s.id)?.status ?? s.status;
    return status === "running" || status === "starting";
  }).length;
  // ── Move pages (moves that declare a page field) ──
  const [movePages, setMovePages] = useState<MoveListItem[]>([]);
  const projectCwd = activeSession?.cwd ?? serverSessions.find(s => s.id === activeSession?.id)?.cwd ?? setupState.cwd;
  useEffect(() => {
    if (!projectCwd) return;
    fetchMoves(projectCwd).then((moves) => {
      setMovePages(moves.filter((m) => m.page && m.page.nav !== false));
    }).catch(() => setMovePages([]));
  }, [projectCwd]);
  const activeMovePageName = getMovePageName(view);

  const customPages = activeUP?.dashboard?.pages ?? [];
  const gitPageBlocks = [
    {
      kind: "module" as const,
      id: "git-main",
      title: "git",
      module: "git" as const,
    },
  ];
  const navViews = [
    ...NAV_VIEWS,
    ...movePages.map((m) => ({
      view: movePageView(m.name),
      label: m.page!.title,
    })),
    ...customPages.map((page) => ({
      view: customPageView(page.id),
      label: page.title,
    })),
  ];
  const activeCustomPage = customPages.find((page) => page.id === getCustomPageId(view));

  useEffect(() => {
    if (getCustomPageId(view) && !activeCustomPage) {
      navigate("home");
    }
  }, [activeCustomPage, navigate, view]);

  useEffect(() => {
    if (!activeUserProfile) return;
    if (!activeSession?.id || activeSession.id.startsWith("pending-")) return;
    if (uiState.lastSessionId === activeSession.id) return;
    saveUiState({ lastSessionId: activeSession.id });
  }, [activeSession?.id, activeUserProfile, saveUiState, uiState.lastSessionId]);

  useEffect(() => {
    if (view !== "chat" || !hashSessionId) return;
    if (activeSession?.id === hashSessionId) return;
    selectSession(hashSessionId);
  }, [hashSessionId, selectSession, view]); // activeSession intentionally omitted to avoid hash/session ping-pong

  // Bare #profile/chat (no session in URL) → restore last session for this profile
  useEffect(() => {
    if (view !== "chat" || hashSessionId) return;
    if (!restorableLastSessionId) return;
    selectSession(restorableLastSessionId);
    setUrlSession(restorableLastSessionId, activeUserProfile);
  }, [view, hashSessionId, restorableLastSessionId, selectSession, setUrlSession, activeUserProfile]);

  return (
    <div className="app">
      <div className="top-nav">
        <button className="menu-btn" onClick={() => setSidebarOpen(true)}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M3 4.5h12M3 9h12M3 13.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
        <span className="top-nav-logo" onClick={() => navigate("home")}><MoLogo size={16} activeCount={activeAgentCount} /></span>
        <nav className="top-nav-links">
          {navViews.map((nv) => (
            <button
              key={nv.view}
              className={`top-nav-link${view === nv.view ? " active" : ""}`}
              onClick={() => handleNavigate(nv.view)}
            >
              {nv.label}
            </button>
          ))}
        </nav>
        <div className="top-nav-spacer" />
        {view === "chat" && activeSession?.id && !activeSession.id.startsWith("pending-") && serverSessions.length > 0 && !serverSessions.some((s) => s.id === activeSession.id) && (
          <span className="chat-header-archived">archived</span>
        )}
        <StatusBar
          harnessUp={harnessUp}
          onLock={handleLock}
          userProfiles={userProfiles}
          activeUserProfile={activeUserProfile}
          onSwitchUserProfile={handleSwitchUserProfile}
          onNewProfile={() => { setForceSetup(true); navigate("home"); }}
          onUserSettings={() => setShowUserSettings(true)}
          computer={activeUP?.computer}
          projectPath={activeUP?.projects?.[0]}
        />
      </div>

      <div className="app-body">
        <Sidebar
          open={sidebarOpen}
          collapsed={sidebarCollapsed}
          sessions={serverSessions.map((s) => {
            const storeState = getSessionState(s.id);
            return storeState ? { ...s, status: storeState.status ?? s.status } : s;
          })}
          activeSessionId={activeSession?.id ?? null}
          profiles={visibleProfiles}
          selectedProfile={selectedProfile}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onArchiveSession={archiveSession}
          activeInput={input}
          onSelectProfile={selectProfile}
          onSetupChange={setSetupState}
          setupState={setupState}
          onClose={() => setSidebarOpen(false)}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
          initialGroupMode={uiState.sidebarGroupMode}
          initialCollapsedGroups={uiState.sidebarCollapsedGroups}
          onGroupModeChange={(mode) => saveUiState({ sidebarGroupMode: mode })}
          onCollapsedGroupsChange={(groups) => saveUiState({ sidebarCollapsedGroups: groups })}
          activeUserProfileObj={activeUP}
          availableProviders={availableProviders}
          navLinks={[{ view: "home" as const, label: "home" }, ...navViews]}
          currentView={view}
          onNavigate={handleNavigate}
          navOnly={view !== "chat"}
          onTogglePin={handleTogglePin}
        />

        {view === "chat" && (
          <>
            <LeftPanel
              open={leftPanelOpen}
              width={leftPanelWidth}
              onOpen={() => setLeftPanelOpen(true)}
              onClose={() => setLeftPanelOpen(false)}
              widgets={(profileData?.ui?.panelWidgets ?? ["config-inspector", "session-info", "moves"]).map(
                (type, i) => ({ id: `left-${type}-${i}`, type })
              )}
              onNavigate={handleNavigate}
              onSelectSession={handleSelectSession}
            />
            {leftPanelOpen && <ResizeHandle side="left" onResize={handleLeftResize} />}
            <PanelCollapseTab
              side="left"
              open={leftPanelOpen}
              onToggle={() => setLeftPanelOpen((o) => !o)}
              openTitle="Open widgets panel"
              closeTitle="Collapse panel"
            />
            <div className="chat">
              <ChatView
                key={activeSession?.id ?? "empty"}
                messages={activeSession?.messages ?? []}
                sessionId={activeSession?.id ?? null}
                sessionTags={activeSessionTags}
                provider={liveProvider}
                profileName={activeProfileName}
                model={liveModel}
                streaming={isStreaming}
                streamFeed={activeSession?.streamFeed}
                showThinking={ui.showThinking}
                showMeta={ui.showMeta}
                showToolCalls={ui.showToolCalls}
                showGitEvents={ui.showGitEvents}
                cwd={activeSession?.cwd ?? serverSessions.find(s => s.id === activeSession?.id)?.cwd ?? setupState.cwd ?? null}
                emptyTitle={ui.emptyTitle ?? activeProfileName}
                emptySubtitle={ui.emptySubtitle}
                queuedMessage={queuedMessage}
                onCancelQueued={cancelQueued}
                onSessionTagsChange={refreshSessions}
                onBranch={branchFromMessage}
                onStopTask={stopTask}
                onOpenSessionEdits={() => { setRightPanelOpen(true); setRequestRightPanelView("session-edits"); }}
              />

              {activeSession?.pendingPermissions && activeSession.pendingPermissions.length > 0 && (
                <PermissionOverlay
                  permissions={activeSession.pendingPermissions}
                  sessionId={activeSession.id}
                  onRespond={handlePermissionResponse}
                />
              )}

              <ConfigBar
                profileName={activeProfileName}
                pendingProfileName={activeSession?.nextProfile}
                model={liveModel}
                agentConfig={activeSession ? activeSession.agentConfig : setupState.agent}
                editorConfig={editorAgentConfig}
                onAgentConfigChange={updateActiveSessionConfig}
                profileTools={profileData?.tools ?? "all"}
                editorProfileTools={
                  sessionProviderLocked && !pendingProfileProviderMatches
                    ? (profileData?.tools ?? "all")
                    : (editorProfileData?.tools ?? "all")
                }
                availableProviders={availableProviders}
                profileProvider={liveProvider}
                editorProfileProvider={
                  sessionProviderLocked
                    ? liveProvider
                    : editorProfileProvider
                }
                editorProfileModel={
                  pendingProfileProviderMatches
                    ? editorProfileModel
                    : undefined
                }
                profileEffort={activeSession ? (profileData?.effort ?? activeUP?.effort) : (activeUP?.effort ?? profileData?.effort)}
                editorProfileEffort={activeSession ? (editorProfileData?.effort ?? activeUP?.effort) : (activeUP?.effort ?? editorProfileData?.effort)}
                editorProfileMaxTurns={editorProfileData?.maxTurns}
                showProvider={!!activeSession && !sessionProviderLocked}
                availableTools={activeSession?.availableTools}
                profiles={visibleProfiles}
                onSwitchProfile={handleSwitchProfile}
                sessionTags={activeSessionTags}
                onTogglePin={activeSession?.id && !activeSession.id.startsWith("pending-") ? () => handleTogglePin(activeSession.id) : undefined}
                status={activeSession?.status}
                sessionId={activeSession?.id}
                messages={activeSession?.messages}
                createdAt={activeSession?.createdAt}
                updatedAt={activeSession?.updatedAt}
                totalCost={activeSession?.totalCost}
                cwd={activeSession?.cwd}
              />
              <ChatInput
                value={input}
                onChange={handleInputChange}
                onSend={send}
                onStop={stop}
                sessionStatus={activeSession?.status ?? null}
                disabled={harnessUp === false}
                placeholder={ui.placeholder}
                sessionId={activeSession?.id}
                projectCwd={activeSession?.cwd ?? serverSessions.find(s => s.id === activeSession?.id)?.cwd ?? setupState.cwd}
                userProfile={activeUserProfile ?? undefined}
                autoFocus={view === "chat" && !!activeSession?.id}
                onMoveAttached={(result) => {
                  // Widget-first: mount widget immediately on attach (before any message)
                  const widgetSessionId = activeSession?.id ?? "";
                  console.log(`[onMoveAttached] widget pre-mount: sessionId=${widgetSessionId} apiToken=${result.apiToken} instanceId=${result.instanceId}`);
                  widgetJustSetRef.current = true;
                  const newWidget = {
                    widget: result.widget,
                    apiToken: result.apiToken,
                    instanceId: result.instanceId,
                    sessionId: widgetSessionId,
                    mountedOnAttach: true,
                  };
                  setActiveMoveWidgets(prev => {
                    const filtered = prev.filter(w => w.instanceId !== result.instanceId);
                    return [...filtered, newWidget];
                  });
                  setRightPanelOpen(true);
                }}
                onMoveDetached={(apiToken) => {
                  // Remove widget when move is detached
                  setActiveMoveWidgets(prev => prev.filter(w => w.apiToken !== apiToken));
                }}
                onMoveActivated={(result) => {
                  refreshSessions();
                  const cwd = activeSession?.cwd ?? serverSessions.find(s => s.id === activeSession?.id)?.cwd ?? setupState.cwd;
                  loadAndApplyProjectUiState(cwd || undefined);
                  if (result.spawnedSessionId) {
                    selectSession(result.spawnedSessionId);
                    setUrlSession(result.spawnedSessionId, activeUserProfile);
                  }
                  if (result.widget && result.apiToken && result.instanceId && activeSession?.id) {
                    const widgetSessionId = result.spawnedSessionId ?? activeSession.id;
                    console.log(`[onMoveActivated] widget set: sessionId=${widgetSessionId} apiToken=${result.apiToken} instanceId=${result.instanceId}`);
                    widgetJustSetRef.current = true;
                    const newWidget = {
                      widget: result.widget,
                      apiToken: result.apiToken,
                      instanceId: result.instanceId,
                      sessionId: widgetSessionId,
                    };
                    // Replace existing entry for same instanceId, or append
                    setActiveMoveWidgets(prev => {
                      const filtered = prev.filter(w => w.instanceId !== result.instanceId);
                      return [...filtered, newWidget];
                    });
                    if (result.widget.autoOpen) setRightPanelOpen(true);
                  }
                }}
              />
            </div>
            <PanelCollapseTab
              side="right"
              open={rightPanelOpen}
              onToggle={() => setRightPanelOpen((o) => !o)}
              openTitle="Open viewer panel"
              closeTitle="Collapse panel"
            />
            {rightPanelOpen && <ResizeHandle side="right" onResize={handleRightResize} />}
            <RightPanel
              open={rightPanelOpen}
              width={rightPanelWidth}
              onOpen={() => setRightPanelOpen(true)}
              onClose={() => setRightPanelOpen(false)}
              moveWidgets={activeMoveWidgets}
              initialBrowserPath={rightPanelBrowserPath}
              onBrowserPathChange={setRightPanelBrowserPath}
              messages={activeSession?.messages}
              requestView={requestRightPanelView}
              onRequestViewHandled={() => setRequestRightPanelView(null)}
              onWidgetClose={(apiToken, moveName) => {
                setActiveMoveWidgets(prev => prev.filter(w => w.apiToken !== apiToken));
                detachMoveApi(moveName, apiToken).catch(() => {});
              }}
              onSendToAgent={(text) => handleInputChange(input ? `${input}\n${text}` : text)}
            />
          </>
        )}

        {view === "home" && (
          <Dashboard
            onNavigate={navigate}
            onSelectSession={handleViewSession}
            forceSetup={forceSetup}
            onSetupDone={() => setForceSetup(false)}
          />
        )}

        {view === "profiles" && (
          <Profiles onSelectSession={handleViewSession} onNavigate={navigate} />
        )}

        {activeMovePageName && projectCwd && (
          <MovePageView
            moveName={activeMovePageName}
            cwd={projectCwd}
            userProfile={activeUserProfile ?? undefined}
          />
        )}
        {view === "actions" && <Actions onSelectSession={handleViewSession} onPeekSession={handlePeekSession} />}
        {view === "web" && <SessionWeb />}
        {view === "trace" && <TraceView />}

        {view === "git" && (
          <PageView
            blocks={gitPageBlocks}
            onNavigate={navigate}
            onSelectSession={handleViewSession}
          />
        )}
        {activeCustomPage && (
          <PageView
            blocks={activeCustomPage.blocks}
            onNavigate={navigate}
            onSelectSession={handleViewSession}
          />
        )}
      </div>

      <SessionWindow
        sessionId={floatingSessionId}
        onClose={() => setFloatingSessionId(null)}
        onNavigate={(id) => { setFloatingSessionId(null); handleViewSession(id); }}
      />

      <AgentPortal
        sessions={serverSessions.map((s) => {
          const storeState = getSessionState(s.id);
          return storeState ? { ...s, status: storeState.status ?? s.status } : s;
        })}
        onNavigateSession={handleViewSession}
        onPeekSession={handlePeekSession}
      />

      {showUserSettings && activeUP && (
        <UserSettingsModal
          userProfile={activeUP}
          onClose={() => setShowUserSettings(false)}
          onSave={async (patch) => {
            if (!activeUserProfile) return;
            const { name: _name, ...rest } = activeUP;
            const nextProfile = {
              ...rest,
              ...patch,
            } as Omit<typeof activeUP, "name"> & Record<string, unknown>;
            Object.keys(nextProfile).forEach((key) => {
              if (nextProfile[key] === undefined) delete nextProfile[key];
            });
            await saveUserProfileApi(activeUserProfile, nextProfile);
            await refreshUserProfiles();
            if ("defaultAgentProfile" in patch) {
              selectProfile(patch.defaultAgentProfile?.trim() || "");
            }
          }}
        />
      )}
    </div>
  );
}

export default App;
