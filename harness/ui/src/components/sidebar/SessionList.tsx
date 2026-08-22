import { memo, useState, useCallback, useMemo } from "react";
import type { SessionInfo } from "../../../../sdk/index";
import { modus } from "../../modusClient";
import { getInputValue, getInputValueForSession, useInputValue } from "../../inputStore";
import { sessionActivityAt as activityAt } from "../../sessionActivity";
import { SessionItem } from "./SessionItem";

type GroupMode = "time" | "agent";

type Props = {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  groupMode: GroupMode;
  onSelectSession: (id: string) => void;
  onArchiveSession: (id: string) => void;
  projectPaths?: string[];
  initialCollapsedGroups?: string[];
  onCollapsedGroupsChange?: (groups: string[]) => void;
  onTogglePin?: (id: string) => void;
};

function parseTagList(raw?: string | null): string[] {
  if (!raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p.filter((t): t is string => typeof t === "string") : []; }
  catch { return []; }
}

function groupSessionsByAgent(list: SessionInfo[]) {
  const map = new Map<string, SessionInfo[]>();
  for (const s of list) {
    const label = s.profile ?? "no agent";
    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(s);
  }
  return Array.from(map.entries())
    .map(([label, items]) => ({ label, items }))
    .sort((a, b) => {
      const aMax = Math.max(...a.items.map(activityAt));
      const bMax = Math.max(...b.items.map(activityAt));
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
    const age = now - activityAt(s);
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

export const SessionList = memo(function SessionList({
  sessions, activeSessionId, groupMode,
  onSelectSession, onArchiveSession,
  projectPaths: _projectPaths, initialCollapsedGroups, onCollapsedGroupsChange,
  onTogglePin,
}: Props) {
  void _projectPaths;
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(initialCollapsedGroups ?? []),
  );

  const handleSelectSession = useCallback((id: string) => {
    if (activeSessionId && id !== activeSessionId) {
      const current = sessions.find((s) => s.id === activeSessionId);
      if (
        current &&
        current.message_count === 0 &&
        !current.title && !current.last_prompt && !current.preview &&
        !getInputValue().trim() &&
        (current.status === "idle" || current.status === "done")
      ) {
        modus.archiveSession(activeSessionId).catch(() => {});
        onSelectSession(id);
        return;
      }
    }
    onSelectSession(id);
  }, [activeSessionId, sessions, onSelectSession]);

  const handleToggleGroup = useCallback((label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      onCollapsedGroupsChange?.(Array.from(next));
      return next;
    });
  }, [onCollapsedGroupsChange]);

  const sessionTags = useMemo(
    () => new Map(sessions.map((session) => [session.id, parseTagList(session.tags)])),
    [sessions],
  );
  const { pinnedSessions, groups } = useMemo(() => {
    const pinned: SessionInfo[] = [];
    const unpinned: SessionInfo[] = [];
    for (const session of sessions) {
      (sessionTags.get(session.id)?.includes("pinned") ? pinned : unpinned).push(session);
    }
    return {
      pinnedSessions: pinned,
      groups: groupMode === "agent"
        ? groupSessionsByAgent(unpinned)
        : groupSessionsByTime(unpinned),
    };
  }, [groupMode, sessionTags, sessions]);

  return (
    <>
      {pinnedSessions.length > 0 && (
        <div>
          <div className="sidebar-section-label">
            <span>pinned</span>
            <span className="section-count">{pinnedSessions.length}</span>
          </div>
          {pinnedSessions.map((s) => renderSessionItem(
            s, activeSessionId, handleSelectSession, onArchiveSession, sessionTags.get(s.id) ?? [], onTogglePin,
          ))}
        </div>
      )}
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
                {group.items.map((s) => renderSessionItem(
                  s, activeSessionId, handleSelectSession, onArchiveSession, sessionTags.get(s.id) ?? [], onTogglePin,
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
});

type ActiveSessionItemProps = {
  session: SessionInfo;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
  tags: string[];
  onTogglePin?: () => void;
};

function ActiveSessionItem(props: ActiveSessionItemProps) {
  const draftInput = useInputValue();
  return <SessionItem {...props} active draftInput={draftInput} />;
}

function renderSessionItem(
  session: SessionInfo,
  activeSessionId: string | null,
  onSelect: (id: string) => void,
  onArchive: (id: string) => void,
  tags: string[],
  onTogglePin?: (id: string) => void,
) {
  const common = {
    session,
    onSelect,
    onArchive,
    tags,
    onTogglePin: onTogglePin ? () => onTogglePin(session.id) : undefined,
  };
  return session.id === activeSessionId
    ? <ActiveSessionItem key={session.id} {...common} />
    : <SessionItem
        key={session.id}
        {...common}
        active={false}
        draftInput={getInputValueForSession(session.id)}
      />;
}
