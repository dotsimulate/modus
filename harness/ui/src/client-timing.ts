import { isTauriRuntime } from "./desktopBridge";
import { API_BASE, authHeaders } from "./modusClient";

export type ClientTimingMetric = "applyEventBatch" | "clientExtensions" | "ensureSubscribed" | "projectUiTheme";
export type ClientTimingFields = {
  outcome?: "blocked" | "cancelled" | "loaded";
  stale?: boolean;
  count?: number;
  session?: string;
  source?: "profile-project" | "session-settled";
  cwd?: string;
};

export function formatClientTimingLine(metric: ClientTimingMetric, durationMs: number, fields: ClientTimingFields = {}): string {
  const prefix = fields.outcome ? `${metric} ${fields.outcome}` : metric;
  const extras: string[] = [];
  if (fields.count !== undefined) extras.push(`${fields.count} events`);
  if (fields.session) extras.push(`session=${fields.session}`);
  if (fields.stale !== undefined) extras.push(`stale=${fields.stale}`);
  if (fields.source !== undefined) extras.push(`source=${fields.source}`);
  if (fields.cwd !== undefined) extras.push(`cwd=${fields.cwd}`);
  return `[CLIENT-TIMING] ${prefix} ${durationMs.toFixed(1)}ms${extras.length ? ` ${extras.join(" ")}` : ""}`;
}

export function reportClientTiming(metric: ClientTimingMetric, durationMs: number, fields: ClientTimingFields = {}): void {
  console.log(formatClientTimingLine(metric, durationMs, fields));
  if (!isTauriRuntime()) return;
  const { cwd: _cwd, ...safeFields } = fields;
  void fetch(`${API_BASE}/api/client-timing`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ renderer: "tauri", metric, durationMs, ...safeFields }),
    keepalive: true,
  }).catch(() => {});
}
