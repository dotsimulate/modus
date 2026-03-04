import { useState, useRef, useCallback, useEffect } from "react";
import type { Profile, SessionInfo, SearchHit } from "../api";
import { searchSessions } from "../api";
import { SessionSetup, type SessionSetupState } from "./SessionSetup";

type Props = {
  open: boolean;
  collapsed: boolean;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  profiles: Profile[];
  selectedProfile: string;
  harnessUp: boolean | null;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onArchiveSession: (id: string) => void;
  onSelectProfile: (name: string) => void;
  onSetupChange: (setup: SessionSetupState) => void;
  setupState: SessionSetupState;
  onClose: () => void;
  onToggleCollapse: () => void;
  onLock?: () => void;
  userName?: string | null;
};

/** Detect which categories have overrides vs profile defaults */
function getOverrideTags(setup: SessionSetupState): string[] {
  const tags: string[] = [];
  if (setup.model) tags.push("model");
  if (setup.cwd.trim()) tags.push("cwd");
  if (setup.agent.effort) tags.push("effort");
  if (setup.agent.maxTurns) tags.push("turns");
  const toolOverrides = Object.keys(setup.agent.toolStates).length;
  if (toolOverrides > 0) tags.push(`${toolOverrides} tools`);
  if (!setup.loadProjectSettings) tags.push("no claude.md");
  return tags;
}

type GroupMode = "time" | "project";

/** Extract a short project label from a cwd path (last 2 segments) */
function projectLabel(cwd: string | null): string {
  if (!cwd) return "other";
  const parts = cwd.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join("/");
  if (parts.length === 1) return parts[0];
  return "other";
}

function groupSessionsByProject(list: SessionInfo[]) {
  const map = new Map<string, SessionInfo[]>();
  for (const s of list) {
    const label = projectLabel(s.cwd);
    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(s);
  }
  // Sort groups: most recently active first
  return Array.from(map.entries())
    .map(([label, items]) => ({ label, items }))
    .sort((a, b) => {
      const aMax = Math.max(...a.items.map((s) => s.updated_at));
      const bMax = Math.max(...b.items.map((s) => s.updated_at));
      return bMax - aMax;
    });
}

