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
