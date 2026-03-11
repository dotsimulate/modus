import { useMemo } from "react";
import type { SessionStats } from "../api";

/**
 * 30-day bar chart. Pass `prefix` to control CSS class names
 * (e.g. "stats" → .stats-chart, "cpw" → .cpw-chart).
 */
export function ActivityChart({
  daily,
  prefix = "stats",
  mode,
}: {
  daily: SessionStats["daily"];
  prefix?: string;
  mode?: "sessions" | "cost";
}) {
  const effectiveMode = mode ?? "sessions";

  const filled = useMemo(() => {
    const map = new Map(daily.map((d) => [d.day, d]));
    const days: { day: string; sessions: number; cost: number }[] = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      days.push(map.get(key) ?? { day: key, sessions: 0, cost: 0 });
    }
    return days;
  }, [daily]);

  const maxValue = Math.max(
    0.01,
    ...filled.map((d) => (effectiveMode === "sessions" ? d.sessions : d.cost)),
  );
  const maxHeight = prefix === "cpw" ? 28 : 24;

  return (
    <div className={`${prefix}-chart`}>
      {filled.map((d) => {
        const val = effectiveMode === "sessions" ? d.sessions : d.cost;
        const h = Math.max(1, Math.round((val / maxValue) * maxHeight));
        const barClass =
          mode !== undefined
            ? `${prefix}-chart-bar ${prefix}-chart-bar--${effectiveMode}`
            : `${prefix}-chart-bar`;
        return (
          <div
            key={d.day}
            className={barClass}
            style={{ height: `${h}px` }}
            title={`${d.day}: ${d.sessions} sessions, $${d.cost.toFixed(2)}`}
          />
        );
      })}
    </div>
  );
}
