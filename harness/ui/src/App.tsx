import { useState, useEffect, useCallback } from "react";
import type { ProfileUi } from "./api";
import { healthCheck } from "./api";
import { AuthProvider, useAuth } from "./providers/AuthProvider";
import { ProfileProvider, useProfiles } from "./providers/ProfileProvider";
import { SessionProvider, useSession } from "./providers/SessionProvider";
import { useHashRouter } from "./hooks/useHashRouter";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { ChatInput } from "./components/ChatInput";
import { ConfigBar } from "./components/ConfigBar";
import { Dashboard } from "./components/Dashboard";
import { MemoryViz } from "./components/MemoryViz";
import { Schedules } from "./components/Schedules";
import { GitPanel } from "./components/GitPanel";
import { PermissionOverlay } from "./components/PermissionOverlay";
import { MoLogo } from "./components/MoLogo";

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
    profiles, visibleProfiles, userProfiles,
    activeUserProfile, activeUP,
    selectedProfile, selectProfile,
    setupState, setSetupState,
    liveAgentConfig, setLiveAgentConfig,
    uiState, saveUiState, switchUserProfile, refreshUserProfiles,
  } = useProfiles();
  const {
    activeSession, serverSessions,
    input, handleInputChange,
    send, stop, newSession, selectSession, archiveSession,
    handlePermissionResponse,
  } = useSession();
  const { view, navigate } = useHashRouter();

  // ── Local UI state ──
  const [harnessUp, setHarnessUp] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Health check
  useEffect(() => {
    const check = () => healthCheck().then(() => setHarnessUp(true)).catch(() => setHarnessUp(false));
    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, []);

  // Wrap session actions with sidebar close
  const handleNewSession = useCallback(() => {
    newSession();
    setSidebarOpen(false);
  }, [newSession]);

  const handleSelectSession = useCallback((id: string) => {
    selectSession(id);
    setSidebarOpen(false);
  }, [selectSession]);

  const handleProfileCreated = useCallback(async (name: string) => {
    await refreshUserProfiles();
    switchUserProfile(name);
  }, [refreshUserProfiles, switchUserProfile]);

  // View-based session navigation (from dashboard/schedules)
  const handleViewSession = useCallback((id: string) => {
    navigate("chat");
    selectSession(id);
  }, [navigate, selectSession]);

  // ── Profile UI resolution ──
  const activeProfileName = activeSession?.profile ?? selectedProfile;
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
        <span className="top-nav-logo" onClick={() => navigate("dashboard")}><MoLogo size={16} /></span>
        <nav className="top-nav-links">
          <button className={`top-nav-link${view === "chat" ? " active" : ""}`} onClick={() => navigate("chat")}>sessions</button>
          <button className={`top-nav-link${view === "memory" ? " active" : ""}`} onClick={() => navigate("memory")}>memory</button>
          <button className={`top-nav-link${view === "schedules" ? " active" : ""}`} onClick={() => navigate("schedules")}>schedules</button>
          <button className={`top-nav-link${view === "git" ? " active" : ""}`} onClick={() => navigate("git")}>git</button>
        </nav>
        {view === "chat" && activeSession?.status && activeSession.status !== "done" && (
          <span className={`chat-header-status ${activeSession.status}`}>{activeSession.status}</span>
        )}
        {view === "chat" && activeSession?.id && !activeSession.id.startsWith("pending-") && serverSessions.length > 0 && !serverSessions.some((s) => s.id === activeSession.id) && (
          <span className="chat-header-archived">archived</span>
        )}
      </div>

      <div className="app-body">
        {view === "chat" && (
          <>
            <Sidebar
              open={sidebarOpen}
              collapsed={sidebarCollapsed}
              sessions={serverSessions.map((s) =>
                activeSession && s.id === activeSession.id
                  ? { ...s, status: activeSession.status ?? s.status }
                  : s
              )}
              activeSessionId={activeSession?.id ?? null}
              profiles={visibleProfiles}
              selectedProfile={selectedProfile}
              harnessUp={harnessUp}
              onNewSession={handleNewSession}
              onSelectSession={handleSelectSession}
              onArchiveSession={archiveSession}
              onSelectProfile={selectProfile}
              onSetupChange={setSetupState}
              setupState={setupState}
              onClose={() => setSidebarOpen(false)}
              onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
              onLock={handleLock}
              userName={userName}
              userProfiles={userProfiles}
              activeUserProfile={activeUserProfile}
              onSwitchUserProfile={switchUserProfile}
              onProfileCreated={handleProfileCreated}
              allProfiles={profiles}
              initialGroupMode={uiState.sidebarGroupMode}
              initialCollapsedGroups={uiState.sidebarCollapsedGroups}
              onGroupModeChange={(mode) => saveUiState({ sidebarGroupMode: mode })}
              onCollapsedGroupsChange={(groups) => saveUiState({ sidebarCollapsedGroups: groups })}
              activeUserProfileObj={activeUP}
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
                cwd={setupState.cwd || serverSessions.find(s => s.id === activeSession?.id)?.cwd || null}
                emptyTitle={ui.emptyTitle ?? activeProfileName}
                emptySubtitle={ui.emptySubtitle}
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

        {view === "dashboard" && (
          <Dashboard onSelectSession={handleViewSession} onNavigate={navigate} />
        )}

        {view === "memory" && <MemoryViz initialTagFilter={activeUP?.memoryFilter} />}
        {view === "schedules" && <Schedules onSelectSession={handleViewSession} />}
        {view === "git" && <GitPanel cwd={setupState.cwd || serverSessions.find(s => s.id === activeSession?.id)?.cwd || null} />}
      </div>
    </div>
  );
}

export default App;
