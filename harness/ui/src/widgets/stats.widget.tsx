/**
 * User Stats widget — cost, session counts, project/agent breakdowns, activity.
 *
 * Config example (in user profile dashboard.widgets):
 *   { "id": "stats-main", "type": "stats", "title": "stats" }
 */

import { useCallback, useState } from "react";
import { modus } from "../modusClient";
import type { SessionStats } from "../../../sdk/index";
import { useProfiles } from "../providers/ProfileProvider";
import { fmtCost, fmtNum, basename } from "../utils/format";
import type { WidgetDef } from "./index";
import { ActivityChart, HBar, WidgetEmptyState } from "./widget-components";
import { useWidgetPollingValue } from "./widget-data";

// ── Helpers ──

function daysSince(ts: number | null): number {
  if (!ts) return 0;
  return Math.floor((Date.now() - ts) / 86_400_000);
}

function streak(daily: SessionStats["daily"]): number {
  if (daily.length === 0) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daySet = new Set(daily.map((d) => d.day));
  let count = 0;
  for (let i = 0; i < 60; i++) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    if (daySet.has(key)) count++;
    else if (i > 0) break;
  }
  return count;
}

// ── Component ──

function StatsWidget() {
  const { activeUserProfile } = useProfiles();
  const [view, setView] = useState<"all" | "project">("all");
  const loadStats = useCallback(
    () => modus.getSessionStats(activeUserProfile ?? undefined),
    [activeUserProfile],
  );
  const { value: stats, loading } = useWidgetPollingValue<SessionStats | null>({
    load: loadStats,
    scopeKey: activeUserProfile ?? "",
    intervalMs: 30_000,
    initialValue: null,
  });

  if (loading || !stats) {
    return <WidgetEmptyState>loading stats...</WidgetEmptyState>;
  }

  const { totals, byProject, byProfile, byModel, daily, topSessions } = stats;

  if (totals.sessions === 0) {
    return <WidgetEmptyState>no sessions yet</WidgetEmptyState>;
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
        <ActivityChart daily={daily} prefix="stats" />
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
                <HBar value={p.cost} max={maxProfileCost} prefix="stats" />
                <span className="stats-row-num">{fmtNum(p.sessions)}</span>
                <span className="stats-row-cost">{fmtCost(p.cost)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="stats-breakdown">
            {byProject.map((p) => (
              <div key={p.project} className="stats-row">
                <span className="stats-row-name">{basename(p.project)}</span>
                <HBar value={p.cost} max={maxProjectCost} prefix="stats" />
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
