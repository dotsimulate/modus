import { useCallback, useEffect, useMemo, useState } from "react";
import { modus } from "../modusClient";
import type {
  DeepAnalytics,
  DeepAnalyticsBucket,
  DeepAnalyticsMetricRow,
  DeepAnalyticsSessionRow,
} from "../../../sdk/index";
import { InlineTabs } from "../components/InlineTabs";
import { TimeAxis } from "../components/TimeAxis";
import { DateTimeField } from "../components/DateTimeField";
import { CustomSelect, WidgetEmptyState } from "./widget-components";
import { useProfiles } from "../providers/ProfileProvider";
import { basename, fmtCost, fmtNum, timeAgo } from "../utils/format";
import type { WidgetBase, WidgetDef, WidgetProps } from "./index";
import { useWidgetPollingValue } from "./widget-data";
import { useWidgetUiState } from "./ui-state";

type DeepAnalyticsConfig = WidgetBase & {
  type: "deep-analytics";
  bucketMs?: number;
};

type ScopeMode = "current" | "all";
type Tab = "overview" | "breakdown" | "sessions" | "trace";
type BreakdownKey = "provider" | "model" | "profile" | "project";

const BUCKET_OPTIONS = [
  { label: "5m", value: 5 * 60_000 },
  { label: "15m", value: 15 * 60_000 },
  { label: "30m", value: 30 * 60_000 },
  { label: "1h", value: 60 * 60_000 },
  { label: "2h", value: 2 * 60 * 60_000 },
  { label: "6h", value: 6 * 60 * 60_000 },
  { label: "12h", value: 12 * 60 * 60_000 },
  { label: "1d", value: 24 * 60 * 60_000 },
] as const;

const BREAKDOWN_OPTIONS = [
  { value: "provider", label: "providers" },
  { value: "model", label: "models" },
  { value: "profile", label: "profiles" },
  { value: "project", label: "projects" },
] satisfies Array<{ value: BreakdownKey; label: string }>;

const TAB_OPTIONS: Array<{ value: Tab; label: string }> = [
  { value: "overview", label: "overview" },
  { value: "breakdown", label: "breakdown" },
  { value: "sessions", label: "sessions" },
  { value: "trace", label: "trace" },
];

const TOKEN_SEGMENTS = [
  { key: "inputTokens", label: "input", color: "color-mix(in srgb, var(--accent) 74%, transparent)" },
  { key: "outputTokens", label: "output", color: "color-mix(in srgb, var(--text-secondary) 92%, transparent)" },
] as const;

const ACTIVITY_SEGMENTS = [
  { key: "userMessages", label: "user", color: "color-mix(in srgb, var(--text) 82%, transparent)" },
  { key: "assistantTurns", label: "assistant", color: "var(--accent)" },
  { key: "toolCalls", label: "tools", color: "color-mix(in srgb, var(--text-secondary) 72%, transparent)" },
  { key: "touches", label: "trace", color: "color-mix(in srgb, var(--border-focus) 92%, transparent)" },
] as const;

