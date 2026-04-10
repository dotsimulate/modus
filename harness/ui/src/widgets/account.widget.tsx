/**
 * Account widget — Claude Code account info + time-period cost breakdown.
 *
 * Config example (in user profile dashboard.widgets):
 *   { "id": "account-main", "type": "account" }
 */

import { useCallback } from "react";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import { fmtCost, planLabel } from "../utils/format";
import { useWidgetPollingValue } from "./widget-data";
import { WidgetEmptyState } from "./widget-components";

// ── Helpers ──

function planClass(sub: string): string {
  switch (sub) {
    case "max": return "account-plan--max";
    case "pro": return "account-plan--pro";
    case "enterprise": return "account-plan--enterprise";
    case "team": return "account-plan--team";
    default: return "";
  }
}

// ── Component ──

export default function AccountWidget() {
  const { activeUserProfile } = useProfiles();
  const loadAccount = useCallback(
    () => modus.getAccountInfo(activeUserProfile ?? undefined),
    [activeUserProfile],
  );
  const { value: info, loading } = useWidgetPollingValue({
    load: loadAccount,
    scopeKey: activeUserProfile ?? "",
    intervalMs: 60_000,
    initialValue: null,
  });

  if (loading || !info) {
    return <WidgetEmptyState>loading account...</WidgetEmptyState>;
  }

  const { account, costs } = info;

  return (
    <div className="account-widget">
      {/* ── Account info ── */}
      {account && account.loggedIn && (
        <div className="account-identity">
          <div className="account-header-row">
            <span className="account-org">{account.orgName}</span>
            <span className={`account-plan ${planClass(account.subscriptionType)}`}>
              {planLabel(account.subscriptionType)}
            </span>
          </div>
          <span className="account-email">{account.email}</span>
        </div>
      )}

      {/* ── Period costs ── */}
      <div className="account-periods">
        <PeriodBlock label="today" data={costs.today} />
        <PeriodBlock label="7 days" data={costs.week} />
        <PeriodBlock label="30 days" data={costs.month} />
      </div>
    </div>
  );
}

function PeriodBlock({ label, data }: {
  label: string;
  data: { cost: number; sessions: number; messages: number };
}) {
  return (
    <div className="account-period">
      <span className="account-period-cost">{fmtCost(data.cost)}</span>
      <div className="account-period-meta">
        <span className="account-period-label">{label}</span>
        <span className="account-period-detail">
          {data.sessions} session{data.sessions !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}

