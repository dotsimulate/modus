/**
 * Sessions widget — sortable session list with archived mode.
 *
 * Config example (in user profile dashboard.widgets):
 *   { "id": "sessions-main", "type": "sessions", "filter": "all", "limit": 50, "sort": { "key": "date", "dir": "desc" } }
 */

import { useCallback, useMemo } from "react";
import { modus } from "../modusClient";
import type { ActiveSessionInfo, SessionInfo } from "../../../sdk/index";
import { useProfiles } from "../providers/ProfileContext";
import { timeAgo } from "../utils/format";
import type { WidgetBase, WidgetProps } from "./types";
import { useWidgetUiState } from "./ui-state";
import { useWidgetPollingValue } from "./widget-data";
import { WidgetEmptyState } from "./widget-components";

// ── Config ──

type SessionsConfig = WidgetBase & {
  type: "sessions";
  filter?: "all" | "active";
  limit?: number;
  sort?: { key: SortKey; dir?: SortDir };
};

// ── Data types ──

type SortKey = "date" | "messages" | "cost" | "agent";
type SortDir = "desc" | "asc";
type ViewMode = "recent" | "archived";

type Row = {
  id: string;
  status: string;
  profile: string | null;
  model: string | null;
  cost: number;
  turns: number;
  preview: string;
  lastMessageAt: number;
  active: boolean;
  archived: boolean;
  cwd: string | null;
};

// ── Helpers ──

function merge(active: ActiveSessionInfo[], recent: SessionInfo[]): Row[] {
  const seen = new Set<string>();
  const rows: Row[] = [];

  for (const a of active) {
    seen.add(a.id);
    rows.push({
      id: a.id, status: a.status, profile: a.profile, model: a.model,
      cost: a.costUsd, turns: a.numTurns, preview: a.preview,
      lastMessageAt: a.lastEventAt, active: true, archived: !!a.archived, cwd: a.cwd,
    });
  }
  for (const s of recent) {
    if (seen.has(s.id)) continue;
    rows.push({
      id: s.id, status: "done", profile: s.profile, model: s.model,
      cost: s.total_cost_usd, turns: s.message_count,
      preview: s.last_prompt ?? s.preview, lastMessageAt: s.last_message_at,
      active: false, archived: false, cwd: s.cwd,
    });
  }

  rows.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return rows;
}

function archivedRows(sessions: SessionInfo[]): Row[] {
  return sessions.map((s) => ({
    id: s.id, status: "done", profile: s.profile, model: s.model,
    cost: s.total_cost_usd, turns: s.message_count,
    preview: s.last_prompt ?? s.preview, lastMessageAt: s.last_message_at,
    active: false, archived: true, cwd: s.cwd,
  }));
}

function dotClass(row: Row): string {
  if (!row.active) return "dash-dot--done";
  if (row.status === "running") return "dash-dot--streaming";
  if (row.status === "error") return "dash-dot--error";
  return "dash-dot--running";
}

function sortRows(rows: Row[], key: SortKey, dir: SortDir): Row[] {
  const flip = dir === "asc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "date":
        return (b.lastMessageAt - a.lastMessageAt) * flip;
      case "messages":
        cmp = b.turns - a.turns; break;
      case "cost":
        cmp = b.cost - a.cost; break;
      case "agent":
        cmp = -(a.profile ?? "").localeCompare(b.profile ?? ""); break;
    }
    return cmp !== 0 ? cmp * flip : b.lastMessageAt - a.lastMessageAt;
  });
}

const SORT_COLS: { key: SortKey; label: string }[] = [
  { key: "date", label: "date" },
  { key: "agent", label: "agent" },
  { key: "messages", label: "msgs" },
  { key: "cost", label: "cost" },
];

// ── Component ──

