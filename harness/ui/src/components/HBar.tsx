/**
 * Tiny horizontal progress bar. Pass `prefix` to control CSS class
 * (e.g. "stats" → .stats-hbar, "cpw" → .cpw-hbar).
 */
export function HBar({
  value,
  max,
  prefix = "stats",
  color,
}: {
  value: number;
  max: number;
  prefix?: string;
  color?: string;
}) {
  const pct = max > 0 ? Math.max(1, (value / max) * 100) : 0;
  return (
    <div className={`${prefix}-hbar`}>
      <div
        className={`${prefix}-hbar-fill`}
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}
