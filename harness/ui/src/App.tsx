import { useState, useEffect, useCallback, useRef, Component, type ReactNode } from "react";
import type { MoveListItem } from "../../sdk/index";
import { API_BASE, authHeaders, modus } from "./modusClient";
import { customPageView, getCustomPageId, getMovePageName, movePageView, NAV_VIEWS, type View } from "./views";
import { AuthProvider } from "./providers/AuthProvider";
import { useAuth } from "./providers/AuthContext";
import { ProfileProvider } from "./providers/ProfileProvider";
import { useProfiles } from "./providers/ProfileContext";
import { SessionProvider } from "./providers/SessionProvider";
import { useSession } from "./providers/SessionContext";
import { getSessionState } from "./sessionStore";
import { useHashRouter } from "./hooks/useHashRouter";
import { MobileNav } from "./components/MobileNav";
import { Dashboard } from "./components/Dashboard";
import { PageView } from "./components/PageRenderer";
import { MovePageView } from "./components/MovePageView";
import { MoLogo } from "./components/MoLogo";
import { StatusBar } from "./components/sidebar/StatusBar";
import { UserSettingsModal } from "./components/UserSettingsModal";
import { FileViewerProvider } from "./providers/FileViewerProvider";
import { useFileViewer } from "./providers/FileViewerContext";
import { PinboardProvider } from "./providers/PinboardProvider";
import { SessionWindow } from "./components/SessionWindow";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { ResizeHandle } from "./components/ResizeHandle";
import { PanelCollapseTab } from "./components/PanelCollapseTab";
import { LayoutProvider } from "./providers/LayoutProvider";
import { useLayout } from "./providers/LayoutContext";
import { ClientExtensionsBoot } from "./components/ClientExtensionsBoot";
import { AgentPortal } from "./components/AgentPortal";
import { WIDGET_DEFS, widgetHandlesIntent, type DashboardPage } from "./widgets";
import { PagePicker } from "./components/PagePicker";
import { usePageNavPrefs } from "./hooks/usePageNavPrefs";
import {
  countPageWidgets,
  pageNavDirectItems,
  resolvePageNav,
  type PageNavItem,
  type PageNavOrigin,
} from "./pageNav";

import { getInputValue } from "./inputStore";

type ConfigDashboardPage = DashboardPage & {
  origin?: PageNavOrigin;
  source?: string;
};

function pageNavItemFromConfigPage(page: ConfigDashboardPage): PageNavItem {
  return {
    key: customPageView(page.id),
    view: customPageView(page.id),
    id: page.id,
    title: page.title,
    label: page.title,
    origin: page.origin ?? "profile",
    navDefault: page.nav !== false,
    widgetCount: countPageWidgets(page),
    canFork: page.origin !== undefined && page.origin !== "standalone",
  };
}

function pageNavItemFromBareMovePage(move: MoveListItem): PageNavItem | null {
  if (!move.page) return null;
  return {
    key: movePageView(move.name),
    view: movePageView(move.name),
    id: move.page.id,
    title: move.page.title,
    label: move.page.title,
    origin: "move",
    navDefault: move.page.nav !== false,
    canFork: false,
  };
}


class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[modus] uncaught UI error:", error);
    if (info.componentStack) console.error("[modus] component stack:", info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: 16, fontFamily: "monospace", color: "#aaa" }}>
          <div style={{ fontSize: 13 }}>something went wrong</div>
          <div style={{ fontSize: 11, color: "#666", maxWidth: 400, textAlign: "center", wordBreak: "break-word" }}>
            {this.state.error.message}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ padding: "6px 14px", background: "transparent", border: "1px solid #444", borderRadius: 4, color: "#aaa", cursor: "pointer", fontSize: 12 }}
              onClick={() => { this.setState({ error: null }); }}
            >
              retry
            </button>
            <button
              style={{ padding: "6px 14px", background: "transparent", border: "1px solid #444", borderRadius: 4, color: "#aaa", cursor: "pointer", fontSize: 12 }}
              onClick={() => { location.reload(); }}
            >
              reload
            </button>
            <button
              style={{ padding: "6px 14px", background: "transparent", border: "1px solid #555", borderRadius: 4, color: "#aaa", cursor: "pointer", fontSize: 12 }}
              onClick={() => { localStorage.clear(); sessionStorage.clear(); location.reload(); }}
            >
              clear data + reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <AppErrorBoundary>
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
    </AppErrorBoundary>
  );
}

