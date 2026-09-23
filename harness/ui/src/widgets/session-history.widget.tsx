import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { modus } from "../modusClient";
import { useSessionActions, useSessionIndex } from "../providers/SessionContext";
import { useProfiles } from "../providers/ProfileContext";
import { getSessionState } from "../sessionStore";
import { sessionActivityAt as activityAt } from "../sessionActivity";
import { hasUnreadReply } from "../session-read-state";
import { useWidgetUiState } from "./ui-state";
import { ProfilePanel } from "../components/sidebar/ProfilePanel";
import { SearchResults } from "../components/sidebar/SearchResults";
import { scheduleSessionSearch } from "../session-search-request";
import { onControlIntent, stepSessionId } from "../control-intents";
import {
  isActiveProjectSessionStatus,
  selectCycleSessionIds,
  selectVisibleGroupSessions,
  selectVisibleProjectSessions,
  type ProjectWindow,
} from "../sessionHistoryVisibility";
import type { WidgetBase, WidgetProps } from "./types";
import type { SearchHit, SearchSort, SessionInfo } from "../../../sdk/index";

type SessionHistoryConfig = WidgetBase & {
  type: "session-history";
  /** Hide the profile/seed config panel at the top */
  hideProfilePanel?: boolean;
  focusTabOnSelect?: string;
};

type ViewMode = "unread" | "projects" | "timeline" | "agents" | "status";

/** Views that list every project's sessions and label each row with its project. */
function isProjectScoped(mode: ViewMode): boolean {
  return mode === "projects" || mode === "unread";
}

/**
 * The unread view exists only while something is waiting. Reading the last
 * reply empties it, so the widget falls back to projects rather than stranding
 * the user on a tab that has just stopped being offered.
 *
 * `sessionsLoaded` is the guard that makes this safe to persist: before the
 * index arrives the count is zero because nothing is known, not because nothing
 * is waiting, and falling back then would discard the stored view on every boot.
 */
export function resolveViewMode(stored: ViewMode, unreadCount: number, sessionsLoaded: boolean): ViewMode {
  return stored === "unread" && sessionsLoaded && unreadCount === 0 ? "projects" : stored;
}

type SortKey = "updated" | "created" | "cost" | "messages";
type Density = "spacey" | "compact";

/**
 * Rows shown per group before the reveal control takes over. Deliberately small:
 * the list is for finding the conversation you were just in, and everything
 * older is one click away rather than in front of you by default.
 */
const GROUP_RECENT_LIMIT = 5;
const GROUP_REVEAL_STEP = 10;

type LiveInfo = {
  status: string;
  lastText: string | null;
  preview: string;
  costUsd: number;
  numTurns: number;
};

