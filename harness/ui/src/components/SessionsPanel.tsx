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
  updatedAt: number;
  active: boolean;
  subscribers?: number;
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
      updatedAt: a.lastEventAt,
      active: true,
      subscribers: a.subscribers,
    });
  }

  for (const s of recent) {
    if (seen.has(s.id)) continue;
    rows.push({
      id: s.id,
      status: s.status,
      profile: s.profile,
      model: s.model,
      cost: s.total_cost_usd,
      turns: s.message_count,
      preview: s.last_prompt ?? s.preview,
      updatedAt: s.updated_at,
      active: false,
    });
  }

  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function statusDot(status: string) {
  if (status === "running" || status === "starting") return <span className="dash-dot dash-dot--running" />;
  if (status === "idle") return <span className="dash-dot dash-dot--idle" />;
  if (status === "error") return <span className="dash-dot dash-dot--error" />;
  return <span className="dash-dot dash-dot--done" />;
}

function shortModel(model: string | null): string {
  if (!model) return "";
  return model.replace("claude-", "").replace(/-\d{8}.*/, "");
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

  const activeCount = rows.filter((r) => r.active).length;

  return (
    <div className="dash-panel">
      <button className="dash-panel-header" onClick={() => setOpen(!open)}>
        <span className="dash-panel-title">sessions</span>
        {activeCount > 0 && (
          <span className="dash-active-count">{activeCount} active</span>
        )}
        <span className={`profile-panel-chevron ${open ? "profile-panel-chevron--open" : ""}`}>
          {chevron}
        </span>
      </button>
      <div className={`panel-collapse ${open ? "panel-collapse--open" : ""}`}>
        <div className="panel-collapse-clip">
          <table className="dash-table">
            <thead>
              <tr>
                <th className="dash-th-status"></th>
                <th>session</th>
                <th>profile</th>
                <th>model</th>
                <th>cost</th>
                <th>time</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} className="dash-empty">no sessions</td></tr>
              )}
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`dash-row ${r.active ? "dash-row--active" : ""}`}
                  onClick={() => onSelectSession(r.id)}
                >
                  <td className="dash-cell-status">{statusDot(r.status)}</td>
                  <td className="dash-cell-preview">{r.preview}</td>
                  <td className="dash-cell-profile">{r.profile ?? ""}</td>
                  <td className="dash-cell-model">{shortModel(r.model)}</td>
                  <td className="dash-cell-cost">${r.cost.toFixed(3)}</td>
                  <td className="dash-cell-time">{timeAgo(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
