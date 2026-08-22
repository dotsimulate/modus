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
import { useActiveSessionId, useSessionActions, useSessionIndex } from "../providers/SessionContext";
import { useProfiles } from "../providers/ProfileContext";
import { SessionList } from "../components/sidebar/SessionList";
import type { WidgetBase, WidgetProps } from "./types";
import { useWidgetUiState } from "./ui-state";

type SessionListConfig = WidgetBase & {
  type: "session-list";
  groupMode?: "time" | "agent";
  focusTabOnSelect?: string;
};

export default function SessionListWidget({ config, widgetId, onSelectSession, pageContext }: WidgetProps<SessionListConfig>) {
  const { activeUserProfile, uiState, saveUiState } = useProfiles();
  const activeSessionId = useActiveSessionId();
  const { serverSessions } = useSessionIndex();
  const { archiveSession, refreshSessions, newSession } = useSessionActions();

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
      if (pageContext) {
        pageContext.emit({ type: "select-session", sessionId: id });
        if (config.focusTabOnSelect) {
          pageContext.emit({ type: "focus-tab", tabId: config.focusTabOnSelect });
        }
      } else {
        onSelectSession(id);
      }
    }
  }, [config.focusTabOnSelect, newSession, onSelectSession, pageContext]);

  const handleSelectSession = useCallback((id: string) => {
    if (pageContext) {
      pageContext.emit({ type: "select-session", sessionId: id });
      if (config.focusTabOnSelect) {
        pageContext.emit({ type: "focus-tab", tabId: config.focusTabOnSelect });
      }
    } else {
      onSelectSession(id);
    }
  }, [config.focusTabOnSelect, onSelectSession, pageContext]);

  const handleCollapsedGroupsChange = useCallback((groups: string[]) => {
    saveUiState({ sidebarCollapsedGroups: groups });
  }, [saveUiState]);

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
      <div className="session-list-widget-scroll">
        <SessionList
          sessions={serverSessions}
          activeSessionId={(pageContext?.get("sessionId") as string | undefined) ?? activeSessionId}
          groupMode={groupMode}
          onSelectSession={handleSelectSession}
          onArchiveSession={archiveSession}
          initialCollapsedGroups={uiState.sidebarCollapsedGroups}
          onCollapsedGroupsChange={handleCollapsedGroupsChange}
          onTogglePin={handleTogglePin}
        />
      </div>
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
