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
import type { WidgetBase, WidgetProps } from "./types";

type ProfilesManagerConfig = WidgetBase & {
  type: "profiles-manager";
};

export default function ProfilesManagerWidget({ onNavigate, onSelectSession, pageContext }: WidgetProps<ProfilesManagerConfig>) {
  const handleNewSession = useCallback((id: string) => {
    if (pageContext) {
      pageContext.set("selectedSession", id);
    } else {
      onSelectSession(id);
    }
  }, [pageContext, onSelectSession]);

  const handleSelectSession = useCallback((id: string) => {
    if (pageContext) {
      pageContext.set("selectedSession", id);
    } else {
      onSelectSession(id);
    }
  }, [pageContext, onSelectSession]);

  return (
    <div className="profiles-manager-widget" style={{ height: "100%", overflow: "auto" }}>
      <Profiles
        onSelectSession={handleSelectSession}
        onNavigate={onNavigate}
        onNewSession={pageContext ? handleNewSession : undefined}
      />
    </div>
  );
}
