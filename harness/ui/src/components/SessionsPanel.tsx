import { useState, useEffect } from "react";
import { fetchActiveSessions, fetchSessions } from "../api";
import type { ActiveSessionInfo, SessionInfo } from "../api";

type Props = {
  onSelectSession: (id: string) => void;
};

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

function shortModel(model: string | null): string {
  if (!model) return "";
  return model.replace("claude-", "").replace(/-\d{8}.*/, "");
}

function statusClass(status: string): string {
  if (status === "running" || status === "starting") return "running";
  if (status === "error") return "error";
  if (status === "done") return "done";
  return "idle";
}

const chevron = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
);

export function SessionsPanel({ onSelectSession }: Props) {
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState<MergedSession[]>([]);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const [a, r] = await Promise.all([fetchActiveSessions(), fetchSessions(20)]);
        if (active) setRows(mergeRows(a, r));
      } catch { /* silent */ }
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  const activeRows = rows.filter((r) => r.active);
  const recentRows = rows.filter((r) => !r.active);

  return (
    <div className="dash-panel">
      <button className="dash-panel-header" onClick={() => setOpen(!open)}>
        <span className="dash-panel-title">sessions</span>
        {activeRows.length > 0 && (
          <span className="dash-active-count">{activeRows.length} active</span>
        )}
        <span className={`profile-panel-chevron ${open ? "profile-panel-chevron--open" : ""}`}>
          {chevron}
        </span>
      </button>
      <div className={`panel-collapse ${open ? "panel-collapse--open" : ""}`}>
        <div className="panel-collapse-clip">
          {rows.length === 0 && (
            <div className="dash-empty">no sessions</div>
          )}

          {/* Active agents — cards */}
          {activeRows.length > 0 && (
            <div className="agent-grid">
              {activeRows.map((r) => (
                <div
                  key={r.id}
                  className={`agent-card agent-card--${statusClass(r.status)}`}
                  onClick={() => onSelectSession(r.id)}
                >
                  <div className="agent-card-head">
                    <span className={`dash-dot dash-dot--lg dash-dot--${statusClass(r.status)}`} />
                    <span className="agent-card-profile">{r.profile ?? "default"}</span>
                    <span className="agent-card-model">{shortModel(r.model)}</span>
                  </div>
                  <div className="agent-card-body">
                    {r.preview || "new session"}
                  </div>
                  <div className="agent-card-foot">
                    <span>${r.cost.toFixed(3)}</span>
                    <span>{r.turns} turns</span>
                    <span>{timeAgo(r.lastMessageAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Recent — compact rows */}
          {recentRows.length > 0 && (
            <div className="recent-list">
              {activeRows.length > 0 && (
                <div className="recent-list-label">recent</div>
              )}
              {recentRows.map((r) => (
                <div
                  key={r.id}
                  className="recent-row"
                  onClick={() => onSelectSession(r.id)}
                >
                  <span className={`dash-dot dash-dot--${statusClass(r.status)}`} />
                  <span className="recent-preview">{r.preview}</span>
                  <span className="recent-meta">{r.profile}</span>
                  <span className="recent-meta">${r.cost.toFixed(2)}</span>
                  <span className="recent-meta">{timeAgo(r.lastMessageAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
