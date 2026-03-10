/**
 * Account widget — Claude Code account info + time-period cost breakdown.
 *
 * Config example (in user profile dashboard.widgets):
 *   { "type": "account" }
 */

import { useState, useEffect } from "react";
import { fetchAccountInfo } from "../api";
import type { AccountInfo } from "../api";
import { useProfiles } from "../providers/ProfileProvider";
import type { WidgetBase, WidgetProps, WidgetDef } from "./index";

// ── Config ──

type AccountConfig = WidgetBase & {
  type: "account";
};

// ── Helpers ──

function fmtCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
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
    case "max": return "account-plan--max";
    case "pro": return "account-plan--pro";
    case "enterprise": return "account-plan--enterprise";
    case "team": return "account-plan--team";
    default: return "";
  }
}

// ── Component ──

function AccountWidget(_props: WidgetProps<AccountConfig>) {
  const { activeUserProfile } = useProfiles();
  const [info, setInfo] = useState<AccountInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await fetchAccountInfo(activeUserProfile ?? undefined);
        if (alive) setInfo(data);
      } catch { /* silent */ }
    };
    load();
    const iv = setInterval(load, 60_000); // refresh every 60s
    return () => { alive = false; clearInterval(iv); };
  }, [activeUserProfile]);

  if (!info) {
    return <div className="dash-empty">loading account...</div>;
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

// ── Widget definition ──

const def: WidgetDef = { type: "account", component: AccountWidget };
export default def;
