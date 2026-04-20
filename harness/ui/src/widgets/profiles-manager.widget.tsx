/**
 * Profiles Manager widget — agent profiles view as a page-embeddable widget.
 *
 * Config: { "type": "profiles-manager", "id": "pm-1" }
 *
 * Wraps the existing Profiles component. Uses ProfileContext and SessionContext
 * internally — no additional wiring needed beyond the standard WidgetProps.
 */

import { useCallback } from "react";
import { Profiles } from "../components/Profiles";
import { useUiIntent } from "./intents";
import type { WidgetBase, WidgetProps } from "./types";

type ProfilesManagerConfig = WidgetBase & {
  type: "profiles-manager";
};

export default function ProfilesManagerWidget({ onNavigate, onSelectSession, pageContext }: WidgetProps<ProfilesManagerConfig>) {
  const { dispatch } = useUiIntent(pageContext);

  const handleNewSession = useCallback((id: string) => {
    if (pageContext) {
      pageContext.set("selectedSession", id);
      dispatch({ type: "focus-tab", tabId: "cs-history" });
    }
    const activate = pageContext?.activateSession;
    if (activate) {
      activate(id);
    } else {
      onSelectSession(id);
    }
  }, [pageContext, dispatch, onSelectSession]);

  const handleSelectSession = useCallback((id: string) => {
    pageContext?.set("selectedSession", id);
    onSelectSession(id);
  }, [pageContext, onSelectSession]);

  return (
    <div className="profiles-manager-widget">
      <Profiles
        onSelectSession={handleSelectSession}
        onNavigate={onNavigate}
        onNewSession={handleNewSession}
      />
    </div>
  );
}
