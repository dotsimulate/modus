/**
 * Claude Pricing Widget — consolidated account info, costs, and analytics.
 *
 * Combines identity, period costs, KPI numbers, and activity charts into
 * a single tabbed widget for a denser, more focused dashboard.
 */

import { useState, useEffect, useMemo } from "react";
import { fetchAccountInfo, fetchSessionStats } from "../api";
import type { AccountInfo, SessionStats } from "../api";
import { useProfiles } from "../providers/ProfileProvider";
import type { WidgetBase, WidgetProps, WidgetDef } from "./index";

// ── Types ──

type PricingConfig = WidgetBase & {
  type: "claude-pricing";
};

type Tab = "overview" | "history" | "breakdown";

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

function planLabel(sub: string): string {
  switch (sub) {
    case "max": return "Max";
    case "pro": return "Pro";
    case "free": return "Free";
    case "team": return "Team";
    case "enterprise": return "Enterprise";
    default: return sub;
  }
}

function planClass(sub: string): string {
  switch (sub) {
    case "max": return "cpw-plan--max";
    case "pro": return "cpw-plan--pro";
    case "enterprise": return "cpw-plan--enterprise";
    case "team": return "cpw-plan--team";
    default: return "";
  }
}

function projectName(cwd: string | null): string {
  if (!cwd || cwd === "(none)") return "(none)";
  const parts = cwd.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || cwd;
}

// ── Sub-components ──

function ActivityChart({ daily, mode }: { daily: SessionStats["daily"], mode: "sessions" | "cost" }) {
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

  const maxValue = Math.max(0.01, ...filled.map((d) => mode === "sessions" ? d.sessions : d.cost));

  return (
    <div className="cpw-chart">
      {filled.map((d) => {
        const val = mode === "sessions" ? d.sessions : d.cost;
        const h = Math.max(1, Math.round((val / maxValue) * 28));
        return (
          <div
            key={d.day}
            className={`cpw-chart-bar cpw-chart-bar--${mode}`}
            style={{ height: `${h}px` }}
            title={`${d.day}: ${d.sessions} sessions, ${fmtCost(d.cost)}`}
          />
        );
      })}
    </div>
  );
}

function HBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(1, (value / max) * 100) : 0;
  return (
    <div className="cpw-hbar">
      <div className="cpw-hbar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Main Component ──

function ClaudePricingWidget(_props: WidgetProps<PricingConfig>) {
  const { activeUserProfile } = useProfiles();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [breakdownView, setBreakdownView] = useState<"agents" | "projects">("agents");
  const [chartMode, setChartMode] = useState<"sessions" | "cost">("cost");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [a, s] = await Promise.all([
          fetchAccountInfo(activeUserProfile ?? undefined),
          fetchSessionStats(activeUserProfile ?? undefined),
        ]);
        if (alive) {
          setAccount(a);
          setStats(s);
        }
      } catch { /* silent */ }
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(iv); };
  }, [activeUserProfile]);

  if (!account || !stats) {
    return <div className="dash-empty">loading pricing...</div>;
  }

  const { totals, byProject, byProfile, daily, topSessions } = stats;

  return (
    <div className="cpw-widget">
      {/* ── Tabs ── */}
      <div className="cpw-tabs">
        <button
          className={`cpw-tab ${tab === "overview" ? "cpw-tab--active" : ""}`}
          onClick={() => setTab("overview")}
        >overview</button>
        <button
          className={`cpw-tab ${tab === "history" ? "cpw-tab--active" : ""}`}
          onClick={() => setTab("history")}
        >history</button>
        <button
          className={`cpw-tab ${tab === "breakdown" ? "cpw-tab--active" : ""}`}
          onClick={() => setTab("breakdown")}
        >breakdown</button>
      </div>

      <div className="cpw-content">
        {tab === "overview" && (
          <div className="cpw-overview">
            {/* Account identity */}
            {account.account && account.account.loggedIn && (
              <div className="cpw-identity">
                <div className="cpw-identity-header">
                  <span className="cpw-org">{account.account.orgName}</span>
                  <span className={`cpw-plan ${planClass(account.account.subscriptionType)}`}>
                    {planLabel(account.account.subscriptionType)}
                  </span>
                </div>
                <span className="cpw-email">{account.account.email}</span>
              </div>
            )}

            {/* KPI row */}
            <div className="cpw-kpis">
              <div className="cpw-kpi">
                <span className="cpw-kpi-val">{fmtCost(totals.cost)}</span>
                <span className="cpw-kpi-lbl">total cost</span>
              </div>
              <div className="cpw-kpi">
                <span className="cpw-kpi-val">{fmtNum(totals.sessions)}</span>
                <span className="cpw-kpi-lbl">sessions</span>
              </div>
              <div className="cpw-kpi">
                <span className="cpw-kpi-val">{fmtNum(totals.messages)}</span>
                <span className="cpw-kpi-lbl">messages</span>
              </div>
            </div>

            {/* Period costs */}
            <div className="cpw-periods">
              <div className="cpw-period">
                <span className="cpw-period-cost">{fmtCost(account.costs.today.cost)}</span>
                <span className="cpw-period-lbl">today</span>
              </div>
              <div className="cpw-period">
                <span className="cpw-period-cost">{fmtCost(account.costs.week.cost)}</span>
                <span className="cpw-period-lbl">last 7d</span>
              </div>
              <div className="cpw-period">
                <span className="cpw-period-cost">{fmtCost(account.costs.month.cost)}</span>
                <span className="cpw-period-lbl">last 30d</span>
              </div>
            </div>
          </div>
        )}

        {tab === "history" && (
          <div className="cpw-history">
            <div className="cpw-section-header">
              <span className="cpw-section-lbl">30-day {chartMode}</span>
              <div className="cpw-toggle">
                <button
                  className={chartMode === "cost" ? "active" : ""}
                  onClick={() => setChartMode("cost")}
                >cost</button>
                <button
                  className={chartMode === "sessions" ? "active" : ""}
                  onClick={() => setChartMode("sessions")}
                >sessions</button>
              </div>
            </div>
            <ActivityChart daily={daily} mode={chartMode} />

            {topSessions.length > 0 && (
              <div className="cpw-top-sessions">
                <span className="cpw-section-lbl">costliest sessions</span>
                <div className="cpw-list">
                  {topSessions.slice(0, 5).map((s) => (
                    <div key={s.id} className="cpw-list-item">
                      <span className="cpw-item-name">{s.preview || "new session"}</span>
                      <span className="cpw-item-val">{fmtCost(s.cost)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "breakdown" && (
          <div className="cpw-breakdown">
            <div className="cpw-section-header">
              <div className="cpw-toggle">
                <button
                  className={breakdownView === "agents" ? "active" : ""}
                  onClick={() => setBreakdownView("agents")}
                >agents</button>
                <button
                  className={breakdownView === "projects" ? "active" : ""}
                  onClick={() => setBreakdownView("projects")}
                >projects</button>
              </div>
            </div>

            <div className="cpw-list">
              {(breakdownView === "agents" ? byProfile : byProject).slice(0, 8).map((p: any) => (
                <div key={p.profile || p.project} className="cpw-list-item cpw-list-item--hbar">
                  <div className="cpw-item-row">
                    <span className="cpw-item-name">{p.profile || projectName(p.project)}</span>
                    <span className="cpw-item-val">{fmtCost(p.cost)}</span>
                  </div>
                  <HBar value={p.cost} max={breakdownView === "agents" ? (byProfile[0]?.cost || 1) : (byProject[0]?.cost || 1)} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const def: WidgetDef = { type: "claude-pricing", component: ClaudePricingWidget };
export default def;
