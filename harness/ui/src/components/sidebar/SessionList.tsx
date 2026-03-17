import { useState, useCallback, useRef, useEffect } from "react";
import type { SessionInfo } from "../../api";
import { archiveSessionApi } from "../../api";
import { SessionItem } from "./SessionItem";

type GroupMode = "time" | "agent";

type Props = {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  groupMode: GroupMode;
  onSelectSession: (id: string) => void;
  onArchiveSession: (id: string) => void;
  activeInput?: string;
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
  onSelectSession, onArchiveSession, activeInput,
  projectPaths: _projectPaths, initialCollapsedGroups, onCollapsedGroupsChange,
  onTogglePin,
}: Props) {
  void _projectPaths;
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(initialCollapsedGroups ?? []),
  );

  // Cache draft input per session so it's visible after navigating away
  const draftCache = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (activeSessionId && activeInput !== undefined) {
      if (activeInput.trim()) {
        draftCache.current.set(activeSessionId, activeInput);
      } else {
        draftCache.current.delete(activeSessionId);
      }
    }
  }, [activeSessionId, activeInput]);

  const handleSelectSession = useCallback((id: string) => {
    if (activeSessionId && id !== activeSessionId) {
      const current = sessions.find((s) => s.id === activeSessionId);
      if (
        current &&
        current.message_count === 0 &&
        !current.title && !current.last_prompt && !current.preview &&
        !(activeInput?.trim()) &&
        (current.status === "idle" || current.status === "done")
      ) {
        archiveSessionApi(activeSessionId).catch(() => {});
        onSelectSession(id);
        return;
      }
    }
    onSelectSession(id);
  }, [activeSessionId, sessions, onSelectSession, onArchiveSession]);

  const handleToggleGroup = useCallback((label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      onCollapsedGroupsChange?.(Array.from(next));
      return next;
    });
  }, [onCollapsedGroupsChange]);

  const pinnedSessions = sessions.filter(s => parseTagList(s.tags).includes("pinned"));
  const unpinnedSessions = sessions.filter(s => !parseTagList(s.tags).includes("pinned"));

  const groups = groupMode === "agent"
    ? groupSessionsByAgent(unpinnedSessions)
    : groupSessionsByTime(unpinnedSessions);

  return (
    <>
      {pinnedSessions.length > 0 && (
        <div>
          <div className="sidebar-section-label">
            <span>pinned</span>
            <span className="section-count">{pinnedSessions.length}</span>
          </div>
          {pinnedSessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              onSelect={handleSelectSession}
              onArchive={onArchiveSession}
              draftInput={s.id === activeSessionId ? activeInput : draftCache.current.get(s.id)}
              tags={parseTagList(s.tags)}
              onTogglePin={onTogglePin ? () => onTogglePin(s.id) : undefined}
            />
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
                {group.items.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    active={s.id === activeSessionId}
                    onSelect={handleSelectSession}
                    onArchive={onArchiveSession}
                    draftInput={s.id === activeSessionId ? activeInput : draftCache.current.get(s.id)}
                    tags={parseTagList(s.tags)}
                    onTogglePin={onTogglePin ? () => onTogglePin(s.id) : undefined}
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
