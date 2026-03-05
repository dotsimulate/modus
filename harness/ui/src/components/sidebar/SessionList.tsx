import { useState, useCallback } from "react";
import type { SessionInfo } from "../../api";
import { SessionItem } from "./SessionItem";

type GroupMode = "time" | "project";

type Props = {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  groupMode: GroupMode;
  onSelectSession: (id: string) => void;
  onArchiveSession: (id: string) => void;
  projectPaths?: string[];
  initialCollapsedGroups?: string[];
  onCollapsedGroupsChange?: (groups: string[]) => void;
};

/** Match a session CWD to a known project path, or fall back to last segment */
function projectLabel(cwd: string | null, projectPaths?: string[]): string {
  if (!cwd) return "other";
  // Normalize to forward slashes, strip trailing
  const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (projectPaths) {
    for (const pp of projectPaths) {
      const np = pp.replace(/\\/g, "/").replace(/\/+$/, "");
      if (norm === np || norm.startsWith(np + "/")) {
        return np.split("/").pop() ?? np;
      }
    }
  }
  const parts = norm.split("/").filter(Boolean);
  return parts.pop() ?? "other";
}

function groupSessionsByProject(list: SessionInfo[], projectPaths?: string[]) {
  const map = new Map<string, SessionInfo[]>();
  for (const s of list) {
    const label = projectLabel(s.cwd, projectPaths);
    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(s);
  }
  return Array.from(map.entries())
    .map(([label, items]) => ({ label, items }))
    .sort((a, b) => {
      const aMax = Math.max(...a.items.map((s) => s.updated_at));
      const bMax = Math.max(...b.items.map((s) => s.updated_at));
      return bMax - aMax;
    });
}

function groupSessionsByTime(list: SessionInfo[]) {
  const now = Date.now();
  const today: SessionInfo[] = [];
  const yesterday: SessionInfo[] = [];
  const thisWeek: SessionInfo[] = [];
  const older: SessionInfo[] = [];

  for (const s of list) {
    const age = now - s.updated_at;
    if (age < 86_400_000) today.push(s);
    else if (age < 172_800_000) yesterday.push(s);
    else if (age < 604_800_000) thisWeek.push(s);
    else older.push(s);
  }

  return [
    { label: "today", items: today },
    { label: "yesterday", items: yesterday },
    { label: "this week", items: thisWeek },
    { label: "older", items: older },
  ].filter((g) => g.items.length > 0);
}

export function SessionList({
  sessions, activeSessionId, groupMode,
  onSelectSession, onArchiveSession,
  projectPaths, initialCollapsedGroups, onCollapsedGroupsChange,
}: Props) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(initialCollapsedGroups ?? []),
  );

  const handleToggleGroup = useCallback((label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      onCollapsedGroupsChange?.(Array.from(next));
      return next;
    });
  }, [onCollapsedGroupsChange]);

  const groups = groupMode === "project"
    ? groupSessionsByProject(sessions, projectPaths)
    : groupSessionsByTime(sessions);

  return (
    <>
      {groups.map((group) => {
        const isGroupCollapsed = collapsedGroups.has(group.label);
        return (
          <div key={group.label}>
            <div
              className="sidebar-section-label sidebar-section-label--clickable"
              onClick={() => handleToggleGroup(group.label)}
            >
              <span className={`section-chevron ${isGroupCollapsed ? "" : "section-chevron--open"}`}>
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                  <path d="M2 3l2 2.5L6 3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
              <span>{group.label}</span>
              <span className="section-count">{group.items.length}</span>
            </div>
            <div className={`section-collapse ${isGroupCollapsed ? "" : "section-collapse--open"}`}>
              <div className="section-collapse-clip">
                {group.items.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    active={s.id === activeSessionId}
                    onSelect={onSelectSession}
                    onArchive={onArchiveSession}
                  />
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
