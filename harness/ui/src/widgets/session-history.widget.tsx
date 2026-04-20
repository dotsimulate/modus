import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { modus } from "../modusClient";
import { useSession } from "../providers/SessionContext";
import { useProfiles } from "../providers/ProfileContext";
import { getSessionState } from "../sessionStore";
import { useWidgetUiState } from "./ui-state";
import { useWidgetPollingValue } from "./widget-data";
import { ProfilePanel } from "../components/sidebar/ProfilePanel";
import type { WidgetBase, WidgetProps } from "./types";
import type { SessionInfo, ActiveSessionInfo } from "../../../sdk/index";

type SessionHistoryConfig = WidgetBase & {
  type: "session-history";
  /** Hide the profile/seed config panel at the top */
  hideProfilePanel?: boolean;
};

type ViewMode = "timeline" | "agents" | "status";
type SortKey = "updated" | "created" | "cost" | "messages";
type Density = "spacey" | "compact";

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
  if (status === "running") return "active";
  if (status === "starting" || status === "idle") return "idle";
  if (status === "error") return "error";
  return "done";
}

function statusOrder(status: string): number {
  if (status === "running") return 0;
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

type TimelineGroup = { label: string; sessions: SessionInfo[] };

function groupByTimeline(sessions: SessionInfo[]): TimelineGroup[] {
  const now = Date.now();
  const buckets: Record<string, SessionInfo[]> = {};
  const order: string[] = [];

  for (const s of sessions) {
    const age = now - s.updated_at;
    let label: string;
    if (age < 86_400_000) label = "today";
    else if (age < 172_800_000) label = "yesterday";
    else if (age < 604_800_000) {
      label = new Date(s.updated_at).toLocaleDateString("en", { weekday: "long" }).toLowerCase();
    } else if (age < 2_592_000_000) {
      const weeksAgo = Math.floor(age / 604_800_000);
      label = weeksAgo === 1 ? "last week" : `${weeksAgo} weeks ago`;
    } else {
      label = new Date(s.updated_at).toLocaleDateString("en", { month: "long", year: "numeric" }).toLowerCase();
    }
    if (!buckets[label]) { buckets[label] = []; order.push(label); }
    buckets[label].push(s);
  }

  return order.map(label => ({ label, sessions: buckets[label] }));
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
      const aMax = Math.max(...a[1].map(s => s.updated_at));
      const bMax = Math.max(...b[1].map(s => s.updated_at));
      return bMax - aMax;
    })
    .map(([label, sessions]) => ({ label, sessions }));
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
    .map(([label, sessions]) => ({ label, sessions }));
}

