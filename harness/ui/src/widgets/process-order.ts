import type { ProcessInfo } from "../../../sdk/types";

export type ProcessSort = "activity" | "started";

export function sortProcesses(processes: readonly ProcessInfo[], order: ProcessSort): ProcessInfo[] {
  return [...processes].sort((a, b) => {
    if (order === "activity") {
      const recency = Math.max(b.lastEventAt, b.startedAt) - Math.max(a.lastEventAt, a.startedAt);
      if (recency !== 0) return recency;
    }
    return b.startedAt - a.startedAt || a.id.localeCompare(b.id);
  });
}
