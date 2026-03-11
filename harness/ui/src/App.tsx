import { useState, useEffect, useCallback } from "react";
import type { ProfileUi } from "./api";
import { healthCheck, saveUserProfileApi } from "./api";
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
import { UserSettingsModal } from "./components/UserSettingsModal";
import { createEmptyAgentConfig } from "./components/AgentConfig";
import { FileViewerProvider } from "./providers/FileViewerProvider";
import { SessionWindow } from "./components/SessionWindow";

function App() {
  return (
    <AuthProvider>
      <ProfileProvider>
        <SessionProvider>
          <FileViewerProvider>
            <AppShell />
          </FileViewerProvider>
        </SessionProvider>
      </ProfileProvider>
    </AuthProvider>
  );
}

function AppShell() {
  const { handleLock } = useAuth();
  const {
    profiles, visibleProfiles, availableProviders, providerCapabilities, userProfiles,
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
  const { view, navigate, hashProfile, setUrlProfile, consumeHashProfile } = useHashRouter();

  // ── Local UI state ──
  const [harnessUp, setHarnessUp] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [forceSetup, setForceSetup] = useState(false);
  const [showUserSettings, setShowUserSettings] = useState(false);
  const [floatingSessionId, setFloatingSessionId] = useState<string | null>(null);

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
      updateActiveSessionProfile(name);
    }
  }, [activeSession?.id, updateActiveSessionProfile]);

  // View-based session navigation (from dashboard/schedules)
  const handleViewSession = useCallback((id: string) => {
    navigate("chat");
    selectSession(id);
  }, [navigate, selectSession]);

  // Peek: pop a floating SessionWindow for any session ID
  const handlePeekSession = useCallback((id: string) => {
    setFloatingSessionId(id);
  }, []);

  // ── Profile UI resolution ──
  // Config bar shows the active session's profile. Sidebar's selectedProfile
  // is only used when there is NO active session (new chat preview).
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
  const activeSessionInfo = activeSession?.id ? serverSessions.find((s) => s.id === activeSession.id) : undefined;
  const editorProfileName = activeSession?.nextProfile ?? activeProfileName;
  const editorProfileData = profiles.find((p) => p.name === editorProfileName);
  const sessionProviderLocked = !!activeSession && activeSession.messages.length > 0;
  const liveProvider = activeSessionInfo?.provider || activeSession?.provider || profileData?.provider || activeUP?.provider;
  const liveModel = activeSession ? activeSession.model : (profileData?.model || activeUP?.model);
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
                provider={liveProvider}
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
                onStopTask={stopTask}
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
                profileEffort={profileData?.effort}
                editorProfileEffort={editorProfileData?.effort}
                editorProfileMaxTurns={editorProfileData?.maxTurns}
                showProvider={!!activeSession && !sessionProviderLocked}
                availableTools={activeSession?.availableTools}
                profiles={visibleProfiles}
                onSwitchProfile={handleSwitchProfile}
                status={activeSession?.status}
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
                onMoveActivated={() => { refreshSessions(); }}
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
        {view === "actions" && <Actions onSelectSession={handleViewSession} onPeekSession={handlePeekSession} />}
        {view === "git" && <GitPanel cwd={activeSession?.cwd ?? serverSessions.find(s => s.id === activeSession?.id)?.cwd ?? setupState.cwd ?? null} />}
      </div>

      <SessionWindow
        sessionId={floatingSessionId}
        onClose={() => setFloatingSessionId(null)}
        onNavigate={(id) => { setFloatingSessionId(null); handleViewSession(id); }}
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
