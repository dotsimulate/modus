/**
 * Session list widget — the sidebar session list, as a panel widget.
 *
 * Wraps the existing SessionList component, sourcing data from
 * SessionProvider and ProfileProvider. Can live in any panel on any view.
 *
 * Config: { "type": "session-list", "groupMode": "time" | "agent" }
 */

import { useCallback } from "react";
import { modus } from "../modusClient";
import { useSession } from "../providers/SessionContext";
import { useProfiles } from "../providers/ProfileContext";
import { getSessionState } from "../sessionStore";
import { SessionList } from "../components/sidebar/SessionList";
import type { WidgetBase, WidgetProps } from "./types";
import { useWidgetUiState } from "./ui-state";

type SessionListConfig = WidgetBase & {
  type: "session-list";
  groupMode?: "time" | "agent";
};

export default function SessionListWidget({ config, widgetId, onSelectSession }: WidgetProps<SessionListConfig>) {
  const { activeUserProfile, uiState, saveUiState } = useProfiles();
  const { activeSession, serverSessions, input, archiveSession, refreshSessions, newSession } = useSession();

  const [groupMode, setGroupMode] = useWidgetUiState<"time" | "agent">(
    { userProfile: activeUserProfile },
    widgetId,
    "group-mode",
    config.groupMode ?? uiState.sidebarGroupMode ?? "time",
  );

  const handleGroupModeChange = useCallback((mode: "time" | "agent") => {
    setGroupMode(mode);
    saveUiState({ sidebarGroupMode: mode });
  }, [setGroupMode, saveUiState]);

  // Merge live status from sessionStore
  const sessions = serverSessions.map((s) => {
    const storeState = getSessionState(s.id);
    return storeState ? { ...s, status: storeState.status ?? s.status } : s;
  });

  const handleTogglePin = useCallback(async (id: string) => {
    const session = serverSessions.find(s => s.id === id);
    const tags = parseTagList(session?.tags);
    if (tags.includes("pinned")) {
      await modus.removeTag(id, "pinned").catch(() => {});
    } else {
      await modus.addTag(id, "pinned").catch(() => {});
    }
    refreshSessions();
  }, [serverSessions, refreshSessions]);

  const handleNewSession = useCallback(async () => {
    const id = await newSession();
    if (id) {
      // onSelectSession calls selectSession + setUrlSession which sets view to "chat".
      // Do NOT call onNavigate("chat") — it would go through handleNavigate which
      // restores restorableLastSessionId, switching back to the old session.
      onSelectSession(id);
    }
  }, [newSession, onSelectSession]);

  return (
    <div className="session-list-widget">
      <div className="session-list-widget-modes">
        <button
          className="session-list-widget-new"
          onClick={handleNewSession}
          title="New session"
        >+</button>
        <button
          className={`session-list-widget-mode${groupMode === "time" ? " active" : ""}`}
          onClick={() => handleGroupModeChange("time")}
        >time</button>
        <button
          className={`session-list-widget-mode${groupMode === "agent" ? " active" : ""}`}
          onClick={() => handleGroupModeChange("agent")}
        >agent</button>
      </div>
      <SessionList
        sessions={sessions}
        activeSessionId={activeSession?.id ?? null}
        groupMode={groupMode}
        onSelectSession={onSelectSession}
        onArchiveSession={archiveSession}
        activeInput={input}
        initialCollapsedGroups={uiState.sidebarCollapsedGroups}
        onCollapsedGroupsChange={(groups) => saveUiState({ sidebarCollapsedGroups: groups })}
        onTogglePin={handleTogglePin}
      />
    </div>
  );
}

function parseTagList(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((t): t is string => typeof t === "string") : [];
  } catch { return []; }
}