function toLocalInputValue(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInputValue(value: string): number {
  return new Date(value).getTime();
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const min = minutes % 60;
  return min > 0 ? `${hours}h ${min}m` : `${hours}h`;
}

function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function compactRange(start: number, end: number): string {
  return `${fmtDateTime(start)} to ${fmtDateTime(end)}`;
}

function chartTotal(bucket: DeepAnalyticsBucket, keys: readonly string[]): number {
  return keys.reduce((sum, key) => sum + ((bucket as Record<string, number>)[key] ?? 0), 0);
}

function StackedTimeline({
  title,
  buckets,
  segments,
  footer,
  formatter,
}: {
  title: string;
  buckets: DeepAnalyticsBucket[];
  segments: ReadonlyArray<{ key: string; label: string; color: string }>;
  footer: string;
  formatter: (n: number) => string;
}) {
  const totals = buckets.map((bucket) => chartTotal(bucket, segments.map((segment) => segment.key)));
  const max = Math.max(1, ...totals);
  const plotWidth = Math.max(320, buckets.length * 10);

  return (
    <div className="dax-chart">
      <div className="dax-chart-head">
        <div>
          <div className="dax-chart-title">{title}</div>
          <div className="dax-chart-sub">{footer}</div>
        </div>
        <div className="dax-chart-legend">
          {segments.map((segment) => (
            <span key={segment.key} className="dax-legend-pill">
              <span className="dax-legend-dot" style={{ background: segment.color }} />
              {segment.label}
            </span>
          ))}
        </div>
      </div>

      <div className="dax-chart-scroll">
        <div className="dax-chart-scroll-inner" style={{ width: `${plotWidth}px` }}>
          <div className="dax-chart-bars">
            {buckets.map((bucket, index) => {
              const total = totals[index];
              return (
                <div
                  key={bucket.start}
                  className="dax-chart-col"
                  title={`${fmtDateTime(bucket.start)} · total ${formatter(total)}`}
                >
                  <div className="dax-chart-stack" style={{ height: `${Math.max(8, Math.round((total / max) * 116))}px` }}>
                    {segments.map((segment) => {
                      const value = (bucket as Record<string, number>)[segment.key] ?? 0;
                      if (value <= 0) return null;
                      return (
                        <div
                          key={segment.key}
                          className="dax-chart-segment"
                          style={{ height: `${Math.max(1, (value / total) * 100)}%`, background: segment.color }}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <TimeAxis buckets={buckets} width={plotWidth} />
        </div>
      </div>
    </div>
  );
}

function KpiStrip({ analytics }: { analytics: DeepAnalytics }) {
  const items = [
    { label: "tokens", value: fmtNum(analytics.totals.totalTokens) },
    { label: "cost", value: fmtCost(analytics.totals.cost) },
    { label: "active", value: fmtNum(analytics.totals.sessionsActive) },
    { label: "started", value: fmtNum(analytics.totals.sessionsStarted) },
    { label: "user", value: fmtNum(analytics.totals.userMessages) },
    { label: "assistant", value: fmtNum(analytics.totals.assistantTurns) },
    { label: "tools", value: fmtNum(analytics.totals.toolCalls) },
    { label: "avg turn", value: fmtDuration(analytics.totals.avgDurationMs) },
  ];

  return (
    <div className="dax-kpis">
      {items.map((item) => (
        <div key={item.label} className="dax-kpi">
          <span className="dax-kpi-value">{item.value}</span>
          <span className="dax-kpi-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function OverviewSidebar({ analytics }: { analytics: DeepAnalytics }) {
  const max = Math.max(1, ...analytics.byHour.map((row) => row.totalTokens));
  const providers = analytics.byProvider.slice(0, 4);

  return (
    <div className="dax-sidebar">
      <div className="dax-panel">
        <div className="dax-panel-title">providers</div>
        <div className="dax-provider-list">
          {providers.map((row) => (
            <div key={row.key} className="dax-provider-row">
              <div className="dax-provider-head">
                <span className="dax-provider-name">{row.key}</span>
                <span className="dax-provider-meta">{fmtCost(row.cost)}</span>
              </div>
              <div className="dax-provider-sub">
                {fmtNum(row.totalTokens)} tok · {fmtNum(row.assistantTurns)} turns · {fmtNum(row.toolCalls)} tools
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="dax-panel">
        <div className="dax-panel-title">hour heat</div>
        <div className="dax-hours">
          {analytics.byHour.map((row) => (
            <div
              key={row.hour}
              className="dax-hour"
              style={{ opacity: 0.18 + (row.totalTokens / max) * 0.82 }}
              title={`${String(row.hour).padStart(2, "0")}:00 · ${fmtNum(row.totalTokens)} tok · ${fmtCost(row.cost)}`}
            >
              <span>{String(row.hour).padStart(2, "0")}</span>
              <strong>{fmtNum(row.totalTokens)}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="dax-panel">
        <div className="dax-panel-title">trace</div>
        <div className="dax-trace-summary">
          <span>{fmtNum(analytics.trace.summary.total)} touches</span>
          <span>{fmtNum(analytics.trace.summary.uniqueFiles)} files</span>
          <span>{fmtNum(analytics.trace.summary.uniqueSessions)} sessions</span>
        </div>
      </div>
    </div>
  );
}

function BreakdownTable({
  rows,
  kind,
}: {
  rows: DeepAnalyticsMetricRow[];
  kind: BreakdownKey;
}) {
  const max = rows[0]?.totalTokens ?? 1;
  return (
    <div className="dax-table-shell">
      <div className="dax-table">
        {rows.slice(0, 18).map((row) => (
          <div key={row.key} className="dax-table-row">
            <div className="dax-table-head">
              <span className="dax-table-name">{kind === "project" ? basename(row.key) : row.key}</span>
              <span className="dax-table-meta">{fmtNum(row.sessions)} sess · {fmtCost(row.cost)}</span>
            </div>
            <div className="dax-table-bar">
              <div className="dax-table-fill" style={{ width: `${Math.max(4, (row.totalTokens / max) * 100)}%` }} />
            </div>
            <div className="dax-table-tail">
              <span>{fmtNum(row.totalTokens)} tok</span>
              <span>{fmtNum(row.assistantTurns)} turns</span>
              <span>{fmtNum(row.toolCalls)} tools</span>
              <span>{fmtDuration(row.avgDurationMs)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionsView({ rows, onSelectSession }: {
  rows: DeepAnalyticsSessionRow[];
  onSelectSession: (id: string) => void;
}) {
  return (
    <div className="dax-table-shell">
      <div className="dax-session-head">
        <span>session</span>
        <span>provider</span>
        <span>age</span>
        <span>tokens</span>
        <span>cost</span>
        <span>tools</span>
        <span>touches</span>
      </div>
      <div className="dax-session-list">
        {rows.slice(0, 36).map((row) => (
          <button key={row.id} className="dax-session-row" onClick={() => onSelectSession(row.id)}>
            <span className="dax-session-main">
              <span className="dax-session-preview">{row.preview || "new session"}</span>
              <span className="dax-session-sub">{row.profile ?? "default"} · {basename(row.cwd)}</span>
            </span>
            <span>{row.provider ?? "unknown"}</span>
            <span>{timeAgo(row.lastMessageAt)}</span>
            <span>{fmtNum(row.totalTokens)}</span>
            <span>{fmtCost(row.totalCost)}</span>
            <span>{fmtNum(row.toolCalls)}</span>
            <span>{fmtNum(row.touches)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TraceView({ analytics }: { analytics: DeepAnalytics }) {
  const opEntries = Object.entries(analytics.trace.summary.byOp).sort((a, b) => b[1] - a[1]);
  const providerEntries = Object.entries(analytics.trace.summary.byProvider).sort((a, b) => b[1] - a[1]);

  return (
    <div className="dax-trace-grid">
      <div className="dax-trace-side">
        <div className="dax-panel">
          <div className="dax-panel-title">stats</div>
          <div className="dax-trace-stats">
            <span>{fmtNum(analytics.trace.summary.total)} touches</span>
            <span>{fmtNum(analytics.trace.summary.uniqueFiles)} files</span>
            <span>{fmtNum(analytics.trace.summary.uniqueSessions)} sessions</span>
          </div>
        </div>

        <div className="dax-panel">
          <div className="dax-panel-title">providers</div>
          <div className="dax-chip-grid">
            {providerEntries.map(([key, value]) => (
              <span key={key} className="dax-chip">{key} · {fmtNum(value)}</span>
            ))}
          </div>
        </div>

        <div className="dax-panel">
          <div className="dax-panel-title">ops</div>
          <div className="dax-chip-grid">
            {opEntries.map(([key, value]) => (
              <span key={key} className="dax-chip">{key} · {fmtNum(value)}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="dax-panel dax-panel--wide">
        <div className="dax-panel-title">top files</div>
        <div className="dax-file-list">
          {analytics.trace.topFiles.slice(0, 18).map((file) => (
            <div key={file.filePath} className="dax-file-row">
              <div className="dax-file-main">
                <span className="dax-file-name">{basename(file.filePath)}</span>
                <span className="dax-file-path">{file.filePath}</span>
              </div>
              <span className="dax-file-tail">{fmtNum(file.touches)} touches</span>
              <span className="dax-file-tail">{fmtNum(file.sessions)} sess</span>
              <span className="dax-file-tail">{fmtDateTime(file.lastTouched)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DeepAnalyticsWidget({ config, widgetId, onSelectSession }: WidgetProps<DeepAnalyticsConfig>) {
  const { activeCwd, activeUserProfile } = useProfiles();
  const now = Date.now();
  const [startInput, setStartInput] = useState(toLocalInputValue(now - 48 * 60 * 60_000));
  const [endInput, setEndInput] = useState(toLocalInputValue(now));
  const [bucketMs, setBucketMs] = useWidgetUiState<number>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "bucket-ms",
    config.bucketMs ?? 60 * 60_000,
  );
  const [tab, setTab] = useWidgetUiState<Tab>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "tab",
    "overview",
  );
  const [breakdownKey, setBreakdownKey] = useWidgetUiState<BreakdownKey>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "breakdown",
    "provider",
  );
  const [profileScope, setProfileScope] = useWidgetUiState<ScopeMode>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "profile-scope",
    "current",
  );
  const [cwdScope, setCwdScope] = useWidgetUiState<ScopeMode>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "cwd-scope",
    "all",
  );
  const [providerFilter, setProviderFilter] = useWidgetUiState<string>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "provider-filter",
    "all",
  );
  const [providerCatalog, setProviderCatalog] = useState<string[]>([]);

  const start = useMemo(() => fromLocalInputValue(startInput), [startInput]);
  const end = useMemo(() => fromLocalInputValue(endInput), [endInput]);
  const scopedUserProfile = profileScope === "current" ? activeUserProfile ?? undefined : undefined;
  const scopedCwd = cwdScope === "current" ? activeCwd ?? undefined : undefined;
  const scopedProvider = providerFilter === "all" ? undefined : providerFilter;

  const loadAnalytics = useCallback(() => modus.getDeepAnalytics({
    start: Math.min(start, end),
    end: Math.max(start, end),
    bucketMs,
    userProfile: scopedUserProfile,
    cwd: scopedCwd,
    provider: scopedProvider,
  }), [bucketMs, end, scopedCwd, scopedProvider, scopedUserProfile, start]);

  const { value: analytics, loading } = useWidgetPollingValue<DeepAnalytics | null>({
    load: loadAnalytics,
    scopeKey: `${start}:${end}:${bucketMs}:${scopedUserProfile ?? ""}:${scopedCwd ?? ""}:${scopedProvider ?? ""}`,
    intervalMs: 30_000,
    initialValue: null,
  });

  useEffect(() => {
    if (!analytics) return;
    setProviderCatalog((current) => {
      const merged = new Set(current);
      for (const row of analytics.byProvider) merged.add(row.key);
      return [...merged];
    });
  }, [analytics]);

  if (loading || !analytics) return <WidgetEmptyState>loading analytics...</WidgetEmptyState>;

  const providerOptions = [{ value: "all", label: "all providers" }].concat(
    providerCatalog.map((provider) => ({ value: provider, label: provider })),
  );

  const breakdownRows = breakdownKey === "provider"
    ? analytics.byProvider
    : breakdownKey === "model"
      ? analytics.byModel
      : breakdownKey === "profile"
        ? analytics.byProfile
        : analytics.byProject;

  return (
    <div className="dax-widget">
      <div className="dax-toolbar">
        <div className="dax-time-row">
          <DateTimeField label="start" value={startInput} onChange={setStartInput} />
          <DateTimeField label="end" value={endInput} onChange={setEndInput} />
          <label className="dax-input dax-input--short">
            <span>bucket</span>
            <CustomSelect
              options={BUCKET_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
              value={String(bucketMs)}
              onChange={(value) => setBucketMs(Number(value))}
            />
          </label>
          <label className="dax-input dax-input--short">
            <span>provider</span>
            <CustomSelect
              options={providerOptions}
              value={providerFilter}
              onChange={setProviderFilter}
            />
          </label>
        </div>

        <div className="dax-meta-row">
          <div className="dax-scope-selects">
            <label className="dax-input dax-input--short">
              <span>profile scope</span>
              <CustomSelect
                options={[
                  { value: "current", label: activeUserProfile ?? "current profile" },
                  { value: "all", label: "all profiles" },
                ]}
                value={profileScope}
                onChange={(value) => setProfileScope(value as ScopeMode)}
              />
            </label>
            <label className="dax-input dax-input--short">
              <span>cwd scope</span>
              <CustomSelect
                options={[
                  { value: "all", label: "all projects" },
                  { value: "current", label: basename(activeCwd) || "current project" },
                ]}
                value={cwdScope}
                onChange={(value) => setCwdScope(value as ScopeMode)}
              />
            </label>
          </div>
          <div className="dax-range-label">{compactRange(analytics.range.start, analytics.range.end)} · {analytics.range.bucketCount} buckets</div>
        </div>

        <InlineTabs options={TAB_OPTIONS} value={tab} onChange={setTab} />
      </div>

      <KpiStrip analytics={analytics} />

      {tab === "overview" && (
        <div className="dax-overview">
          <div className="dax-overview-main">
            <StackedTimeline
              title="token volume"
              buckets={analytics.buckets}
              segments={TOKEN_SEGMENTS}
              footer={`input ${fmtNum(analytics.totals.inputTokens)} · output ${fmtNum(analytics.totals.outputTokens)} · total ${fmtNum(analytics.totals.totalTokens)}`}
              formatter={fmtNum}
            />
            <StackedTimeline
              title="activity"
              buckets={analytics.buckets}
              segments={ACTIVITY_SEGMENTS}
              footer={`user ${fmtNum(analytics.totals.userMessages)} · assistant ${fmtNum(analytics.totals.assistantTurns)} · tools ${fmtNum(analytics.totals.toolCalls)} · trace ${fmtNum(analytics.trace.summary.total)}`}
              formatter={fmtNum}
            />
          </div>
          <OverviewSidebar analytics={analytics} />
        </div>
      )}

      {tab === "breakdown" && (
        <div className="dax-panel">
          <div className="dax-panel-head">
            <div className="dax-panel-title">breakdown</div>
            <InlineTabs options={BREAKDOWN_OPTIONS} value={breakdownKey} onChange={setBreakdownKey} size="sm" />
          </div>
          <BreakdownTable rows={breakdownRows} kind={breakdownKey} />
        </div>
      )}

      {tab === "sessions" && <SessionsView rows={analytics.sessions} onSelectSession={onSelectSession} />}
      {tab === "trace" && <TraceView analytics={analytics} />}
    </div>
  );
}

const def: WidgetDef = { type: "deep-analytics", component: DeepAnalyticsWidget };
export default def;
