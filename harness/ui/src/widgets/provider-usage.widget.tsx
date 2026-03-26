import { useCallback, useMemo } from "react";
import { modus } from "../modusClient";
import type { ModelUsageTotal, ProviderUsageAnalytics, ProviderUsageDaily } from "../../../sdk/index";
import { useProfiles } from "../providers/ProfileProvider";
import { fmtCost, fmtNum } from "../utils/format";
import type { WidgetBase, WidgetDef, WidgetProps } from "./index";
import { HBar, WidgetEmptyState } from "./widget-components";
import { useWidgetPollingValue } from "./widget-data";
import { useWidgetUiState } from "./ui-state";

type ProviderUsageConfig = WidgetBase & {
  type: "provider-usage";
  days?: number;
};

type UsageTab = "providers" | "models" | "trend";

function providerLabel(provider: string): string {
  if (provider === "claude-code") return "claude";
  if (provider === "gemini-cli") return "gemini";
  return provider;
}

function sparklineDays(
  provider: string,
  daily: ProviderUsageDaily[],
  windowDays: number,
): number[] {
  const dayMap = new Map(
    daily
      .filter((item) => item.provider === provider)
      .map((item) => [item.day, item.totalTokens]),
  );
  const result: number[] = [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    result.push(dayMap.get(day) ?? 0);
  }
  return result;
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="puw-sparkline">
      {values.map((value, index) => (
        <div
          key={index}
          className="puw-spark"
          style={{ height: `${Math.max(1, Math.round((value / max) * 22))}px` }}
          title={`${fmtNum(value)} tok`}
        />
      ))}
    </div>
  );
}

function ProviderUsageWidget({ config, widgetId }: WidgetProps<ProviderUsageConfig>) {
  const { activeCwd, activeUserProfile } = useProfiles();
  const [tab, setTab] = useWidgetUiState<UsageTab>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "tab",
    "providers",
  );
  const days = config.days ?? 30;
  const loadUsage = useCallback(
    () => modus.getProviderUsageAnalytics(activeUserProfile ?? undefined, days),
    [activeUserProfile, days],
  );
  const { value: usage, loading } = useWidgetPollingValue<ProviderUsageAnalytics | null>({
    load: loadUsage,
    scopeKey: `${activeUserProfile ?? ""}:${days}`,
    intervalMs: 30_000,
    initialValue: null,
  });

  const trendProviders = useMemo(
    () => (usage?.providers.slice(0, 4) ?? []).map((provider) => ({
      provider: provider.provider,
      values: sparklineDays(provider.provider, usage?.daily ?? [], usage?.windowDays ?? days),
      totalTokens: provider.totalTokens,
    })),
    [days, usage?.daily, usage?.providers, usage?.windowDays],
  );

  if (loading || !usage) {
    return <WidgetEmptyState>loading usage...</WidgetEmptyState>;
  }

  if (usage.providers.length === 0) {
    return <WidgetEmptyState>no provider usage yet</WidgetEmptyState>;
  }

  const maxProviderTokens = usage.providers[0]?.totalTokens ?? 1;
  const maxModelTokens = usage.models[0]?.totalTokens ?? 1;
  const topModels = usage.models.slice(0, 8);

  return (
    <div className="puw-widget">
      <div className="puw-topline">
        <div className="puw-kpi">
          <span className="puw-kpi-value">{fmtNum(usage.totals.totalTokens)}</span>
          <span className="puw-kpi-label">{usage.windowDays}d tokens</span>
        </div>
        <div className="puw-kpi">
          <span className="puw-kpi-value">{fmtNum(usage.totals.sessions)}</span>
          <span className="puw-kpi-label">sessions</span>
        </div>
        <div className="puw-kpi">
          <span className="puw-kpi-value">{fmtNum(usage.totals.turns)}</span>
          <span className="puw-kpi-label">turns</span>
        </div>
        {usage.totals.cost > 0 && (
          <div className="puw-kpi">
            <span className="puw-kpi-value">{fmtCost(usage.totals.cost)}</span>
            <span className="puw-kpi-label">cost</span>
          </div>
        )}
      </div>

      <div className="puw-tabs">
        {(["providers", "models", "trend"] as UsageTab[]).map((nextTab) => (
          <button
            key={nextTab}
            className={`puw-tab ${tab === nextTab ? "puw-tab--active" : ""}`}
            onClick={() => setTab(nextTab)}
          >
            {nextTab}
          </button>
        ))}
      </div>

      {tab === "providers" && (
        <div className="puw-list">
          {usage.providers.map((provider) => (
            <div key={provider.provider} className="puw-row">
              <div className="puw-row-head">
                <span className="puw-name">{providerLabel(provider.provider)}</span>
                <span className="puw-meta">
                  {fmtNum(provider.sessions)} sess · {fmtNum(provider.totalTokens)} tok
                </span>
              </div>
              <div className="puw-row-bar">
                <HBar value={provider.totalTokens} max={maxProviderTokens} prefix="puw" />
              </div>
              <div className="puw-row-tail">
                <span>{fmtNum(provider.turns)} turns</span>
                {provider.cost > 0 && <span>{fmtCost(provider.cost)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "models" && (
        <div className="puw-list">
          {topModels.map((model: ModelUsageTotal) => (
            <div key={`${model.provider}:${model.model}`} className="puw-row">
              <div className="puw-row-head">
                <span className="puw-name">{model.model}</span>
                <span className="puw-meta">{providerLabel(model.provider)}</span>
              </div>
              <div className="puw-row-bar">
                <HBar value={model.totalTokens} max={maxModelTokens} prefix="puw" />
              </div>
              <div className="puw-row-tail">
                <span>{fmtNum(model.totalTokens)} tok</span>
                <span>{fmtNum(model.sessions)} sess</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "trend" && (
        <div className="puw-trends">
          {trendProviders.map((provider) => (
            <div key={provider.provider} className="puw-trend-row">
              <div className="puw-trend-head">
                <span className="puw-name">{providerLabel(provider.provider)}</span>
                <span className="puw-meta">{fmtNum(provider.totalTokens)} tok</span>
              </div>
              <Sparkline values={provider.values} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const def: WidgetDef = { type: "provider-usage", component: ProviderUsageWidget };
export default def;