function parseTagList(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((t): t is string => typeof t === "string") : [];
  } catch { return []; }
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d`;
  return `${Math.floor(diff / 2_592_000_000)}mo`;
}

function statusLabel(status: string): string {
  if (status === "running" || status === "interrupting" || status === "paused") return "active";
  if (status === "starting" || status === "idle") return "idle";
  if (status === "error") return "error";
  return "done";
}

function statusOrder(status: string): number {
  if (status === "running" || status === "active" || status === "interrupting" || status === "paused") return 0;
  if (status === "starting" || status === "idle") return 1;
  if (status === "error") return 2;
  return 3;
}

function compactModel(model: string | null): string | null {
  if (!model) return null;
  let m = model.replace(/-\d{8}$/, "");
  if (m.startsWith("claude-")) m = m.replace("claude-", "");
  return m;
}

function formatCost(usd: number | null | undefined): string | null {
  if (usd == null || usd <= 0) return null;
  if (usd < 0.01) return `<1\u00a2`;
  if (usd < 1) return `${Math.round(usd * 100)}\u00a2`;
  return `$${usd.toFixed(2)}`;
}

function displayTitle(s: SessionInfo): string {
  return s.title || s.last_prompt || s.preview || "";
}

function scrollDuration(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return 8 + (((h >>> 0) % 700) / 100);
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "\u2026";
}

type TimelineGroup = { key: string; label: string; sessions: SessionInfo[]; activeCount?: number };

function groupByTimeline(sessions: SessionInfo[]): TimelineGroup[] {
  const now = Date.now();
  const buckets: Record<string, SessionInfo[]> = {};
  const order: string[] = [];

  for (const s of sessions) {
    const at = activityAt(s);
    const age = now - at;
    let label: string;
    if (age < 86_400_000) label = "today";
    else if (age < 172_800_000) label = "yesterday";
    else if (age < 604_800_000) {
      label = new Date(at).toLocaleDateString("en", { weekday: "long" }).toLowerCase();
    } else if (age < 2_592_000_000) {
      const weeksAgo = Math.floor(age / 604_800_000);
      label = weeksAgo === 1 ? "last week" : `${weeksAgo} weeks ago`;
    } else {
      label = new Date(at).toLocaleDateString("en", { month: "long", year: "numeric" }).toLowerCase();
    }
    if (!buckets[label]) { buckets[label] = []; order.push(label); }
    buckets[label].push(s);
  }

  return order.map(label => ({ key: `timeline:${label}`, label, sessions: buckets[label] }));
}

function groupByAgent(sessions: SessionInfo[]): TimelineGroup[] {
  const map = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const key = s.profile ?? "unassigned";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return Array.from(map.entries())
    .sort((a, b) => {
      const aMax = Math.max(...a[1].map(activityAt));
      const bMax = Math.max(...b[1].map(activityAt));
      return bMax - aMax;
    })
    .map(([label, sessions]) => ({ key: `agent:${label}`, label, sessions }));
}

function groupByStatus(sessions: SessionInfo[]): TimelineGroup[] {
  const map = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const key = statusLabel(s.status);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return Array.from(map.entries())
    .sort((a, b) => statusOrder(a[0]) - statusOrder(b[0]))
    .map(([label, sessions]) => ({ key: `status:${label}`, label, sessions }));
}

function isActiveStatus(status: string): boolean {
  return isActiveProjectSessionStatus(status);
}

function countUnread(sessions: SessionInfo[]): number {
  return sessions.reduce((total, session) => total + (hasUnreadReply(session) ? 1 : 0), 0);
}

function groupByProject(sessions: SessionInfo[]): TimelineGroup[] {
  const map = new Map<string, { label: string; sessions: SessionInfo[] }>();
  for (const session of sessions) {
    const key = session.project_id ?? "__other";
    const group = map.get(key) ?? { label: session.project_name ?? "other", sessions: [] };
    group.sessions.push(session);
    map.set(key, group);
  }
  return Array.from(map.entries())
    .map(([projectId, group]) => {
      const ordered = [...group.sessions].sort((a, b) => {
        const activity = Number(isActiveStatus(b.status)) - Number(isActiveStatus(a.status));
        return activity || activityAt(b) - activityAt(a);
      });
      return {
        key: `project:${projectId}`,
        label: group.label,
        sessions: ordered,
        activeCount: ordered.filter((session) => isActiveStatus(session.status)).length,
      };
    })
    .sort((a, b) => (b.activeCount ?? 0) - (a.activeCount ?? 0)
      || Math.max(...b.sessions.map(activityAt)) - Math.max(...a.sessions.map(activityAt)));
}

export default function SessionHistoryWidget({ config, widgetId, onSelectSession, pageContext }: WidgetProps<SessionHistoryConfig>) {
  const {
    activeUserProfile, activeUP,
    visibleProfiles, availableProviders,
    selectedProfile, selectProfile,
    setupState, setSetupState,
  } = useProfiles();
  const { serverSessions, allServerSessions, sessionsLoaded } = useSessionIndex();
  const { archiveSession, refreshSessions, newSession } = useSessionActions();

  const [storedViewMode, setViewMode] = useWidgetUiState<ViewMode>(
    { userProfile: activeUserProfile },
    widgetId, "view-mode-v2", "projects",
  );
  const [sortKey, setSortKey] = useWidgetUiState<SortKey>(
    { userProfile: activeUserProfile },
    widgetId, "sort-key", "updated",
  );
  const [density, setDensity] = useWidgetUiState<Density>(
    { userProfile: activeUserProfile },
    widgetId, "density", "compact",
  );
  // Migrate legacy "normal" → "spacey" so the toggle highlights correctly.
  const effectiveDensity: Density = (density as string) === "normal" ? "spacey" : density;
  const [rounded, setRounded] = useWidgetUiState<boolean>(
    { userProfile: activeUserProfile },
    widgetId, "rounded", true,
  );
  const [projectWindow, setProjectWindow] = useWidgetUiState<ProjectWindow>(
    { userProfile: activeUserProfile },
    widgetId, "project-window", "12h",
  );

  // ── Search ──
  // A query replaces the grouped list with full-text hits from the backend index
  // rather than filtering the rows already loaded: the point of searching is to
  // reach a conversation by something said inside it, which is not in this list's
  // metadata. Clearing the box restores the list.
  const [search, setSearch] = useState("");
  const [searchSort, setSearchSort] = useState<SearchSort>("relevance");
  const query = search.trim();
  const searchKey = JSON.stringify([query, searchSort, activeUserProfile]);
  const [searchState, setSearchState] = useState<{ key: string; hits: SearchHit[] }>({ key: "", hits: [] });
  const [page, setPage] = useState({ key: "", offset: 0 });
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [retry, setRetry] = useState(0);
  // Stale keys read as empty rather than as the previous query's answers, so
  // changing the words never shows the old results under the new ones.
  const offset = page.key === searchKey ? page.offset : 0;
  const searchResults = searchState.key === searchKey ? searchState.hits : [];

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [revealCounts, setRevealCounts] = useState<Record<string, number>>({});
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sortOpen) return;
    function close(e: MouseEvent) {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sortOpen]);

  useEffect(() => { setPage({ key: "", offset: 0 }); }, [activeUserProfile]);

  useEffect(() => {
    setSearchError(null);
    setHasMore(false);
    if (!query) { setSearching(false); return; }
    setSearching(true);
    // Scoped to the active user profile, matching every other read in this
    // widget. The server applies its own project and agent visibility on top;
    // this narrows within it, it does not widen.
    return scheduleSessionSearch(
      (text, options) => modus.searchSessions(text, options),
      query,
      { limit: 21, offset, sort: searchSort, userProfile: activeUserProfile ?? undefined },
      (hits) => {
        setSearchState((previous) => {
          const carried = offset && previous.key === searchKey ? previous.hits : [];
          const combined = [...carried, ...hits.slice(0, 20)];
          return { key: searchKey, hits: [...new Map(combined.map((hit) => [hit.session_id, hit])).values()] };
        });
        // The 21st hit is the probe for another page, never a row.
        setHasMore(hits.length > 20);
        setSearching(false);
      },
      (error) => {
        setSearchError(error instanceof Error ? error.message : "Search failed. Please retry.");
        setSearching(false);
      },
    );
  }, [query, searchSort, activeUserProfile, searchKey, offset, retry]);

  const sortOptions: { value: SortKey; label: string }[] = [
    { value: "updated", label: "recent" },
    { value: "created", label: "created" },
    { value: "cost", label: "cost" },
    { value: "messages", label: "messages" },
  ];

  const selectedId = (
    (pageContext?.get("sessionId") as string | undefined)
    ?? (pageContext?.get("selectedSession") as string | undefined)
    ?? null
  );

  // Counted across every project, not the current view's slice, so the tab reads
  // the same number whichever view is open. The open conversation is excluded:
  // it is not waiting on anyone, and counting it made the tab appear and vanish
  // on every turn of the chat being watched.
  const unreadCount = useMemo(
    () => countUnread(allServerSessions.filter((session) => session.id !== selectedId)),
    [allServerSessions, selectedId],
  );
  const viewMode = resolveViewMode(storedViewMode, unreadCount, sessionsLoaded);

  const sourceSessions = isProjectScoped(viewMode) ? allServerSessions : serverSessions;

  const liveMap = useMemo(() => {
    const map = new Map<string, LiveInfo>();
    for (const session of sourceSessions) {
      map.set(session.id, {
        status: session.status,
        lastText: session.live_text ?? null,
        preview: session.preview,
        costUsd: session.total_cost_usd,
        numTurns: Math.ceil(session.message_count / 2),
      });
    }
    return map;
  }, [sourceSessions]);

  const sessions = useMemo(() => {
    const withLiveStatus = sourceSessions.map(s => {
      const live = getSessionState(s.id);
      const active = liveMap.get(s.id);
      const status = live?.status ?? active?.status ?? s.status;
      return { ...s, status };
    });
    // Narrowing here rather than after the pin split keeps the pinned section
    // from showing read sessions while the unread view is open.
    return viewMode === "unread" ? withLiveStatus.filter(hasUnreadReply) : withLiveStatus;
  }, [sourceSessions, liveMap, viewMode]);

  const pinned = useMemo(() => sessions.filter(s => parseTagList(s.tags).includes("pinned")), [sessions]);
  const unpinned = useMemo(() => sessions.filter(s => !parseTagList(s.tags).includes("pinned")), [sessions]);

  const sorted = useMemo(() => {
    const arr = [...unpinned];
    switch (sortKey) {
      case "created": arr.sort((a, b) => b.created_at - a.created_at); break;
      case "cost": arr.sort((a, b) => (b.total_cost_usd ?? 0) - (a.total_cost_usd ?? 0)); break;
      case "messages": arr.sort((a, b) => b.message_count - a.message_count); break;
      default: arr.sort((a, b) => activityAt(b) - activityAt(a));
    }
    return arr;
  }, [unpinned, sortKey]);

  const groups = useMemo(() => {
    switch (viewMode) {
      case "projects": case "unread": return groupByProject(sorted);
      case "agents": return groupByAgent(sorted);
      case "status": return groupByStatus(sorted);
      default: return groupByTimeline(sorted);
    }
  }, [sorted, viewMode]);

  const displayGroups = useMemo(() => groups.map((group) => {
    // The unread view is already the short list; capping it would hide the very
    // thing it exists to show, and its heads never repeat the count.
    if (viewMode === "unread") {
      return {
        ...group, visibleSessions: group.sessions,
        hiddenCount: 0, revealCount: 0, unreadCount: 0,
      };
    }
    const revealCount = revealCounts[group.key] ?? 0;
    const visibleSessions = viewMode === "projects"
      ? selectVisibleProjectSessions(group.sessions, {
          window: projectWindow, selectedId,
          recentLimit: GROUP_RECENT_LIMIT, revealCount,
        })
      : selectVisibleGroupSessions(group.sessions, {
          limit: GROUP_RECENT_LIMIT, selectedId, revealCount,
        });
    return {
      ...group,
      visibleSessions,
      hiddenCount: group.sessions.length - visibleSessions.length,
      revealCount,
      unreadCount: countUnread(group.sessions),
    };
  }), [groups, revealCounts, projectWindow, selectedId, viewMode]);

  useEffect(() => {
    setRevealCounts({});
  }, [projectWindow, search, viewMode]);

  const expandedModeRef = useRef<ViewMode | null>(null);
  useEffect(() => {
    if (groups.length === 0 || expandedModeRef.current === viewMode) return;
    expandedModeRef.current = viewMode;
    if (!isProjectScoped(viewMode)) {
      setExpandedGroups(new Set([groups[0]!.key]));
      return;
    }
    // Opening every project at once is the reason this list reads as a wall.
    // Open the ones with something going on and leave the rest one click away;
    // fall back to the most recent so the panel is never blank.
    const worthOpening = groups.filter((group) => group.sessions.some((session) =>
      isActiveStatus(session.status) || hasUnreadReply(session) || session.id === selectedId));
    setExpandedGroups(new Set((worthOpening.length > 0 ? worthOpening : [groups[0]!]).map((g) => g.key)));
  }, [groups, viewMode, selectedId]);

  // `resolveViewMode` already renders the fallback; this persists it, so the tab
  // does not spring back to unread the next time a reply lands.
  useEffect(() => {
    if (resolveViewMode(storedViewMode, unreadCount, sessionsLoaded) !== storedViewMode) {
      setViewMode("projects");
    }
  }, [unreadCount, storedViewMode, sessionsLoaded, setViewMode]);

  const toggleGroup = useCallback((label: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const revealGroupSessions = useCallback((key: string, count: number) => {
    setRevealCounts((previous) => ({
      ...previous,
      [key]: (previous[key] ?? 0) + count,
    }));
  }, []);

  const collapseGroupSessions = useCallback((key: string) => {
    setRevealCounts((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, []);

  const handleSelect = useCallback((id: string) => {
    if (pageContext) {
      pageContext.emit({ type: "select-session", sessionId: id });
      if (config.focusTabOnSelect) {
        pageContext.emit({ type: "focus-tab", tabId: config.focusTabOnSelect });
      }
    } else {
      onSelectSession(id);
    }
  }, [config.focusTabOnSelect, pageContext, onSelectSession]);

  // ── Control intents ──
  // This list claims session.cycle while it is mounted, because it is the thing
  // the user is looking at: cycling follows the current view, in render order,
  // or the search hits while a query is up. Without this the provider's fallback
  // cycles the unfiltered project list, so a knob visits sessions that are not on
  // screen and skips ones that are.
  //
  // Only rows on screen are in the ring: pinned, then the visible rows of open
  // groups. Rows behind "show N more" and inside collapsed groups are skipped,
  // so turning the knob walks the list you are looking at.
  // Pending sessions are skipped: they have no history to land in.
  const cycleIds = useMemo(() => query
    ? searchResults.map((hit) => hit.session_id).filter((id) => !id.startsWith("pending-"))
    : selectCycleSessionIds(pinned, displayGroups, expandedGroups),
  [query, searchResults, pinned, displayGroups, expandedGroups]);

  useEffect(() => onControlIntent("session.cycle", (intent) => {
    if (intent.intent !== "session.cycle") return;
    const next = stepSessionId(cycleIds, selectedId, intent.delta);
    if (next) handleSelect(next);
  }), [cycleIds, selectedId, handleSelect]);

  const handleNew = useCallback(async () => {
    const id = await newSession();
    if (id) handleSelect(id);
  }, [newSession, handleSelect]);

  const handleTogglePin = useCallback(async (id: string) => {
    const session = allServerSessions.find(s => s.id === id);
    const tags = parseTagList(session?.tags);
    if (tags.includes("pinned")) {
      await modus.removeTag(id, "pinned").catch(() => {});
    } else {
      await modus.addTag(id, "pinned").catch(() => {});
    }
    refreshSessions();
  }, [allServerSessions, refreshSessions]);

  const handleArchive = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await archiveSession(id);
  }, [archiveSession]);

  const handleRename = useCallback(async (id: string, title: string | null) => {
    const session = allServerSessions.find(s => s.id === id);
    if (session) session.title = title; // optimistic
    await modus.updateTitle(id, title);
    refreshSessions();
  }, [allServerSessions, refreshSessions]);

  const lastAutoExpandedId = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || selectedId === lastAutoExpandedId.current) return;
    lastAutoExpandedId.current = selectedId;
    for (const g of groups) {
      if (g.sessions.some(s => s.id === selectedId) && !expandedGroups.has(g.key)) {
        setExpandedGroups(prev => new Set([...prev, g.key]));
        break;
      }
    }
  }, [selectedId, groups]);

  return (
    <div className="sh" data-density={effectiveDensity} data-rounded={rounded ? "true" : "false"}>
      {/* Header strip */}
      <div className="sh-header">
        <button className="sh-new-btn" onClick={handleNew}>+ new session</button>
        {!config.hideProfilePanel && (
          <ProfilePanel
            profiles={visibleProfiles}
            availableProviders={availableProviders}
            selectedProfile={selectedProfile}
            onSelectProfile={selectProfile}
            setupState={setupState}
            onSetupChange={setSetupState}
            activeUserProfileObj={activeUP}
          />
        )}

        {/* Search */}
        <div className="sh-search-wrap">
          <input
            ref={searchRef}
            className="sh-search"
            type="text"
            placeholder="search conversations..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage({ key: "", offset: 0 }); }}
            onKeyDown={e => { if (e.key === "Escape") { setSearch(""); setPage({ key: "", offset: 0 }); searchRef.current?.blur(); } }}
          />
          {search && (
            <button
              className="sh-search-clear"
              aria-label="Clear search"
              onClick={() => { setSearch(""); setPage({ key: "", offset: 0 }); }}
            >&times;</button>
          )}
        </div>
        {query && (
          <div className="sh-search-help">All words match. Use &ldquo;quotes&rdquo; for a phrase.</div>
        )}

        {/* Controls row */}
        <div className="sh-controls">
          {query ? (
            <label className="sh-search-sort">
              sort
              <select
                value={searchSort}
                onChange={event => { setSearchSort(event.target.value as SearchSort); setPage({ key: "", offset: 0 }); }}
              >
                <option value="relevance">relevance</option>
                <option value="latest">latest</option>
                <option value="oldest">oldest</option>
              </select>
            </label>
          ) : (
            <>
            <div className="sh-view-modes">
              {unreadCount > 0 && (
                <button
                  className={`sh-mode-btn sh-mode-btn--unread${viewMode === "unread" ? " active" : ""}`}
                  onClick={() => setViewMode("unread")}
                  title={`${unreadCount} session${unreadCount === 1 ? "" : "s"} waiting to be read`}
                  aria-label={`${unreadCount} unread`}
                  type="button"
                >{unreadCount}</button>
              )}
              {(["projects", "timeline", "agents", "status"] as ViewMode[]).map(m => (
                <button
                  key={m}
                  className={`sh-mode-btn${viewMode === m ? " active" : ""}`}
                  onClick={() => setViewMode(m)}
                >{m}</button>
              ))}
            </div>
            <div className={`sh-sort${sortOpen ? " open" : ""}`} ref={sortRef}>
              <button
                className="sh-sort-btn"
                onClick={() => setSortOpen(v => !v)}
                title={`sort: ${sortOptions.find(o => o.value === sortKey)?.label ?? ""}`}
                type="button"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 3h8M3 6h6M4 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              </button>
              {sortOpen && (
                <div className="sh-sort-menu">
                  {sortOptions.map(opt => (
                    <button
                      key={opt.value}
                      className={`sh-sort-option${opt.value === sortKey ? " active" : ""}`}
                      onClick={() => { setSortKey(opt.value); setSortOpen(false); }}
                      type="button"
                    >{opt.label}</button>
                  ))}
                  <div className="sh-sort-separator" />
                  <div className="sh-sort-density">
                    <span className="sh-sort-density-label">density</span>
                    <div className="sh-sort-density-toggle">
                      {(["spacey", "compact"] as Density[]).map(d => (
                        <button
                          key={d}
                          className={`sh-density-btn${effectiveDensity === d ? " active" : ""}`}
                          onClick={e => { e.stopPropagation(); setDensity(d); }}
                          type="button"
                        >{d}</button>
                      ))}
                    </div>
                  </div>
                  <div className="sh-sort-density">
                    <span className="sh-sort-density-label">corners</span>
                    <div className="sh-sort-density-toggle">
                      {([["square", false], ["rounded", true]] as [string, boolean][]).map(([label, val]) => (
                        <button
                          key={label}
                          className={`sh-density-btn${rounded === val ? " active" : ""}`}
                          onClick={e => { e.stopPropagation(); setRounded(val); }}
                          type="button"
                        >{label}</button>
                      ))}
                    </div>
                  </div>
                  {viewMode === "projects" && (
                    <div className="sh-sort-density">
                      <span className="sh-sort-density-label">show</span>
                      <div className="sh-sort-density-toggle">
                        {(["12h", "24h", "7d", "all"] as ProjectWindow[]).map(window => (
                          <button
                            key={window}
                            className={`sh-density-btn${projectWindow === window ? " active" : ""}`}
                            onClick={event => { event.stopPropagation(); setProjectWindow(window); }}
                            type="button"
                          >{window}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            </>
          )}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="sh-body">
        {query ? (
          <SearchResults
            results={searchResults}
            searching={searching}
            error={searchError}
            hasMore={hasMore}
            onLoadMore={() => setPage({ key: searchKey, offset: offset + 20 })}
            onRetry={() => setRetry(value => value + 1)}
            activeSessionId={selectedId}
            onSelectSession={handleSelect}
          />
        ) : (
          <>
          {/* Pinned section */}
          {pinned.length > 0 && (
            <div className="sh-section sh-section--pinned">
              <div className="sh-section-head" onClick={() => toggleGroup("__pinned")}>
                <span className="sh-section-icon">&#9670;</span>
                <span className="sh-section-label">pinned</span>
                {countUnread(pinned) > 0 && (
                  <span className="sh-section-unread">{countUnread(pinned)} unread</span>
                )}
                <span className="sh-section-count">{pinned.length}</span>
              </div>
              <div className="sh-section-items">
                {pinned.map(s => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    selected={s.id === selectedId}
                    hovered={s.id === hoveredId}
                    liveInfo={liveMap.get(s.id)}
                    onHover={setHoveredId}
                    onSelect={handleSelect}
                    onArchive={handleArchive}
                    onTogglePin={handleTogglePin}
                    onRename={handleRename}
                    isPinned
                    showProject={isProjectScoped(viewMode)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Dynamic groups */}
          {displayGroups.map(g => (
            <div key={g.key} className="sh-section">
              <div className="sh-section-head" onClick={() => toggleGroup(g.key)}>
                <span className={`sh-section-chevron${expandedGroups.has(g.key) ? " open" : ""}`}>
                  <svg width="7" height="7" viewBox="0 0 8 8" fill="none">
                    <path d="M2 3l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </span>
                <span className="sh-section-label">{g.label}</span>
                {g.unreadCount > 0 && <span className="sh-section-unread">{g.unreadCount} unread</span>}
                {!!g.activeCount && <span className="sh-section-active">{g.activeCount} active</span>}
                <span className="sh-section-count">
                  {g.visibleSessions.length === g.sessions.length
                    ? g.sessions.length
                    : `${g.visibleSessions.length} / ${g.sessions.length}`}
                </span>
              </div>
              {expandedGroups.has(g.key) && (
                <div className="sh-section-items">
                  {g.visibleSessions.map(s => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      selected={s.id === selectedId}
                      hovered={s.id === hoveredId}
                      liveInfo={liveMap.get(s.id)}
                      onHover={setHoveredId}
                      onSelect={handleSelect}
                      onArchive={handleArchive}
                      onTogglePin={handleTogglePin}
                      onRename={handleRename}
                      isPinned={parseTagList(s.tags).includes("pinned")}
                      showProject={isProjectScoped(viewMode)}
                    />
                  ))}
                  {viewMode !== "unread" && (g.hiddenCount > 0 || g.revealCount > 0) && (
                    <div className="sh-project-reveal">
                      {g.hiddenCount > 0 && (
                        <button
                          type="button"
                          onClick={() => revealGroupSessions(g.key, GROUP_REVEAL_STEP)}
                        >show {Math.min(GROUP_REVEAL_STEP, g.hiddenCount)} more</button>
                      )}
                      {g.hiddenCount > GROUP_REVEAL_STEP && (
                        <button
                          type="button"
                          onClick={() => revealGroupSessions(g.key, g.sessions.length)}
                        >show all {g.sessions.length}</button>
                      )}
                      {g.revealCount > 0 && (
                        <button
                          type="button"
                          onClick={() => collapseGroupSessions(g.key)}
                        >show less</button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          </>
        )}
      </div>
    </div>
  );
}

// ── Row Component ──

export function SessionRow({ session: s, selected, hovered, liveInfo, onHover, onSelect, onArchive, onTogglePin, onRename, isPinned, showProject }: {
  session: SessionInfo;
  selected: boolean;
  hovered: boolean;
  liveInfo?: LiveInfo;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onArchive: (id: string, e: React.MouseEvent) => void;
  onTogglePin: (id: string) => void;
  onRename: (id: string, title: string | null) => void;
  isPinned: boolean;
  showProject: boolean;
}) {
  const title = displayTitle(s);
  const model = compactModel(s.model);
  const cost = formatCost(liveInfo?.costUsd ?? s.total_cost_usd);
  const isRunning = s.status === "running";
  const isError = s.status === "error";
  const isEmpty = !s.title && !s.last_prompt && !s.preview;
  const unread = hasUnreadReply(s);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEdit = () => {
    setEditValue(s.title ?? "");
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const trimmed = editValue.trim();
    const newTitle = trimmed || null;
    if (newTitle === (s.title ?? null)) return;
    onRename(s.id, newTitle);
  };

  const cancelEdit = () => setEditing(false);

  const liveText = isRunning
    ? truncateText(liveInfo?.lastText || liveInfo?.preview || s.preview || s.last_prompt || "", 80) || null
    : null;

  const lastLiveRef = useRef<string | null>(null);
  if (liveText) lastLiveRef.current = liveText;
  const displayLive = liveText ?? lastLiveRef.current;

  return (
    <div
      className={`sh-row${selected ? " selected" : ""}${isRunning ? " running" : ""}${isError ? " error" : ""}${unread ? " sh-row--unread" : ""}`}
      onClick={() => !editing && onSelect(s.id)}
      onMouseEnter={() => onHover(s.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="sh-row-main">
        {/* Status indicator */}
        <div className="sh-row-indicator">
          <span className={`sh-dot sh-dot--${statusLabel(s.status)}`} />
        </div>

        {/* Content */}
        <div className="sh-row-content">
          {editing ? (
            <input
              ref={inputRef}
              className="sh-row-title-input"
              value={editValue}
              placeholder={s.last_prompt ?? s.preview ?? "session title"}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") cancelEdit();
              }}
              onBlur={commitEdit}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <div
              className={`sh-row-title${isEmpty ? " empty" : ""}`}
              onDoubleClick={e => { e.stopPropagation(); startEdit(); }}
            >
              {isEmpty ? "new session" : title}
            </div>
          )}
        </div>

        {/* Actions (visible on hover) */}
        <div className={`sh-row-actions${hovered || selected ? " visible" : ""}`}>
          <button
            className={`sh-action-btn${isPinned ? " pinned" : ""}`}
            onClick={e => { e.stopPropagation(); onTogglePin(s.id); }}
            title={isPinned ? "Unpin" : "Pin"}
          >
            <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
              <circle cx="5" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.2" fill={isPinned ? "currentColor" : "none"}/>
              <path d="M5 5.5V8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
          <button
            className="sh-action-btn sh-action-btn--archive"
            onClick={e => onArchive(s.id, e)}
            title="Archive"
          >
            <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
              <path d="M2 5h6M5 5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <rect x="1.5" y="2" width="7" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Full-width meta row — identity on the left, stats on the right */}
      <div className="sh-row-meta">
        <div className="sh-row-meta-left">
          {unread && <span className="sh-tag sh-tag--unread" title="Unread reply">new reply</span>}
          {showProject && <span className="sh-tag sh-tag--project">{s.project_name ?? "other"}</span>}
          {s.profile && <span className="sh-tag sh-tag--agent">{s.profile}</span>}
          {model && <span className="sh-tag sh-tag--model">{model}</span>}
        </div>
        <div className="sh-row-meta-right">
          {s.message_count > 0 && <span className="sh-tag">{s.message_count}</span>}
          {cost && <span className="sh-tag">{cost}</span>}
          <span className="sh-tag sh-tag--time">{relativeTime(activityAt(s))}</span>
        </div>
      </div>

      {/* Full-width live activity band (running sessions only) */}
      <div className={`sh-row-live-wrap${liveText ? " active" : ""}`}>
        <div className="sh-row-live">
          {displayLive && (
            <span style={{ animationDuration: `${scrollDuration(s.id)}s` }}>
              {displayLive}&nbsp;&nbsp;&nbsp;&mdash;&nbsp;&nbsp;&nbsp;{displayLive}&nbsp;&nbsp;&nbsp;&mdash;&nbsp;&nbsp;&nbsp;
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
