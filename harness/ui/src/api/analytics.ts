import { API_BASE, authHeaders } from "./_fetch";

export type UsageBucket = {
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

export type ProviderUsageTotal = UsageBucket & {
  provider: string;
};

export type ModelUsageTotal = UsageBucket & {
  provider: string;
  model: string;
};

export type ProviderUsageDaily = UsageBucket & {
  day: string;
  provider: string;
};

export type ProviderUsageAnalytics = {
  windowDays: number;
  totals: UsageBucket;
  providers: ProviderUsageTotal[];
  models: ModelUsageTotal[];
  daily: ProviderUsageDaily[];
};

export type DeepAnalyticsMetricRow = {
  key: string;
  sessions: number;
  userMessages: number;
  assistantMessages: number;
  assistantTurns: number;
  toolCalls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

export type DeepAnalyticsBucket = {
  start: number;
  end: number;
  sessionsStarted: number;
  userMessages: number;
  assistantMessages: number;
  assistantTurns: number;
  toolCalls: number;
  totalDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  touches: number;
};

export type DeepAnalyticsHourRow = {
  hour: number;
  userMessages: number;
  assistantTurns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

export type DeepAnalyticsSessionRow = {
  id: string;
  preview: string;
  profile: string | null;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  createdAt: number;
  lastMessageAt: number;
  totalMessages: number;
  totalCost: number;
  userMessages: number;
  assistantMessages: number;
  assistantTurns: number;
  toolCalls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  touches: number;
};

export type DeepAnalytics = {
  range: {
    start: number;
    end: number;
    bucketMs: number;
    bucketCount: number;
  };
  totals: {
    sessionsStarted: number;
    sessionsActive: number;
    userMessages: number;
    assistantMessages: number;
    assistantTurns: number;
    toolCalls: number;
    totalDurationMs: number;
    avgDurationMs: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
  };
  buckets: DeepAnalyticsBucket[];
  byProvider: DeepAnalyticsMetricRow[];
  byModel: DeepAnalyticsMetricRow[];
  byProfile: DeepAnalyticsMetricRow[];
  byProject: DeepAnalyticsMetricRow[];
  byHour: DeepAnalyticsHourRow[];
  sessions: DeepAnalyticsSessionRow[];
  trace: {
    summary: {
      total: number;
      byOp: Record<string, number>;
      byConfidence: Record<string, number>;
      byProvider: Record<string, number>;
      byFileKind: Record<string, number>;
      uniqueFiles: number;
      uniqueSessions: number;
    };
    topFiles: Array<{
      filePath: string;
      fileKind: "code" | "docs";
      touches: number;
      sessions: number;
      lastTouched: number;
      provider: string | null;
    }>;
  };
};

export async function fetchProviderUsageAnalytics(
  userProfile?: string,
  days = 30,
): Promise<ProviderUsageAnalytics> {
  const params = new URLSearchParams();
  if (userProfile) params.set("userProfile", userProfile);
  params.set("days", String(days));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`${API_BASE}/api/analytics/provider-usage${suffix}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchDeepAnalytics(opts: {
  start: number;
  end: number;
  bucketMs?: number;
  userProfile?: string;
  cwd?: string;
  provider?: string;
}): Promise<DeepAnalytics> {
  const params = new URLSearchParams();
  params.set("start", String(opts.start));
  params.set("end", String(opts.end));
  if (opts.bucketMs != null) params.set("bucketMs", String(opts.bucketMs));
  if (opts.userProfile) params.set("userProfile", opts.userProfile);
  if (opts.cwd) params.set("cwd", opts.cwd);
  if (opts.provider) params.set("provider", opts.provider);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`${API_BASE}/api/analytics/deep${suffix}`, { headers: authHeaders() });
  return res.json();
}