export default function SessionsWidget({ config, widgetId, onSelectSession, pageContext }: WidgetProps<SessionsConfig>) {
  const { activeCwd, activeUserProfile } = useProfiles();
  const [viewMode, setViewMode] = useWidgetUiState<ViewMode>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "view-mode",
    "recent",
  );
  const [sortBy, setSortBy] = useWidgetUiState<SortKey>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "sort-key",
    config.sort?.key ?? "date",
  );
  const [sortDir, setSortDir] = useWidgetUiState<SortDir>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "sort-dir",
    config.sort?.dir ?? "desc",
  );

  const limit = config.limit ?? 50;
  const filter = config.filter ?? "all";
  const userProfile = activeUserProfile ?? undefined;

  // Recent sessions loader
  const loadRecent = useCallback(async () => {
    const [active, recent] = await Promise.all([
      modus.getActiveSessions(userProfile),
      filter === "active"
        ? Promise.resolve([])
        : modus.listSessions({ limit, userProfile }),
    ]);
    return merge(active, recent);
  }, [filter, limit, userProfile]);

  // Archived sessions loader
  const loadArchived = useCallback(async () => {
    const sessions = await modus.listArchivedSessions(limit);
    return archivedRows(sessions);
  }, [limit]);

  const { value: recentRows } = useWidgetPollingValue<Row[]>({
    load: loadRecent,
    scopeKey: `recent:${filter}:${limit}:${userProfile ?? ""}`,
    intervalMs: 3000,
    initialValue: [],
  });

  const { value: archivedRowsData, refresh: refreshArchived } = useWidgetPollingValue<Row[]>({
    load: loadArchived,
    scopeKey: `archived:${limit}`,
    intervalMs: viewMode === "archived" ? 5000 : 60000,
    initialValue: [],
  });

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortBy(key); setSortDir("desc"); }
  };

  const handleUnarchive = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await modus.unarchiveSession(id);
    refreshArchived();
  }, [refreshArchived]);

  const isArchived = viewMode === "archived";
  const sourceRows = isArchived ? archivedRowsData : recentRows.filter((r) => !r.archived);
  const limited = limit < sourceRows.length ? sourceRows.slice(0, limit) : sourceRows;
  const sorted = useMemo(() => sortRows(limited, sortBy, sortDir), [limited, sortBy, sortDir]);

  const archivedCount = archivedRowsData.length;

  return (
    <div className="sessions-table">
      <div className="sessions-table-header">
        <span className="sessions-th sessions-th--preview">
          <button
            className={`sessions-mode-toggle ${!isArchived ? "sessions-mode-toggle--active" : ""}`}
            onClick={() => setViewMode("recent")}
          >
            sessions
          </button>
          <button
            className={`sessions-mode-toggle ${isArchived ? "sessions-mode-toggle--active" : ""}`}
            onClick={() => setViewMode("archived")}
            title="Recently archived sessions"
          >
            archived{archivedCount > 0 ? ` (${archivedCount})` : ""}
          </button>
        </span>
        {SORT_COLS.map((col) => (
          <button
            key={col.key}
            className={`sessions-th sessions-th--sortable ${sortBy === col.key ? "sessions-th--active" : ""}`}
            onClick={() => toggleSort(col.key)}
          >
            {col.label}{sortBy === col.key ? (sortDir === "desc" ? " v" : " ^") : ""}
          </button>
        ))}
      </div>
      {sorted.length === 0 ? (
        <WidgetEmptyState>{isArchived ? "no archived sessions" : "no sessions"}</WidgetEmptyState>
      ) : sorted.map((r) => (
        <div key={r.id} className="sessions-table-row" onClick={() => {
          if (pageContext) {
            pageContext.emit({ type: "select-session", sessionId: r.id });
          } else {
            onSelectSession(r.id);
          }
        }}>
          <span className={`dash-dot ${isArchived ? "dash-dot--archived" : dotClass(r)}`} />
          <span className="sessions-cell sessions-cell--preview">{r.preview || "new session"}</span>
          <span className="sessions-cell sessions-cell--date">{timeAgo(r.lastMessageAt)}</span>
          <span className="sessions-cell sessions-cell--agent">{r.profile ?? ""}</span>
          <span className="sessions-cell sessions-cell--msgs">{r.turns}</span>
          {isArchived ? (
            <button
              className="sessions-cell sessions-cell--unarchive"
              onClick={(e) => handleUnarchive(e, r.id)}
              title="Restore session"
            >
              restore
            </button>
          ) : (
            <span className="sessions-cell sessions-cell--cost">${r.cost.toFixed(2)}</span>
          )}
        </div>
      ))}
    </div>
  );
}
