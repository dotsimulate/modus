/**
 * Provider Status widget — health overview of all registered providers.
 *
 * Config example (in user profile dashboard.widgets or LeftPanel widgets):
 *   { "id": "provider-status-main", "type": "provider-status", "title": "providers" }
 */

import { useCallback } from "react";
import { fetchProviderHealth } from "../api";
import type { ProviderHealthInfo } from "../api";
import type { WidgetDef } from "./index";
import { WidgetEmptyState } from "./widget-components";
import { useWidgetPollingValue } from "./widget-data";

// ── Helpers ──

function dotClass(status: ProviderHealthInfo["status"]): string {
  switch (status) {
    case "ready": return "psw-dot--ready";
    case "misconfigured": return "psw-dot--warn";
    case "unavailable": return "psw-dot--off";
    default: return "psw-dot--off";
  }
}

function detail(p: ProviderHealthInfo): string {
  if (p.checks.length === 0) return "";
  const fail = p.checks.find(c => !c.passed);
  if (fail) {
    if (fail.type === "cli") return "no cli";
    if (fail.type === "env") return "no key";
    if (fail.type === "auth") return "no auth";
    if (fail.type === "local") return "offline";
    return fail.detail ?? "—";
  }
  return p.checks.map(c => {
    if (c.type === "cli") return "cli";
    if (c.type === "env") return "key";
    if (c.type === "auth") return c.detail ?? "auth";
    if (c.type === "local") return "up";
    return c.label;
  }).join(" · ");
}

// ── Component ──

function ProviderStatusWidget() {
  const load = useCallback(() => fetchProviderHealth(), []);
  const { value: providers, loading } = useWidgetPollingValue<ProviderHealthInfo[]>({
    load,
    scopeKey: "provider-health",
    intervalMs: 60_000,
    initialValue: [],
  });

  if (loading && providers.length === 0) {
    return <WidgetEmptyState>checking providers...</WidgetEmptyState>;
  }

  return (
    <div className="psw-widget">
      {providers.map(p => (
        <div key={p.name} className="psw-row">
          <span className={`psw-dot ${dotClass(p.status)}`} />
          <span className="psw-name">{p.label}</span>
          <span className="psw-detail">{detail(p)}</span>
        </div>
      ))}
    </div>
  );
}

const def: WidgetDef = { type: "provider-status", component: ProviderStatusWidget };
export default def;
