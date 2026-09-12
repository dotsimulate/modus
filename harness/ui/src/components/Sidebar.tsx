import { useState, useCallback, useEffect } from "react";
import type { Profile, SessionInfo, SearchHit, SearchSort, UserProfile } from "../../../sdk/index";
import { modus } from "../modusClient";
import { scheduleSessionSearch } from "../session-search-request";
import type { SessionSetupState } from "./SessionSetup";
import { SessionList } from "./sidebar/SessionList";
import { SearchResults } from "./sidebar/SearchResults";
import { ProfilePanel } from "./sidebar/ProfilePanel";
import type { View } from "../views";

type GroupMode = "time" | "agent";

type NavLink = { view: View; label: string };

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
  /** Mobile nav links — rendered at top of sidebar when provided */
  navLinks?: NavLink[];
  currentView?: View;
  onNavigate?: (view: View) => void;
  /** When true, hide session-specific content (used on non-chat views) */
  navOnly?: boolean;
  onTogglePin?: (id: string) => void;
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
  navLinks, currentView, onNavigate, navOnly,
  onTogglePin,
}: Props) {
  const [groupMode, setGroupMode] = useState<GroupMode>(initialGroupMode ?? "time");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSort, setSearchSort] = useState<SearchSort>("relevance");
  const searchKey = JSON.stringify([searchQuery.trim(), searchSort, activeUserProfileObj?.name]);
  const [searchState, setSearchState] = useState<{ key: string; hits: SearchHit[] }>({ key: "", hits: [] });
  const [page, setPage] = useState({ key: "", offset: 0 });
  const offset = page.key === searchKey ? page.offset : 0;
  const searchResults = searchState.key === searchKey ? searchState.hits : [];
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => { setPage({ key: "", offset: 0 }); }, [activeUserProfileObj?.name]);

  const handleSetGroupMode = useCallback((mode: GroupMode) => {
    setGroupMode(mode);
    onGroupModeChange?.(mode);
  }, [onGroupModeChange]);

  useEffect(() => {
    setSearchError(null);
    setHasMore(false);
    if (!searchQuery.trim()) { setSearching(false); return; }
    setSearching(true);
    return scheduleSessionSearch(
      (query, options) => modus.searchSessions(query, options),
      searchQuery,
      { limit: 21, offset, sort: searchSort, userProfile: activeUserProfileObj?.name },
      (hits) => {
        setSearchState(previous => {
          const combined = [...(offset && previous.key === searchKey ? previous.hits : []), ...hits.slice(0, 20)];
          return { key: searchKey, hits: [...new Map(combined.map(hit => [hit.session_id, hit])).values()] };
        });
        setHasMore(hits.length > 20);
        setSearching(false);
      },
      (error) => {
        setSearchError(error instanceof Error ? error.message : "Search failed. Please retry.");
        setSearching(false);
      },
    );
  }, [searchQuery, searchSort, activeUserProfileObj?.name, searchKey, offset, retry]);

  return (
    <>
      {open && <div className="sidebar-overlay" onClick={onClose} />}
      <div className={`sidebar ${open ? "open" : ""} ${collapsed ? "collapsed" : ""}${navOnly ? " nav-only" : ""}`}>
        {navLinks && navLinks.length > 0 && (
          <nav className="sidebar-nav">
            {navLinks.map((nv) => (
              <button
                key={nv.view}
                className={`sidebar-nav-link${currentView === nv.view ? " active" : ""}`}
                onClick={() => { onNavigate?.(nv.view); onClose(); }}
              >
                {nv.label}
              </button>
            ))}
          </nav>
        )}

        {!navOnly && (
          <>
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

            <ProfilePanel
          profiles={profiles}
          availableProviders={availableProviders}
          selectedProfile={selectedProfile}
          onSelectProfile={onSelectProfile}
          setupState={setupState}
          onSetupChange={onSetupChange}
          activeUserProfileObj={activeUserProfileObj}
        />

        <div className="sidebar-sections">
          {!collapsed && (
            <div className="sidebar-controls">
              <div className="sidebar-search-wrap">
                <input
                  className="sidebar-search"
                  type="text"
                  placeholder="search sessions..."
                  aria-label="Search sessions"
                  aria-describedby="session-search-help"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setPage({ key: "", offset: 0 }); }}
                  onKeyDown={(e) => { if (e.key === "Escape") { setSearchQuery(""); setPage({ key: "", offset: 0 }); (e.target as HTMLInputElement).blur(); } }}
                />
                {searchQuery && (
                  <button className="sidebar-search-clear" aria-label="Clear search" onClick={() => { setSearchQuery(""); setPage({ key: "", offset: 0 }); }}>×</button>
                )}
              </div>
              <div id="session-search-help" className="sidebar-search-help">All words match. Use "quotes" for a phrase.</div>
              {searchQuery.trim() ? (
                <label className="sidebar-search-sort">
                  Sort
                  <select value={searchSort} onChange={e => { setSearchSort(e.target.value as SearchSort); setPage({ key: "", offset: 0 }); }}>
                    <option value="relevance">Relevance</option>
                    <option value="latest">Latest</option>
                    <option value="oldest">Oldest</option>
                  </select>
                </label>
              ) : <div className="group-toggle">
                <button
                  className={`group-toggle-btn ${groupMode === "time" ? "group-toggle-btn--active" : ""}`}
                  onClick={() => handleSetGroupMode("time")}
                >
                  time
                </button>
                <button
                  className={`group-toggle-btn ${groupMode === "agent" ? "group-toggle-btn--active" : ""}`}
                  onClick={() => handleSetGroupMode("agent")}
                >
                  agent
                </button>
              </div>}
            </div>
          )}

          {searchQuery.trim() ? (
            <SearchResults
              results={searchResults}
              searching={searching}
              error={searchError}
              hasMore={hasMore}
              onLoadMore={() => setPage({ key: searchKey, offset: offset + 20 })}
              onRetry={() => setRetry(value => value + 1)}
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
              onTogglePin={onTogglePin}
            />
          )}
        </div>
          </>
        )}
      </div>
    </>
  );
}
