/**
 * Session Chat widget — conversation view for a single session.
 *
 * Config: { "type": "session-chat", "id": "chat-1", "sessionId": "optional-id" }
 *
 * Shows the message thread for a given session. If no sessionId in config,
 * shows an empty state. Uses sessionStore for live SSE streaming.
 * Includes the PermissionOverlay for tool permission prompts.
 */

import { useEffect } from "react";
import { useSessionState, ensureSubscribed } from "../sessionStore";
import { useSession } from "../providers/SessionContext";
import { ChatView } from "../components/ChatView";
import { PermissionOverlay } from "../components/PermissionOverlay";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

type SessionChatConfig = WidgetBase & {
  type: "session-chat";
  sessionId?: string;
};

export default function SessionChatWidget({ config, pageContext }: WidgetProps<SessionChatConfig>) {
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const selectedSession = pageContext?.get("selectedSession") as string | undefined;
  const sessionId = contextSessionId ?? selectedSession ?? config.sessionId ?? null;

  // Snapshot-then-subscribe (handles dedup + race-safe hydration internally)
  useEffect(() => {
    if (sessionId) void ensureSubscribed(sessionId);
  }, [sessionId]);

  const session = useSessionState(sessionId);
  const { handlePermissionResponse } = useSession();

  if (!sessionId) {
    return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  }

  if (!session) {
    return <WidgetEmptyState>loading session...</WidgetEmptyState>;
  }

  const isActive = session.status === "running" || session.status === "starting";
  const permissions = session.pendingPermissions ?? [];

  return (
    <div className="session-chat-widget" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", position: "relative" }}>
      <ChatView
        messages={session.messages ?? []}
        sessionId={sessionId}
        streaming={isActive}
        streamFeed={session.streamFeed}
        showThinking={true}
        showMeta={false}
        showToolCalls={true}
        showGitEvents={false}
        emptyTitle="no messages"
        emptySubtitle="session has no messages yet"
      />
      {permissions.length > 0 && (
        <PermissionOverlay
          permissions={permissions}
          sessionId={sessionId}
          onRespond={handlePermissionResponse}
        />
      )}
    </div>
  );
}