export default function SessionHistoryWidget({ config, widgetId, onSelectSession, pageContext }: WidgetProps<SessionHistoryConfig>) {
  const {
    activeUserProfile, activeUP,
    visibleProfiles, availableProviders,
    selectedProfile, selectProfile,
    setupState, setSetupState,
  } = useProfiles();
  const { serverSessions, archiveSession, refreshSessions, newSession } = useSession();

  const [viewMode, setViewMode] = useWidgetUiState<ViewMode>(
    { userProfile: activeUserProfile },
    widgetId, "view-mode", "timeline",
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

  const [search, setSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set(["today", "active"]));
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

  // Poll active sessions for live preview text
  const userProfile = activeUserProfile ?? undefined;
  const loadActive = useCallback(async () => {
    return modus.getActiveSessions(userProfile);
  }, [userProfile]);

  const { value: activeSessions } = useWidgetPollingValue<ActiveSessionInfo[]>({
    load: loadActive,
    scopeKey: `sh-active:${userProfile ?? ""}`,
    intervalMs: 3000,
    initialValue: [],
  });

  const liveMap = useMemo(() => {
    const map = new Map<string, LiveInfo>();
    for (const a of activeSessions) {
      map.set(a.id, {
        status: a.status,
        lastText: a.lastText,
        preview: a.preview,
        costUsd: a.costUsd,
        numTurns: a.numTurns,
      });
    }
    return map;
  }, [activeSessions]);

  const sessions = useMemo(() => {
    return serverSessions.map(s => {
      const live = getSessionState(s.id);
      const active = liveMap.get(s.id);
      const status = live?.status ?? active?.status ?? s.status;
      return { ...s, status };
    });
  }, [serverSessions, liveMap]);

  const pinned = useMemo(() => sessions.filter(s => parseTagList(s.tags).includes("pinned")), [sessions]);
  const unpinned = useMemo(() => sessions.filter(s => !parseTagList(s.tags).includes("pinned")), [sessions]);

  const filtered = useMemo(() => {
    if (!search.trim()) return unpinned;
    const q = search.toLowerCase();
    return unpinned.filter(s =>
      (s.title ?? "").toLowerCase().includes(q) ||
      (s.last_prompt ?? "").toLowerCase().includes(q) ||
      (s.preview ?? "").toLowerCase().includes(q) ||
      (s.profile ?? "").toLowerCase().includes(q) ||
      (s.model ?? "").toLowerCase().includes(q)
    );
  }, [unpinned, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sortKey) {
      case "created": arr.sort((a, b) => b.created_at - a.created_at); break;
      case "cost": arr.sort((a, b) => (b.total_cost_usd ?? 0) - (a.total_cost_usd ?? 0)); break;
      case "messages": arr.sort((a, b) => b.message_count - a.message_count); break;
      default: arr.sort((a, b) => b.updated_at - a.updated_at);
    }
    return arr;
  }, [filtered, sortKey]);

  const groups = useMemo(() => {
    switch (viewMode) {
      case "agents": return groupByAgent(sorted);
      case "status": return groupByStatus(sorted);
      default: return groupByTimeline(sorted);
    }
  }, [sorted, viewMode]);

  const toggleGroup = useCallback((label: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const handleSelect = useCallback((id: string) => {
    if (pageContext) {
      pageContext.emit({ type: "select-session", sessionId: id });
    } else {
      onSelectSession(id);
    }
  }, [pageContext, onSelectSession]);

  const handleNew = useCallback(async () => {
    const id = await newSession();
    if (id) handleSelect(id);
  }, [newSession, handleSelect]);

  const handleTogglePin = useCallback(async (id: string) => {
    const session = serverSessions.find(s => s.id === id);
    const tags = parseTagList(session?.tags);
    if (tags.includes("pinned")) {
      await modus.removeTag(id, "pinned").catch(() => {});
    } else {
      await modus.addTag(id, "pinned").catch(() => {});
    }
    refreshSessions();
  }, [serverSessions, refreshSessions]);

  const handleArchive = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await archiveSession(id);
  }, [archiveSession]);

  const handleRename = useCallback(async (id: string, title: string | null) => {
    const session = serverSessions.find(s => s.id === id);
    if (session) session.title = title; // optimistic
    await modus.updateTitle(id, title);
    refreshSessions();
  }, [serverSessions, refreshSessions]);

  const lastAutoExpandedId = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || selectedId === lastAutoExpandedId.current) return;
    lastAutoExpandedId.current = selectedId;
    for (const g of groups) {
      if (g.sessions.some(s => s.id === selectedId) && !expandedGroups.has(g.label)) {
        setExpandedGroups(prev => new Set([...prev, g.label]));
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
            placeholder="search sessions..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === "Escape") { setSearch(""); searchRef.current?.blur(); } }}
          />
          {search && (
            <button className="sh-search-clear" onClick={() => setSearch("")}>&times;</button>
          )}
        </div>

        {/* Controls row */}
        <div className="sh-controls">
          <div className="sh-view-modes">
            {(["timeline", "agents", "status"] as ViewMode[]).map(m => (
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
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="sh-body">
        {/* Pinned section */}
        {pinned.length > 0 && (
          <div className="sh-section sh-section--pinned">
            <div className="sh-section-head" onClick={() => toggleGroup("__pinned")}>
              <span className="sh-section-icon">&#9670;</span>
              <span className="sh-section-label">pinned</span>
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
                />
              ))}
            </div>
          </div>
        )}

        {/* Dynamic groups */}
        {groups.map(g => (
          <div key={g.label} className="sh-section">
            <div className="sh-section-head" onClick={() => toggleGroup(g.label)}>
              <span className={`sh-section-chevron${expandedGroups.has(g.label) ? " open" : ""}`}>
                <svg width="7" height="7" viewBox="0 0 8 8" fill="none">
                  <path d="M2 3l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
              <span className="sh-section-label">{g.label}</span>
              <span className="sh-section-count">{g.sessions.length}</span>
            </div>
            {expandedGroups.has(g.label) && (
              <div className="sh-section-items">
                {g.sessions.map(s => (
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
                  />
                ))}
              </div>
            )}
          </div>
        ))}

        {groups.length === 0 && search && (
          <div className="sh-empty">no matches for &ldquo;{search}&rdquo;</div>
        )}
      </div>
    </div>
  );
}

// ── Row Component ──

function SessionRow({ session: s, selected, hovered, liveInfo, onHover, onSelect, onArchive, onTogglePin, onRename, isPinned }: {
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
}) {
  const title = displayTitle(s);
  const model = compactModel(s.model);
  const cost = formatCost(liveInfo?.costUsd ?? s.total_cost_usd);
  const isRunning = s.status === "running";
  const isError = s.status === "error";
  const isEmpty = !s.title && !s.last_prompt && !s.preview;

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
      className={`sh-row${selected ? " selected" : ""}${isRunning ? " running" : ""}${isError ? " error" : ""}`}
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
          {s.profile && <span className="sh-tag sh-tag--agent">{s.profile}</span>}
          {model && <span className="sh-tag sh-tag--model">{model}</span>}
        </div>
        <div className="sh-row-meta-right">
          {s.message_count > 0 && <span className="sh-tag">{s.message_count}</span>}
          {cost && <span className="sh-tag">{cost}</span>}
          <span className="sh-tag sh-tag--time">{relativeTime(s.updated_at)}</span>
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
