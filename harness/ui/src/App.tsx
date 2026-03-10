import { useState, useEffect, useCallback } from "react";
import type { ProfileUi } from "./api";
import { healthCheck, switchSessionProfile } from "./api";
import { NAV_VIEWS } from "./views";
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
import { Profiles } from "./components/Profiles";
import { MemoryViz } from "./components/MemoryViz";
import { Actions } from "./components/Actions";
import { GitPanel } from "./components/GitPanel";
import { PermissionOverlay } from "./components/PermissionOverlay";
import { MoLogo } from "./components/MoLogo";
import { StatusBar } from "./components/sidebar/StatusBar";

function App() {
  return (
    <AuthProvider>
      <ProfileProvider>
        <SessionProvider>
          <AppShell />
        </SessionProvider>
      </ProfileProvider>
    </AuthProvider>
  );
}

function AppShell() {
  const { userName, handleLock } = useAuth();
  const {
    profiles, visibleProfiles, availableProviders, userProfiles,
    activeUserProfile, activeUP,
    selectedProfile, selectProfile,
    setupState, setSetupState,
    uiState, saveUiState, switchUserProfile,
  } = useProfiles();
  const {
    activeSession, serverSessions,
    input, handleInputChange,
    send, stop, newSession, selectSession, archiveSession,
    handlePermissionResponse, updateActiveSessionConfig,
    queuedMessage, cancelQueued, branchFromMessage,
  } = useSession();
  const { view, navigate, hashProfile, setUrlProfile, consumeHashProfile } = useHashRouter();

  // ── Local UI state ──
  const [harnessUp, setHarnessUp] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [forceSetup, setForceSetup] = useState(false);

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
  const handleNewSession = useCallback(() => {
    newSession();
    setSidebarOpen(false);
  }, [newSession]);

  const handleSelectSession = useCallback((id: string) => {
    selectSession(id);
    setSidebarOpen(false);
  }, [selectSession]);

  // Wrap switchUserProfile to also update URL
  const handleSwitchUserProfile = useCallback((name: string | null) => {
    switchUserProfile(name);
    setUrlProfile(name);
  }, [switchUserProfile, setUrlProfile]);

  // Switch profile on live session (ConfigBar controls this)
  const handleSwitchProfile = useCallback((name: string) => {
    if (activeSession?.id && !activeSession.id.startsWith("pending-")) {
      switchSessionProfile(activeSession.id, name).catch(() => {});
    }
  }, [activeSession?.id]);

  // View-based session navigation (from dashboard/schedules)
  const handleViewSession = useCallback((id: string) => {
    navigate("chat");
    selectSession(id);
  }, [navigate, selectSession]);

  // ── Profile UI resolution ──
  // Config bar shows the active session's profile. Sidebar's selectedProfile
  // is only used when there is NO active session (new chat preview).
  const activeProfileName = activeSession
    ? activeSession.profile          // session owns its profile (never leak sidebar)
    : selectedProfile;               // no session → sidebar preview only
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
  };
  const isStreaming = activeSession?.status === "running" || activeSession?.status === "starting";
  const profileData = profiles.find((p) => p.name === activeProfileName);
  const activeAgentCount = serverSessions.filter(s => {
    const status = getSessionState(s.id)?.status ?? s.status;
    return status === "running" || status === "starting";
  }).length;

  return (
    <div className="app">
      <div className="top-nav">
        {view === "chat" && (
          <button className="menu-btn" onClick={() => setSidebarOpen(true)}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M3 4.5h12M3 9h12M3 13.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        )}
        <span className="top-nav-logo" onClick={() => navigate("home")}><MoLogo size={16} activeCount={activeAgentCount} /></span>
        <nav className="top-nav-links">
          {NAV_VIEWS.map((nv) => (
            <button
              key={nv.view}
              className={`top-nav-link${view === nv.view ? " active" : ""}`}
              onClick={() => navigate(nv.view)}
            >
              {nv.label}
            </button>
          ))}
        </nav>
        <div className="top-nav-spacer" />
        {view === "chat" && activeSession?.status && activeSession.status !== "done" && (
          <span className={`chat-header-status ${activeSession.status}`}>{activeSession.status}</span>
        )}
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
        />
      </div>

      <div className="app-body">
        {view === "chat" && (
          <>
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
            />

            <div className="chat">
              <ChatView
                messages={activeSession?.messages ?? []}
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
                onBranch={branchFromMessage}
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
                model={activeSession?.model ?? profileData?.model}
                agentConfig={activeSession ? activeSession.agentConfig : setupState.agent}
                onAgentConfigChange={updateActiveSessionConfig}
                profileTools={profileData?.tools ?? "all"}
                availableProviders={availableProviders}
                profileProvider={profileData?.provider}
                profileModel={activeSession?.model ?? profileData?.model}
                profileEffort={profileData?.effort}
                profileMaxTurns={profileData?.maxTurns}
                availableTools={activeSession?.availableTools}
                profiles={visibleProfiles}
                onSwitchProfile={handleSwitchProfile}
              />
              <ChatInput
                value={input}
                onChange={handleInputChange}
                onSend={send}
                onStop={stop}
                sessionStatus={activeSession?.status ?? null}
                disabled={harnessUp === false}
                placeholder={ui.placeholder}
                activeToolName={activeSession?.activeToolName}
                activeToolElapsed={activeSession?.activeToolElapsed}
              />
            </div>
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

        {view === "memory" && <MemoryViz initialTagFilter={activeUP?.memoryFilter} />}
        {view === "actions" && <Actions onSelectSession={handleViewSession} />}
        {view === "git" && <GitPanel cwd={activeSession?.cwd ?? serverSessions.find(s => s.id === activeSession?.id)?.cwd ?? setupState.cwd ?? null} />}
      </div>
    </div>
  );
}

export default App;
