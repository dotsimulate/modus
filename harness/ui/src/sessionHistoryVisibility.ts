import { sessionActivityAt, type SessionActivityFields } from "./sessionActivity";
import { hasUnreadReply } from "./session-read-state";

export type ProjectWindow = "12h" | "24h" | "7d" | "all";

export type ProjectSessionLike = SessionActivityFields & {
  id: string;
  status: string;
  last_reply_seq?: number;
  read_reply_seq?: number;
};

const WINDOW_MS: Record<Exclude<ProjectWindow, "all">, number> = {
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export function isActiveProjectSessionStatus(status: string): boolean {
  return status === "running" || status === "starting" || status === "interrupting" || status === "paused";
}

/**
 * Rows no cap may drop: live work, a reply waiting to be read, and whatever is
 * open right now. Truncation is about settled conversations — hiding one of
 * these would hide the thing the list exists to surface.
 */
function isAlwaysVisible(session: ProjectSessionLike, selectedId?: string | null): boolean {
  return isActiveProjectSessionStatus(session.status)
    || hasUnreadReply(session)
    || session.id === selectedId;
}

/** Grow the kept set toward `revealCount` extra rows, in the list's own order. */
function fillToReveal<T extends ProjectSessionLike>(
  sessions: T[], visibleIds: Set<string>, revealCount: number,
): T[] {
  const targetCount = Math.min(sessions.length, visibleIds.size + Math.max(0, revealCount));
  for (const session of sessions) {
    if (visibleIds.size >= targetCount) break;
    visibleIds.add(session.id);
  }
  return sessions.filter((session) => visibleIds.has(session.id));
}

/**
 * A plain head-of-list cap, for the views whose groups are not project buckets.
 *
 * Timeline, agent, and status groups carry their own meaning — a time window
 * inside a "3 weeks ago" bucket would empty it — so those are capped by count
 * alone and opened further with the same reveal control.
 */
export function selectVisibleGroupSessions<T extends ProjectSessionLike>(
  sessions: T[],
  options: {
    limit: number;
    selectedId?: string | null;
    searching?: boolean;
    revealCount?: number;
  },
): T[] {
  if (options.searching) return sessions;

  const limit = Math.max(0, options.limit);
  const visibleIds = new Set<string>();
  let kept = 0;

  for (const session of sessions) {
    if (isAlwaysVisible(session, options.selectedId)) {
      visibleIds.add(session.id);
      continue;
    }
    if (kept < limit) {
      visibleIds.add(session.id);
      kept++;
    }
  }

  return fillToReveal(sessions, visibleIds, options.revealCount ?? 0);
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
    if (isAlwaysVisible(session, options.selectedId)) {
      visibleIds.add(session.id);
      continue;
    }
    if (sessionActivityAt(session) >= cutoff && recentInactive < recentLimit) {
      visibleIds.add(session.id);
      recentInactive++;
    }
  }

  return fillToReveal(sessions, visibleIds, options.revealCount ?? 0);
}

/**
 * The session.cycle ring for the grouped list: pinned rows, then the visible rows
 * of open groups, in render order. A knob walks what is on screen, so rows behind
 * "show N more" and inside collapsed groups are not in it. With every group
 * collapsed and nothing pinned, the visible rows of all groups stand in, so the
 * knob still moves and landing opens that group.
 */
export function selectCycleSessionIds(
  pinned: readonly { id: string }[],
  groups: readonly { key: string; visibleSessions: readonly { id: string }[] }[],
  expanded: ReadonlySet<string>,
): string[] {
  const open = groups.filter((group) => expanded.has(group.key));
  const rows = [...pinned, ...(open.length || pinned.length ? open : groups).flatMap((group) => group.visibleSessions)];
  return rows.map((row) => row.id).filter((id) => !id.startsWith("pending-"));
}
