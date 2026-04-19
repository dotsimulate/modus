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
  // Always fire onSelectSession so App.tsx can update the URL hash + activeSession
  // (via handleViewSession). When inside a page scope, also publish into the bus
  // so scope-local widgets with hideWhen/showWhen react immediately.
  const handleNewSession = useCallback((id: string) => {
    pageContext?.set("selectedSession", id);
    onSelectSession(id);
  }, [pageContext, onSelectSession]);

  const handleSelectSession = useCallback((id: string) => {
    pageContext?.set("selectedSession", id);
    onSelectSession(id);
  }, [pageContext, onSelectSession]);

  return (
    <div className="profiles-manager-widget">
      <Profiles
        onSelectSession={handleSelectSession}
        onNavigate={onNavigate}
        onNewSession={pageContext ? handleNewSession : undefined}
      />
    </div>
  );
}
