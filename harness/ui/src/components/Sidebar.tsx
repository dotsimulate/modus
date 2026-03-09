import { useState, useRef, useCallback, useEffect } from "react";
import type { Profile, SessionInfo, SearchHit, UserProfile } from "../api";
import { searchSessionsScoped } from "../api";
import type { SessionSetupState } from "./SessionSetup";
import { SessionList } from "./sidebar/SessionList";
import { SearchResults } from "./sidebar/SearchResults";
import { ProfilePanel } from "./sidebar/ProfilePanel";

type GroupMode = "time" | "project";

type Props = {
  open: boolean;
  collapsed: boolean;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  profiles: Profile[];
  selectedProfile: string;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onArchiveSession: (id: string) => void;
  onSelectProfile: (name: string) => void;
  onSetupChange: (setup: SessionSetupState) => void;
  setupState: SessionSetupState;
  onClose: () => void;
  onToggleCollapse: () => void;
  initialGroupMode?: GroupMode;
  initialCollapsedGroups?: string[];
  onGroupModeChange?: (mode: GroupMode) => void;
  onCollapsedGroupsChange?: (groups: string[]) => void;
  activeUserProfileObj?: UserProfile | null;
  availableProviders?: string[];
};

export function Sidebar({
  open, collapsed, sessions, activeSessionId,
  profiles, selectedProfile,
  onNewSession, onSelectSession, onArchiveSession,
  onSelectProfile, onSetupChange, setupState,
  onClose, onToggleCollapse,
  initialGroupMode, initialCollapsedGroups,
  onGroupModeChange, onCollapsedGroupsChange,
  activeUserProfileObj, availableProviders,
}: Props) {
  const [groupMode, setGroupMode] = useState<GroupMode>(initialGroupMode ?? "time");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleSetGroupMode = useCallback((mode: GroupMode) => {
    setGroupMode(mode);
    onGroupModeChange?.(mode);
  }, [onGroupModeChange]);

  const doSearch = useCallback((q: string) => {
    clearTimeout(searchTimer.current);
    if (!q.trim()) { setSearchResults([]); setSearching(false); return; }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const hits = await searchSessionsScoped(q, 20, activeUserProfileObj?.name ?? undefined);
        setSearchResults(hits);
      } catch { /* silent */ }
      setSearching(false);
    }, 250);
  }, [activeUserProfileObj?.name]);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  return (
    <>
      {open && <div className="sidebar-overlay" onClick={onClose} />}
      <div className={`sidebar ${open ? "open" : ""} ${collapsed ? "collapsed" : ""}`}>
        <div className="sidebar-header">
          <button
            className="sidebar-collapse-btn"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              {collapsed ? (
                <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              ) : (
                <path d="M9 3L5 7l4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              )}
            </svg>
          </button>
          <button className="new-session-btn" onClick={onNewSession}>
            {collapsed ? "+" : "+ new session"}
          </button>
        </div>

        <div className="sidebar-sections">
          {!collapsed && (
            <div className="sidebar-controls">
              <div className="sidebar-search-wrap">
                <input
                  className="sidebar-search"
                  type="text"
                  placeholder="search sessions..."
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); doSearch(e.target.value); }}
                  onKeyDown={(e) => { if (e.key === "Escape") { setSearchQuery(""); setSearchResults([]); (e.target as HTMLInputElement).blur(); } }}
                />
                {searchQuery && (
                  <button className="sidebar-search-clear" onClick={() => { setSearchQuery(""); setSearchResults([]); }}>×</button>
                )}
              </div>
              <div className="group-toggle">
                <button
                  className={`group-toggle-btn ${groupMode === "time" ? "group-toggle-btn--active" : ""}`}
                  onClick={() => handleSetGroupMode("time")}
                >
                  time
                </button>
                <button
                  className={`group-toggle-btn ${groupMode === "project" ? "group-toggle-btn--active" : ""}`}
                  onClick={() => handleSetGroupMode("project")}
                >
                  project
                </button>
              </div>
            </div>
          )}

          {searchQuery.trim() ? (
            <SearchResults
              results={searchResults}
              searching={searching}
              activeSessionId={activeSessionId}
              onSelectSession={onSelectSession}
            />
          ) : (
            <SessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              groupMode={groupMode}
              onSelectSession={onSelectSession}
              onArchiveSession={onArchiveSession}
              projectPaths={activeUserProfileObj?.projects}
              initialCollapsedGroups={initialCollapsedGroups}
              onCollapsedGroupsChange={onCollapsedGroupsChange}
            />
          )}
        </div>

        <ProfilePanel
          profiles={profiles}
          availableProviders={availableProviders}
          selectedProfile={selectedProfile}
          onSelectProfile={onSelectProfile}
          setupState={setupState}
          onSetupChange={onSetupChange}
          activeUserProfileObj={activeUserProfileObj}
        />
      </div>
    </>
  );
}
