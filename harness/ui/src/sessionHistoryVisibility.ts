import { sessionActivityAt, type SessionActivityFields } from "./sessionActivity";

export type ProjectWindow = "12h" | "24h" | "7d" | "all";

export type ProjectSessionLike = SessionActivityFields & {
  id: string;
  status: string;
};

const WINDOW_MS: Record<Exclude<ProjectWindow, "all">, number> = {
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export function isActiveProjectSessionStatus(status: string): boolean {
  return status === "running" || status === "starting" || status === "interrupting" || status === "paused";
}

export function selectVisibleProjectSessions<T extends ProjectSessionLike>(
  sessions: T[],
  options: {
    window: ProjectWindow;
    now?: number;
    selectedId?: string | null;
    searching?: boolean;
    recentLimit?: number;
    revealCount?: number;
  },
): T[] {
  if (options.searching || options.window === "all") return sessions;

  const cutoff = (options.now ?? Date.now()) - WINDOW_MS[options.window];
  const recentLimit = Math.max(0, options.recentLimit ?? 8);
  const visibleIds = new Set<string>();
  let recentInactive = 0;

  for (const session of sessions) {
    if (isActiveProjectSessionStatus(session.status) || session.id === options.selectedId) {
      visibleIds.add(session.id);
      continue;
    }
    if (sessionActivityAt(session) >= cutoff && recentInactive < recentLimit) {
      visibleIds.add(session.id);
      recentInactive++;
    }
  }

  const targetCount = Math.min(
    sessions.length,
    visibleIds.size + Math.max(0, options.revealCount ?? 0),
  );
  for (const session of sessions) {
    if (visibleIds.size >= targetCount) break;
    visibleIds.add(session.id);
  }

  return sessions.filter((session) => visibleIds.has(session.id));
}
