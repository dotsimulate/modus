import type { MemoryStatus } from "../../sdk/index";

export type MemoryPressureNotice = {
  /** `blocked` while new sessions are refused, `high` while usage is only past the threshold. */
  level: "high" | "blocked";
  title: string;
  detail: string;
};

/**
 * What to tell the user about system memory, or null when there is nothing to
 * say. The point is to name the cause: pressure usually comes from another
 * program, and a bare percentage sends the user looking at Modus.
 */
export function describeMemoryPressure(status: MemoryStatus | null): MemoryPressureNotice | null {
  if (!status?.highPressure) return null;
  const used = `${status.usedGB.toFixed(1)} of ${status.totalGB.toFixed(1)} GB in use (${Math.round(status.usagePercent)}%)`;
  const largest = (status.largestProcesses ?? [])
    .map((group) => `${group.name} ${group.memoryGB.toFixed(1)} GB${group.count > 1 ? ` (${group.count} processes)` : ""}`)
    .join(", ");
  const detail = largest ? `${used}. Largest: ${largest}.` : `${used}.`;
  return status.spawnBlocked
    ? { level: "blocked", title: "Memory nearly full: new sessions are paused", detail }
    : { level: "high", title: "System memory is running high", detail };
}
