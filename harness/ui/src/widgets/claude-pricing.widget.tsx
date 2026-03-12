/**
 * Claude Pricing Widget — consolidated account info, costs, and analytics.
 *
 * Combines identity, period costs, KPI numbers, and activity charts into
 * a single tabbed widget for a denser, more focused dashboard.
 */

import { useCallback, useState } from "react";
import { fetchAccountInfo, fetchSessionStats } from "../api";
import type { AccountInfo, SessionStats } from "../api";
import { useProfiles } from "../providers/ProfileProvider";
import { fmtCost, fmtNum, basename, planLabel } from "../utils/format";
import type { WidgetDef } from "./index";
import { ActivityChart, HBar, WidgetEmptyState } from "./widget-components";
import { useWidgetPollingValue } from "./widget-data";

type Tab = "overview" | "history" | "breakdown";

// ── Helpers ──

function planClass(sub: string): string {
  switch (sub) {
    case "max": return "cpw-plan--max";
    case "pro": return "cpw-plan--pro";
    case "enterprise": return "cpw-plan--enterprise";
    case "team": return "cpw-plan--team";
    default: return "";
  }
}

type BreakdownRow =
  | SessionStats["byProfile"][number]
  | SessionStats["byProject"][number];

// ── Main Component ──

function ClaudePricingWidget() {
  const { activeUserProfile } = useProfiles();
  const [tab, setTab] = useState<Tab>("overview");
  const [breakdownView, setBreakdownView] = useState<"agents" | "projects">("agents");
  const [chartMode, setChartMode] = useState<"sessions" | "cost">("cost");
  const loadPricing = useCallback(
    async (): Promise<{ account: AccountInfo; stats: SessionStats }> => {
      const [account, stats] = await Promise.all([
        fetchAccountInfo(activeUserProfile ?? undefined),
        fetchSessionStats(activeUserProfile ?? undefined),
      ]);
      return { account, stats };
    },
    [activeUserProfile],
  );
  const {
    value: pricing,
    loading,
  } = useWidgetPollingValue<{ account: AccountInfo; stats: SessionStats } | null>({
    load: loadPricing,
    scopeKey: activeUserProfile ?? "",
    intervalMs: 30_000,
    initialValue: null,
  });

  if (loading || !pricing) {
    return <WidgetEmptyState>loading pricing...</WidgetEmptyState>;
  }

  const { account, stats } = pricing;
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
            <ActivityChart daily={daily} prefix="cpw" mode={chartMode} />

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
              {(breakdownView === "agents" ? byProfile : byProject).slice(0, 8).map((p: BreakdownRow) => (
                <div key={"profile" in p ? p.profile : p.project} className="cpw-list-item cpw-list-item--hbar">
                  <div className="cpw-item-row">
                    <span className="cpw-item-name">{"profile" in p ? p.profile : basename(p.project)}</span>
                    <span className="cpw-item-val">{fmtCost(p.cost)}</span>
                  </div>
                  <HBar value={p.cost} max={breakdownView === "agents" ? (byProfile[0]?.cost || 1) : (byProject[0]?.cost || 1)} prefix="cpw" />
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
