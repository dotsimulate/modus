import { useState, useEffect, useMemo } from "react";
import { modus } from "../modusClient";
import type { ActiveSessionInfo, SessionInfo } from "../../../sdk/index";
import { useProfiles } from "../providers/ProfileProvider";

type Props = {
  onSelectSession: (id: string) => void;
};

type SortKey = "date" | "messages" | "cost" | "agent";
type SortDir = "desc" | "asc";

type MergedSession = {
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
  subscribers?: number;
  cwd: string | null;
};

function mergeRows(active: ActiveSessionInfo[], recent: SessionInfo[]): MergedSession[] {
  const seen = new Set<string>();
  const rows: MergedSession[] = [];

  for (const a of active) {
    seen.add(a.id);
    rows.push({
      id: a.id,
      status: a.status,
      profile: a.profile,
      model: a.model,
      cost: a.costUsd,
      turns: a.numTurns,
      preview: a.preview,
      lastMessageAt: a.lastEventAt,
      active: true,
      archived: !!a.archived,
      subscribers: a.subscribers,
      cwd: a.cwd,
    });
  }

  for (const s of recent) {
    if (seen.has(s.id)) continue;
    rows.push({
      id: s.id,
      status: s.status === "running" || s.status === "starting" || s.status === "error" ? "done" : s.status,
      profile: s.profile,
      model: s.model,
      cost: s.total_cost_usd,
      turns: s.message_count,
      preview: s.last_prompt ?? s.preview,
      lastMessageAt: s.last_message_at,
      active: false,
      archived: false,
      cwd: s.cwd,
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

function dotClass(row: MergedSession): string {
  if (!row.active) return "dash-dot--done";
  if (row.status === "running") return "dash-dot--streaming";
  if (row.status === "error") return "dash-dot--error";
  return "dash-dot--running";
}

function sortSessions(rows: MergedSession[], key: SortKey, dir: SortDir): MergedSession[] {
  const flip = dir === "asc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "date":
        cmp = b.lastMessageAt - a.lastMessageAt;
        return cmp * flip;
      case "messages":
        cmp = b.turns - a.turns;
        break;
      case "cost":
        cmp = b.cost - a.cost;
        break;
      case "agent":
        cmp = (a.profile ?? "").localeCompare(b.profile ?? "");
        // agent defaults to A-Z in desc, so flip to match convention
        cmp = -cmp;
        break;
    }
    // date is tiebreaker for non-date sorts
    return cmp !== 0 ? cmp * flip : b.lastMessageAt - a.lastMessageAt;
  });
}

const chevron = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
);

const sortColumns: { key: SortKey; label: string }[] = [
  { key: "date", label: "date" },
  { key: "agent", label: "agent" },
  { key: "messages", label: "msgs" },
  { key: "cost", label: "cost" },
];

export function SessionsPanel({ onSelectSession }: Props) {
  const { activeUserProfile } = useProfiles();
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState<MergedSession[]>([]);
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((d) => d === "desc" ? "asc" : "desc");
    } else {
      setSortBy(key);
      setSortDir("desc");
    }
  };

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const up = activeUserProfile ?? undefined;
        const [a, r] = await Promise.all([modus.getActiveSessions(up), modus.listSessions({ limit: 50, userProfile: up })]);
        if (active) setRows(mergeRows(a, r));
      } catch { /* silent */ }
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => { active = false; clearInterval(interval); };
  }, [activeUserProfile]);

  const visibleRows = rows.filter((r) => !r.archived);
  const sorted = useMemo(() => sortSessions(visibleRows, sortBy, sortDir), [visibleRows, sortBy, sortDir]);
  const activeCount = visibleRows.filter((r) => r.active).length;

  return (
    <div className="dash-panel">
      <button className="dash-panel-header" onClick={() => setOpen(!open)}>
        <span className="dash-panel-title">sessions</span>
        <span className={`dash-active-count ${activeCount === 0 ? "dash-active-count--zero" : ""}`}>{activeCount}</span>
        <span className={`profile-panel-chevron ${open ? "profile-panel-chevron--open" : ""}`}>
          {chevron}
        </span>
      </button>
      <div className={`panel-collapse ${open ? "panel-collapse--open" : ""}`}>
        <div className="panel-collapse-clip">
          {visibleRows.length === 0 && (
            <div className="dash-empty">no sessions</div>
          )}

          {visibleRows.length > 0 && (
            <div className="sessions-table">
              {/* Sort header */}
              <div className="sessions-table-header">
                <span className="sessions-th sessions-th--preview">session</span>
                {sortColumns.map((col) => (
                  <button
                    key={col.key}
                    className={`sessions-th sessions-th--sortable ${sortBy === col.key ? "sessions-th--active" : ""}`}
                    onClick={(e) => { e.stopPropagation(); toggleSort(col.key); }}
                  >
                    {col.label}{sortBy === col.key ? (sortDir === "desc" ? " v" : " ^") : ""}
                  </button>
                ))}
              </div>

              {/* Rows */}
              {sorted.map((r) => (
                <div
                  key={r.id}
                  className="sessions-table-row"
                  onClick={() => onSelectSession(r.id)}
                >
                  <span className={`dash-dot ${dotClass(r)}`} />
                  <span className="sessions-cell sessions-cell--preview">{r.preview || "new session"}</span>
                  <span className="sessions-cell sessions-cell--date">{timeAgo(r.lastMessageAt)}</span>
                  <span className="sessions-cell sessions-cell--agent">{r.profile ?? ""}</span>
                  <span className="sessions-cell sessions-cell--msgs">{r.turns}</span>
                  <span className="sessions-cell sessions-cell--cost">${r.cost.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
