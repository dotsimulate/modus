/**
 * Sessions widget — sortable session list.
 *
 * Config example (in user profile dashboard.widgets):
 *   { "id": "sessions-main", "type": "sessions", "filter": "all", "limit": 50, "sort": { "key": "date", "dir": "desc" } }
 */

import { useState, useEffect, useMemo } from "react";
import { fetchActiveSessions, fetchSessionsScoped } from "../api";
import type { ActiveSessionInfo, SessionInfo } from "../api";
import { useProfiles } from "../providers/ProfileProvider";
import type { WidgetBase, WidgetProps, WidgetDef } from "./index";
import { useWidgetUiState } from "./ui-state";

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

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
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

function SessionsWidget({ config, widgetId, onSelectSession }: WidgetProps<SessionsConfig>) {
  const { activeCwd, activeUserProfile } = useProfiles();
  const [rows, setRows] = useState<Row[]>([]);
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

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortBy(key); setSortDir("desc"); }
  };

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [a, r] = await Promise.all([
          fetchActiveSessions(userProfile),
          filter === "active"
            ? Promise.resolve([])
            : fetchSessionsScoped(limit, userProfile),
        ]);
        if (alive) setRows(merge(a, r));
      } catch { /* silent */ }
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [filter, limit, userProfile]);

  const visible = rows.filter((r) => !r.archived);
  const limited = limit < visible.length ? visible.slice(0, limit) : visible;
  const sorted = useMemo(() => sortRows(limited, sortBy, sortDir), [limited, sortBy, sortDir]);

  if (visible.length === 0) {
    return <div className="dash-empty">no sessions</div>;
  }

  return (
    <div className="sessions-table">
      <div className="sessions-table-header">
        <span className="sessions-th sessions-th--preview">session</span>
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
      {sorted.map((r) => (
        <div key={r.id} className="sessions-table-row" onClick={() => onSelectSession(r.id)}>
          <span className={`dash-dot ${dotClass(r)}`} />
          <span className="sessions-cell sessions-cell--preview">{r.preview || "new session"}</span>
          <span className="sessions-cell sessions-cell--date">{timeAgo(r.lastMessageAt)}</span>
          <span className="sessions-cell sessions-cell--agent">{r.profile ?? ""}</span>
          <span className="sessions-cell sessions-cell--msgs">{r.turns}</span>
          <span className="sessions-cell sessions-cell--cost">${r.cost.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Widget definition ──

const def: WidgetDef = { type: "sessions", component: SessionsWidget };
export default def;