function AppShell() {
  const router = useHashRouter();
  return (
    <LayoutProvider view={router.view}>
      <AppContent router={router} />
    </LayoutProvider>
  );
}

type HashRouter = ReturnType<typeof useHashRouter>;

function AppContent({ router }: { router: HashRouter }) {
  const { view, navigate, hashProfile, hashSessionId, setUrlProfile, setUrlSession, navigateToSession, consumeHashProfile } = router;
  const { authRequired, pinEnabled, handleLock } = useAuth();
  const {
    userProfiles,
    activeUserProfile, activeUP, projectRoot,
    selectProfile,
    setupState,
    uiState, saveUiState, switchUserProfile, refreshUserProfiles,
  } = useProfiles();
  const {
    activeSession, serverSessions, allServerSessions,
    handleInputChange,
    newSession, selectSession,
  } = useSession();
  const { prefs: pageNavPrefs, canSave: canSavePageNavPrefs, savePrefs: savePageNavPrefs } = usePageNavPrefs();

  // Panel state — owned by LayoutProvider
  const {
    leftPanelOpen, leftPanelWidth, leftPanelMode, leftPanelWidgets,
    setLeftPanelOpen, toggleLeftPanel, onLeftPanelWidgetsChange, onLeftPanelModeChange,
    handleLeftResize, handleRightResize,
    rightPanelOpen, rightPanelWidth, rightPanelMode, rightPanelWidgets, rightPanelBrowserPath,
    requestRightPanelView,
    setRightPanelOpen, setRightPanelWidth: _setRightPanelWidth,
    toggleRightPanel, setRightPanelBrowserPath, onRightPanelWidgetsChange, onRightPanelModeChange,
    setRequestRightPanelView,
    leftPanelTree, rightPanelTree,
    panelsEnabled,
  } = useLayout();

  // ── File-open → panel routing ──
  const { subscribeFileOpens } = useFileViewer();
  const panelFileRouteRef = useRef({
    leftPanelWidgets,
    rightPanelWidgets,
    panelsEnabled,
    setLeftPanelOpen,
    setRightPanelOpen,
    onRightPanelWidgetsChange,
    view,
  });
  panelFileRouteRef.current = {
    leftPanelWidgets,
    rightPanelWidgets,
    panelsEnabled,
    setLeftPanelOpen,
    setRightPanelOpen,
    onRightPanelWidgetsChange,
    view,
  };
  useEffect(() => {
    return subscribeFileOpens(() => {
      const {
        leftPanelWidgets: lw,
        rightPanelWidgets: rw,
        panelsEnabled: enabled,
        setLeftPanelOpen: openLeft,
        setRightPanelOpen: openRight,
        onRightPanelWidgetsChange: setRightWidgets,
        view: currentView,
      } = panelFileRouteRef.current;
      if (!enabled) return;
      // Pages with their own code-editor handle file opens internally —
      // don't also pop open the app-level right panel.
      if (currentView === "chat" || getCustomPageId(currentView)) return;
      const hasEditorRight = (rw ?? []).some((w) => widgetHandlesIntent(w, WIDGET_DEFS[w.type], "open-file"));
      const hasEditorLeft = (lw ?? []).some((w) => widgetHandlesIntent(w, WIDGET_DEFS[w.type], "open-file"));
      if (hasEditorRight) {
        openRight(true);
      } else if (hasEditorLeft) {
        openLeft(true);
      } else {
        setRightWidgets([...(rw ?? []), { type: "code-editor" }]);
        openRight(true);
      }
    });
  }, [subscribeFileOpens]);

  // ── Local UI state ──
  const [harnessUp, setHarnessUp] = useState<boolean | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [forceSetup, setForceSetup] = useState(false);
  const [showUserSettings, setShowUserSettings] = useState(false);
  const [floatingSessionId, setFloatingSessionId] = useState<string | null>(null);
  const [activeMoveWidgets, setActiveMoveWidgets] = useState<Array<{
    widget: import("../../sdk/index").MoveWidgetInfo;
    apiToken: string;
    instanceId: string;
    sessionId: string;
    mountedOnAttach?: boolean;
  }>>([]);
  const widgetJustSetRef = useRef(false);

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
            modus.rekeyMoveByToken(w.apiToken, id).catch((e) =>
              console.error(`[App] rekeyMoveByToken FAILED for ${w.apiToken}:`, e)
            );
          }
        }
        return prev.map(w => ({ ...w, sessionId: id }));
      });
      return;
    }
    modus.getActiveWidgets(id).then((widgets) => {
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
      modus.getActiveWidgets(id).then((widgets) => {
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
    const check = () => modus.healthCheck().then(() => setHarnessUp(true)).catch(() => setHarnessUp(false));
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
  const handleNewSession = useCallback(async () => {
    const id = await newSession();
    if (id) {
      await selectSession(id);
      navigateToSession(id, activeUserProfile);
    } else {
      navigate("chat");
    }
  }, [activeUserProfile, navigate, navigateToSession, newSession, selectSession]);

  const projectForSession = useCallback((id: string): string | null => {
    const session = allServerSessions.find((candidate) => candidate.id === id);
    if (!session) return activeUserProfile;
    if (!session.project_id) return null;
    return userProfiles.some((project) => project.name === session.project_id)
      ? session.project_id
      : null;
  }, [activeUserProfile, allServerSessions, userProfiles]);

  const handleSelectSession = useCallback((id: string) => {
    // Selecting the current row is also an explicit retry if its history did
    // not hydrate (for example after a mobile/network interruption).
    const project = projectForSession(id);
    if (project !== activeUserProfile) switchUserProfile(project);
    selectSession(id);
    navigateToSession(id, project);
  }, [activeUserProfile, navigateToSession, projectForSession, selectSession, switchUserProfile]);

  // Wrap switchUserProfile to also update URL
  const handleSwitchUserProfile = useCallback((name: string | null) => {
    switchUserProfile(name);
    setUrlProfile(name);
  }, [switchUserProfile, setUrlProfile]);

  // View-based session navigation (from dashboard/schedules)
  const handleViewSession = useCallback((id: string) => {
    const project = projectForSession(id);
    if (project !== activeUserProfile) switchUserProfile(project);
    selectSession(id);
    setUrlSession(id, project);
  }, [activeUserProfile, projectForSession, selectSession, setUrlSession, switchUserProfile]);

  const handleActivateSession = useCallback((id: string) => {
    const project = projectForSession(id);
    if (project !== activeUserProfile) switchUserProfile(project);
    selectSession(id);
    navigateToSession(id, project);
  }, [selectSession, navigateToSession, activeUserProfile, projectForSession, switchUserProfile]);

  const handleNavigate = useCallback((target: View) => {
    if (target !== "chat") {
      navigate(target);
      return;
    }
    // If we have a session to restore, go straight to it (works even if already on chat)
    const sessionToRestore = restorableLastSessionId ?? activeSession?.id;
    if (sessionToRestore) {
      selectSession(sessionToRestore);
      navigateToSession(sessionToRestore, activeUserProfile);
    } else {
      navigate("chat");
    }
  }, [activeSession?.id, activeUserProfile, navigate, navigateToSession, restorableLastSessionId, selectSession]);

  // Peek: pop a floating SessionWindow for any session ID
  const handlePeekSession = useCallback((id: string) => {
    setFloatingSessionId(id);
  }, []);



  const activeAgentCount = serverSessions.filter(s => {
    const status = getSessionState(s.id)?.status ?? s.status;
    return status === "running" || status === "starting" || status === "interrupting";
  }).length;
  // ── Move pages (moves that declare a page field) ──
  const [movePages, setMovePages] = useState<MoveListItem[]>([]);
  const [configPages, setConfigPages] = useState<ConfigDashboardPage[]>([]);
  const [mountedCustomPageIds, setMountedCustomPageIds] = useState<string[]>([]);
  const projectCwd = projectRoot ?? activeSession?.cwd ?? serverSessions.find(s => s.id === activeSession?.id)?.cwd ?? setupState.cwd;
  useEffect(() => {
    if (!projectCwd) {
      setMovePages([]);
      return;
    }
    modus.listMoves(projectCwd).then((moves) => {
      setMovePages(moves.filter((m) => m.page));
    }).catch(() => setMovePages([]));
  }, [projectCwd]);
  useEffect(() => {
    if (!projectCwd) {
      setConfigPages([]);
      return;
    }
    fetch(`${API_BASE}/api/pages?cwd=${encodeURIComponent(projectCwd)}`, {
      headers: authHeaders(),
    })
      .then((res) => res.ok ? res.json() : [])
      .then((pages) => setConfigPages(Array.isArray(pages) ? pages : []))
      .catch(() => setConfigPages([]));
  }, [projectCwd]);
  const activeMovePageName = getMovePageName(view);

  const profilePages = (activeUP?.dashboard?.pages ?? []) as ConfigDashboardPage[];
  const customPages = [
    ...configPages,
    ...profilePages.filter((page) => !configPages.some((configPage) => configPage.id === page.id)),
  ];
  // Move pages that have layouts are already in configPages (via unified page
  // discovery). Only include bare-widget move pages (no layout) as move-page: entries.
  const bareMovePagesNav = movePages
    .filter((m) => !m.page?.layout)
    .filter((m) => !customPages.some((cp) => cp.id === m.page?.id));
  const bareMovePageItems = bareMovePagesNav
    .map(pageNavItemFromBareMovePage)
    .filter((item): item is PageNavItem => Boolean(item));
  const pageNavItems = [
    ...bareMovePageItems,
    ...customPages.map((page) => pageNavItemFromConfigPage(page as ConfigDashboardPage)),
  ];
  const resolvedPageNav = resolvePageNav(pageNavItems, pageNavPrefs);
  const topPageNavItems = pageNavDirectItems(resolvedPageNav);
  const navViews = [
    ...NAV_VIEWS,
    ...topPageNavItems.map((page) => ({
      view: page.view,
      label: page.label,
    })),
  ];
  const activeCustomPage = customPages.find((page) => page.id === getCustomPageId(view));
  const chatStudioPage = configPages.find(p => p.id === "chat-studio");
  const isFullscreenPage = view === "chat"
    ? !!chatStudioPage?.fullscreen
    : !!activeCustomPage?.fullscreen;
  const shouldShowAppPanels = panelsEnabled && !isFullscreenPage;

  useEffect(() => {
    const customPageId = getCustomPageId(view);
    if (!customPageId) return;
    setMountedCustomPageIds((prev) => (prev.includes(customPageId) ? prev : [...prev, customPageId]));
  }, [view]);

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
        <button className="menu-btn" onClick={() => setMobileNavOpen(true)}>
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
        {pageNavItems.length > 0 && (
          <PagePicker
            pages={pageNavItems}
            activeView={view}
            prefs={pageNavPrefs}
            canEdit={canSavePageNavPrefs}
            variant="compact"
            onNavigate={handleNavigate}
            onPrefsChange={savePageNavPrefs}
          />
        )}
        <button className="top-nav-new-session" onClick={handleNewSession} title="New session">+</button>
        <div className="top-nav-spacer" />
        {view === "chat" && activeSession?.id && !activeSession.id.startsWith("pending-") && serverSessions.length > 0 && !serverSessions.some((s) => s.id === activeSession.id) && (
          <span className="chat-header-archived">archived</span>
        )}
          <StatusBar
            harnessUp={harnessUp}
          onLock={(authRequired || pinEnabled) ? handleLock : undefined}
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
        <MobileNav
          open={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
          navLinks={[
            { view: "home" as const, label: "home" },
            ...NAV_VIEWS,
            ...resolvedPageNav.enabled.map((page) => ({ view: page.view, label: page.label })),
          ]}
          currentView={view}
          onNavigate={handleNavigate}
        />

        {/* ── Left Panel (view-independent, hidden on fullscreen pages) ── */}
        {shouldShowAppPanels && (
          <>
            <LeftPanel
              open={leftPanelOpen}
              width={leftPanelWidth}
              onOpen={() => setLeftPanelOpen(true)}
              onClose={() => setLeftPanelOpen(false)}
              mode={leftPanelMode}
              widgets={leftPanelWidgets}
              tree={leftPanelTree}
              onWidgetsChange={onLeftPanelWidgetsChange}
              onModeChange={onLeftPanelModeChange}
              onNavigate={handleNavigate}
              onSelectSession={handleSelectSession}
            />
            {leftPanelOpen && <ResizeHandle side="left" onResize={handleLeftResize} />}
            <PanelCollapseTab
              side="left"
              open={leftPanelOpen}
              onToggle={toggleLeftPanel}
              openTitle="Open widgets panel"
              closeTitle="Collapse panel"
            />
          </>
        )}

        {/* ── Center Content (view-dependent) ── */}
        {view === "chat" && chatStudioPage && (
            <PageView
              blocks={chatStudioPage.blocks}
              layout={chatStudioPage.layout as any}
              layouts={chatStudioPage.layouts as any}
              context={(chatStudioPage as any).context}
              padding={chatStudioPage.padding}
              onNavigate={navigate}
              onSelectSession={handleViewSession}
              onActivateSession={handleActivateSession}
              hashSessionId={hashSessionId}
            />
        )}

        {view === "home" && (
          <Dashboard
            onNavigate={navigate}
            onSelectSession={handleViewSession}
            forceSetup={forceSetup}
            onSetupDone={() => setForceSetup(false)}
          />
        )}

        {activeMovePageName && projectCwd && (
          <MovePageView
            moveName={activeMovePageName}
            cwd={projectCwd}
            userProfile={activeUserProfile ?? undefined}
          />
        )}

        {/* ── Right Panel (view-independent, hidden on fullscreen pages) ── */}
        {shouldShowAppPanels && (
          <>
            <PanelCollapseTab
              side="right"
              open={rightPanelOpen}
              onToggle={toggleRightPanel}
              openTitle="Open viewer panel"
              closeTitle="Collapse panel"
            />
            {rightPanelOpen && <ResizeHandle side="right" onResize={handleRightResize} />}
            <RightPanel
              open={rightPanelOpen}
              width={rightPanelWidth}
              onOpen={() => setRightPanelOpen(true)}
              onClose={() => setRightPanelOpen(false)}
              mode={rightPanelMode}
              widgets={rightPanelWidgets}
              tree={rightPanelTree}
              onWidgetsChange={onRightPanelWidgetsChange}
              onModeChange={onRightPanelModeChange}
              moveWidgets={activeMoveWidgets}
              initialBrowserPath={rightPanelBrowserPath}
              onBrowserPathChange={setRightPanelBrowserPath}
              messages={activeSession?.messages}
              requestView={requestRightPanelView}
              onRequestViewHandled={() => setRequestRightPanelView(null)}
              onWidgetClose={(apiToken, moveName) => {
                setActiveMoveWidgets(prev => prev.filter(w => w.apiToken !== apiToken));
                modus.detachMove(moveName, apiToken).catch(() => {});
              }}
              sessionId={activeSession?.id}
              onSendToAgent={(text) => { const current = getInputValue(); handleInputChange(current ? `${current}\n${text}` : text); }}
            />
          </>
        )}
          {customPages
            .filter((page) => mountedCustomPageIds.includes(page.id))
            .map((page) => {
              const isActive = activeCustomPage?.id === page.id;
              return (
                <div key={page.id} style={{ display: isActive ? "contents" : "none" }}>
                  <PageView
                    blocks={page.blocks}
                    layout={page.layout as any}
                    layouts={(page as any).layouts}
                    context={(page as any).context}
                    padding={(page as any).padding}
                    onNavigate={navigate}
                    onSelectSession={handleViewSession}
                    onActivateSession={handleActivateSession}
                    hashSessionId={isActive ? hashSessionId : null}
                  />
                </div>
              );
            })}
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
            const {
              computer, editor, interface: interfaceConfig, pageNav, layouts, leftPanel,
              dashboard, clientExtensions, ...corePatch
            } = patch;
            const uiPatch = {
              ...(computer !== undefined ? { computer } : {}),
              ...(editor !== undefined ? { editor } : {}),
              ...(interfaceConfig !== undefined ? { interface: interfaceConfig } : {}),
              ...(pageNav !== undefined ? { pageNav } : {}),
              ...(layouts !== undefined ? { layouts } : {}),
              ...(leftPanel !== undefined ? { leftPanel } : {}),
              ...(dashboard !== undefined ? { dashboard } : {}),
              ...(clientExtensions !== undefined ? { clientExtensions } : {}),
            };
            if (Object.keys(corePatch).length > 0) {
              await modus.patchUserProfile(activeUserProfile, corePatch);
            }
            if (Object.keys(uiPatch).length > 0) {
              await modus.patchUserProfileUiConfig(activeUserProfile, uiPatch);
            }
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