export function Sidebar({
  open,
  collapsed,
  sessions,
  activeSessionId,
  profiles,
  selectedProfile,
  harnessUp,
  onNewSession,
  onSelectSession,
  onArchiveSession,
  onSelectProfile,
  onSetupChange,
  setupState,
  onClose,
  onToggleCollapse,
  onLock,
  userName,
}: Props) {
  const [configExpanded, setConfigExpanded] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>("time");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  const selectedProfileData = profiles.find((p) => p.name === selectedProfile);
  const overrideTags = getOverrideTags(setupState);

  const doSearch = useCallback((q: string) => {
    clearTimeout(searchTimer.current);
    if (!q.trim()) { setSearchResults([]); setSearching(false); return; }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const hits = await searchSessions(q);
        setSearchResults(hits);
      } catch { /* silent */ }
      setSearching(false);
    }, 250);
  }, []);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  function timeAgo(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  function groupSessions(list: SessionInfo[]) {
    const now = Date.now();
    const today: SessionInfo[] = [];
    const yesterday: SessionInfo[] = [];
    const thisWeek: SessionInfo[] = [];
    const older: SessionInfo[] = [];

    for (const s of list) {
      const age = now - s.updated_at;
      if (age < 86_400_000) today.push(s);
      else if (age < 172_800_000) yesterday.push(s);
      else if (age < 604_800_000) thisWeek.push(s);
      else older.push(s);
    }

    return [
      { label: "today", items: today },
      { label: "yesterday", items: yesterday },
      { label: "this week", items: thisWeek },
      { label: "older", items: older },
    ].filter((g) => g.items.length > 0);
  }

  function statusIcon(status: string) {
    if (status === "running" || status === "starting") return <span className="session-running-dot" />;
    if (status === "error") return <span className="session-error-dot" />;
    return <span className="session-done-dot" />;
  }

  const groups = groupMode === "project"
    ? groupSessionsByProject(sessions)
    : groupSessions(sessions);

  // Profile summary line
  const profileSummary = selectedProfileData
    ? `${selectedProfileData.model.replace("claude-", "").replace(/-\d.*/, "")} / ${selectedProfileData.effort ?? "default"} / ${
        typeof selectedProfileData.tools === "string"
          ? selectedProfileData.tools
          : selectedProfileData.tools.length + " tools"
      }`
    : "";

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
              <input
                className="sidebar-search"
                type="text"
                placeholder="search sessions..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); doSearch(e.target.value); }}
              />
              <div className="group-toggle">
                <button
                  className={`group-toggle-btn ${groupMode === "time" ? "group-toggle-btn--active" : ""}`}
                  onClick={() => setGroupMode("time")}
                >
                  time
                </button>
                <button
                  className={`group-toggle-btn ${groupMode === "project" ? "group-toggle-btn--active" : ""}`}
                  onClick={() => setGroupMode("project")}
                >
                  project
                </button>
              </div>
            </div>
          )}

          {/* Search results */}
          {searchQuery.trim() ? (
            <div className="search-results">
              {searching && searchResults.length === 0 && (
                <div className="search-empty">searching...</div>
              )}
              {!searching && searchResults.length === 0 && (
                <div className="search-empty">no results</div>
              )}
              {searchResults.map((hit) => (
                <div
                  key={hit.session_id}
                  className={`session-item ${hit.session_id === activeSessionId ? "active" : ""}`}
                  onClick={() => onSelectSession(hit.session_id)}
                >
                  <div className="session-item-preview">
                    <span className="session-item-text">{hit.preview}</span>
                  </div>
                  <div className="search-hit-snippet">{hit.snippet}</div>
                  <div className="session-item-meta">
                    {hit.cwd && (
                      <span className="session-project-tag">
                        {hit.cwd.replace(/\/+$/, "").split("/").pop()}
                      </span>
                    )}
                    {hit.profile && (
                      <span className="session-profile-tag">{hit.profile}</span>
                    )}
                    <span>{timeAgo(hit.last_message_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {/* Normal grouped sessions — hidden when searching */}
          {!searchQuery.trim() && groups.map((group) => {
            const isGroupCollapsed = collapsedGroups.has(group.label);
            const toggleGroup = () => setCollapsedGroups((prev) => {
              const next = new Set(prev);
              if (next.has(group.label)) next.delete(group.label);
              else next.add(group.label);
              return next;
            });
            return (
              <div key={group.label}>
                <div
                  className="sidebar-section-label sidebar-section-label--clickable"
                  onClick={toggleGroup}
                >
                  <span className={`section-chevron ${isGroupCollapsed ? "" : "section-chevron--open"}`}>
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                      <path d="M2 3l2 2.5L6 3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                  <span>{group.label}</span>
                  <span className="section-count">{group.items.length}</span>
                </div>
                <div className={`section-collapse ${isGroupCollapsed ? "" : "section-collapse--open"}`}>
                  <div className="section-collapse-clip">
                    {group.items.map((s) => (
                      <div
                        key={s.id}
                        className={`session-item ${s.id === activeSessionId ? "active" : ""}`}
                        onClick={() => onSelectSession(s.id)}
                      >
                        <div className="session-item-preview">
                          {statusIcon(s.status)}
                          <span className="session-item-text">{s.last_prompt ?? s.preview}</span>
                        </div>
                        <div className="session-item-meta">
                          <span className="session-profile-tag">
                            {s.profile ?? "default"}
                          </span>
                          {groupMode === "time" && s.cwd && (
                            <span className="session-project-tag">
                              {s.cwd.replace(/\/+$/, "").split("/").pop()}
                            </span>
                          )}
                          <span>${s.total_cost_usd.toFixed(3)}</span>
                          <span>{timeAgo(s.updated_at)}</span>
                          <button
                            className="session-archive-btn"
                            onClick={(e) => { e.stopPropagation(); onArchiveSession(s.id); }}
                            title="Archive session"
                          >
                            &times;
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Collapsible profile + config panel ── */}
        <div className="profile-panel">
          <button
            className="profile-panel-header"
            onClick={() => setConfigExpanded(!configExpanded)}
          >
            <div className="profile-panel-left">
              <span className="profile-panel-name">{selectedProfile}</span>
              <span className="profile-panel-summary">{profileSummary}</span>
            </div>
            <div className="profile-panel-right">
              {overrideTags.length > 0 && (
                <span className="profile-panel-overrides">
                  {overrideTags.map((t) => (
                    <span key={t} className="override-tag">{t}*</span>
                  ))}
                </span>
              )}
              <span className={`profile-panel-chevron ${configExpanded ? "profile-panel-chevron--open" : ""}`}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M3 4l2 2.5L7 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
            </div>
          </button>

          <div className={`panel-collapse ${configExpanded ? "panel-collapse--open" : ""}`}>
            <div className="panel-collapse-clip">
              <div className="profile-panel-body">
                {/* Profile selector */}
                <label className="agent-config-field">
                  <span>profile</span>
                  <select
                    value={selectedProfile}
                    onChange={(e) => onSelectProfile(e.target.value)}
                  >
                    {profiles.map((p) => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                </label>

                {/* Full session setup */}
                <SessionSetup
                  config={setupState}
                  profileTools={selectedProfileData?.tools ?? "all"}
                  profileEffort={selectedProfileData?.effort}
                  profileMaxTurns={selectedProfileData?.maxTurns}
                  profileModel={selectedProfileData?.model}
                  onChange={onSetupChange}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="harness-status">
          <div className="harness-status-left">
            <div
              className={`status-dot ${harnessUp === true ? "connected" : harnessUp === false ? "error" : ""}`}
            />
            <span>
              {harnessUp === true
                ? "harness connected"
                : harnessUp === false
                  ? "harness offline"
                  : "checking..."}
            </span>
          </div>
          <div className="harness-status-right">
            {userName && (
              <span className="harness-user">{userName}</span>
            )}
            {onLock && (
              <button className="lock-btn" onClick={onLock} title="Lock">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="2" y="5" width="8" height="6" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M4 5V3.5a2 2 0 0 1 4 0V5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
