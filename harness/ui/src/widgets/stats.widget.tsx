/**
 * User Stats widget — cost, session counts, project/agent breakdowns, activity.
 *
 * Config example (in user profile dashboard.widgets):
 *   { "id": "stats-main", "type": "stats", "title": "stats" }
 */

import { useState, useEffect, useMemo } from "react";
import { fetchSessionStats } from "../api";
import type { SessionStats } from "../api";
import { useProfiles } from "../providers/ProfileProvider";
import type { WidgetBase, WidgetProps, WidgetDef } from "./index";

// ── Config ──

type StatsConfig = WidgetBase & {
  type: "stats";
};

// ── Helpers ──

function fmtCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function projectName(cwd: string | null): string {
  if (!cwd || cwd === "(none)") return "(none)";
  const parts = cwd.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || cwd;
}

function daysSince(ts: number | null): number {
  if (!ts) return 0;
  return Math.floor((Date.now() - ts) / 86_400_000);
}

function streak(daily: SessionStats["daily"]): number {
  if (daily.length === 0) return 0;
  // Work backwards from today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daySet = new Set(daily.map((d) => d.day));
  let count = 0;
  for (let i = 0; i < 60; i++) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    if (daySet.has(key)) count++;
    else if (i > 0) break; // allow today to be missing (day not over)
  }
  return count;
}

// ── Mini bar chart ──

function ActivityChart({ daily }: { daily: SessionStats["daily"] }) {
  // Fill in missing days for last 30 days
  const filled = useMemo(() => {
    const map = new Map(daily.map((d) => [d.day, d]));
    const days: { day: string; sessions: number; cost: number }[] = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      days.push(map.get(key) ?? { day: key, sessions: 0, cost: 0 });
    }
    return days;
  }, [daily]);

  const maxSessions = Math.max(1, ...filled.map((d) => d.sessions));

  return (
    <div className="stats-chart">
      {filled.map((d) => {
        const h = Math.max(1, Math.round((d.sessions / maxSessions) * 24));
        return (
          <div
            key={d.day}
            className="stats-chart-bar"
            style={{ height: `${h}px` }}
            title={`${d.day}: ${d.sessions} sessions, ${fmtCost(d.cost)}`}
          />
        );
      })}
    </div>
  );
}

// ── Horizontal bar ──

function HBar({ value, max, color }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.max(1, (value / max) * 100) : 0;
  return (
    <div className="stats-hbar">
      <div
        className="stats-hbar-fill"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

// ── Component ──

function StatsWidget(_props: WidgetProps<StatsConfig>) {
  const { activeUserProfile } = useProfiles();
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [view, setView] = useState<"all" | "project">("all");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await fetchSessionStats(activeUserProfile ?? undefined);
        if (alive) setStats(s);
      } catch { /* silent */ }
    };
    load();
    const iv = setInterval(load, 30_000); // refresh every 30s
    return () => { alive = false; clearInterval(iv); };
  }, [activeUserProfile]);

  if (!stats) {
    return <div className="dash-empty">loading stats...</div>;
  }

  const { totals, byProject, byProfile, byModel, daily, topSessions } = stats;

  if (totals.sessions === 0) {
    return <div className="dash-empty">no sessions yet</div>;
  }

  const avgCost = totals.sessions > 0 ? totals.cost / totals.sessions : 0;
  const avgMsgs = totals.sessions > 0 ? totals.messages / totals.sessions : 0;
  const daysActive = daysSince(totals.firstSession);
  const currentStreak = streak(daily);
  const maxProjectCost = byProject.length > 0 ? byProject[0].cost : 1;
  const maxProfileCost = byProfile.length > 0 ? byProfile[0].cost : 1;

  return (
    <div className="stats-widget">
      {/* ── Big numbers ── */}
      <div className="stats-kpi-row">
        <div className="stats-kpi">
          <span className="stats-kpi-value">{fmtCost(totals.cost)}</span>
          <span className="stats-kpi-label">total cost</span>
        </div>
        <div className="stats-kpi">
          <span className="stats-kpi-value">{fmtNum(totals.sessions)}</span>
          <span className="stats-kpi-label">sessions</span>
        </div>
        <div className="stats-kpi">
          <span className="stats-kpi-value">{fmtNum(totals.messages)}</span>
          <span className="stats-kpi-label">messages</span>
        </div>
        <div className="stats-kpi">
          <span className="stats-kpi-value">{fmtCost(avgCost)}</span>
          <span className="stats-kpi-label">avg/session</span>
        </div>
        <div className="stats-kpi">
          <span className="stats-kpi-value">{avgMsgs.toFixed(0)}</span>
          <span className="stats-kpi-label">avg msgs</span>
        </div>
        {currentStreak > 0 && (
          <div className="stats-kpi">
            <span className="stats-kpi-value stats-kpi-value--streak">{currentStreak}d</span>
            <span className="stats-kpi-label">streak</span>
          </div>
        )}
        {daysActive > 0 && (
          <div className="stats-kpi">
            <span className="stats-kpi-value">{daysActive}d</span>
            <span className="stats-kpi-label">active</span>
          </div>
        )}
      </div>

      {/* ── 30-day activity ── */}
      <div className="stats-section">
        <span className="stats-section-label">30-day activity</span>
        <ActivityChart daily={daily} />
      </div>

      {/* ── Toggle: projects / agents ── */}
      <div className="stats-section">
        <div className="stats-tabs">
          <button
            className={`stats-tab ${view === "all" ? "stats-tab--active" : ""}`}
            onClick={() => setView("all")}
          >agents</button>
          <button
            className={`stats-tab ${view === "project" ? "stats-tab--active" : ""}`}
            onClick={() => setView("project")}
          >projects</button>
        </div>

        {view === "all" ? (
          <div className="stats-breakdown">
            {byProfile.map((p) => (
              <div key={p.profile} className="stats-row">
                <span className="stats-row-name">{p.profile}</span>
                <HBar value={p.cost} max={maxProfileCost} />
                <span className="stats-row-num">{fmtNum(p.sessions)}</span>
                <span className="stats-row-cost">{fmtCost(p.cost)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="stats-breakdown">
            {byProject.map((p) => (
              <div key={p.project} className="stats-row">
                <span className="stats-row-name">{projectName(p.project)}</span>
                <HBar value={p.cost} max={maxProjectCost} />
                <span className="stats-row-num">{fmtNum(p.sessions)}</span>
                <span className="stats-row-cost">{fmtCost(p.cost)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Models ── */}
      {byModel.length > 1 && (
        <div className="stats-section">
          <span className="stats-section-label">models</span>
          <div className="stats-model-row">
            {byModel.map((m) => (
              <span key={m.model} className="stats-model-tag">
                {m.model.replace(/^.*\//, "").replace(/^claude-/, "")}
                <span className="stats-model-count">{fmtNum(m.sessions)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Costliest sessions ── */}
      {topSessions.length > 0 && topSessions[0].cost > 0 && (
        <div className="stats-section">
          <span className="stats-section-label">costliest sessions</span>
          <div className="stats-breakdown">
            {topSessions.map((s) => (
              <div key={s.id} className="stats-row stats-row--session">
                <span className="stats-row-name">{s.preview || "new session"}</span>
                <span className="stats-row-num">{fmtNum(s.messages)} msgs</span>
                <span className="stats-row-cost">{fmtCost(s.cost)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Widget definition ──

const def: WidgetDef = { type: "stats", component: StatsWidget };
export default def;
