export type ClientTimingPayload = {
  renderer: "tauri";
  metric: "applyEventBatch" | "clientExtensions" | "ensureSubscribed" | "projectUiTheme";
  durationMs: number;
  outcome?: "blocked" | "cancelled" | "loaded";
  stale?: boolean;
  count?: number;
  session?: string;
  source?: "profile-project" | "session-settled";
};

const METRICS = new Set<ClientTimingPayload["metric"]>([
  "applyEventBatch",
  "clientExtensions",
  "ensureSubscribed",
  "projectUiTheme",
]);
const OUTCOMES = new Set<NonNullable<ClientTimingPayload["outcome"]>>([
  "blocked",
  "cancelled",
  "loaded",
]);

export function parseClientTimingPayload(value: unknown): ClientTimingPayload | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.renderer !== "tauri" || typeof body.metric !== "string" || !METRICS.has(body.metric as ClientTimingPayload["metric"])) return null;
  if (typeof body.durationMs !== "number" || !Number.isFinite(body.durationMs) || body.durationMs < 0 || body.durationMs > 600_000) return null;
  if (body.outcome !== undefined && (typeof body.outcome !== "string" || !OUTCOMES.has(body.outcome as NonNullable<ClientTimingPayload["outcome"]>))) return null;
  if (body.stale !== undefined && typeof body.stale !== "boolean") return null;
  if (body.count !== undefined && (typeof body.count !== "number" || !Number.isInteger(body.count) || body.count < 0 || body.count > 1_000_000)) return null;
  if (body.session !== undefined && (typeof body.session !== "string" || !/^[a-f0-9]{1,16}$/i.test(body.session))) return null;
  if (body.source !== undefined && body.source !== "profile-project" && body.source !== "session-settled") return null;
  return body as ClientTimingPayload;
}

export function formatClientTimingLog(payload: ClientTimingPayload): string {
  const fields = [
    `[CLIENT-TIMING] renderer=${payload.renderer}`,
    `metric=${payload.metric}`,
    `duration=${payload.durationMs.toFixed(1)}ms`,
  ];
  if (payload.outcome !== undefined) fields.push(`outcome=${payload.outcome}`);
  if (payload.stale !== undefined) fields.push(`stale=${payload.stale}`);
  if (payload.count !== undefined) fields.push(`count=${payload.count}`);
  if (payload.session !== undefined) fields.push(`session=${payload.session}`);
  if (payload.source !== undefined) fields.push(`source=${payload.source}`);
  return fields.join(" ");
}
