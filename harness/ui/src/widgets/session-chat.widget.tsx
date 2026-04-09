/**
 * Session Chat widget — conversation view for a single session.
 *
 * Config: { "type": "session-chat", "id": "chat-1", "sessionId": "optional-id" }
 *
 * Shows the message thread for a given session. If no sessionId in config,
 * shows an empty state. Uses sessionStore for live SSE streaming.
 */

import { useEffect } from "react";
import { useSessionState, subscribeSession, isSubscribed } from "../sessionStore";
import { ChatView } from "../components/ChatView";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

type SessionChatConfig = WidgetBase & {
  type: "session-chat";
  sessionId?: string;
};

export default function SessionChatWidget({ config, pageContext }: WidgetProps<SessionChatConfig>) {
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const sessionId = contextSessionId ?? config.sessionId ?? null;

  // Subscribe to SSE events for this session
  useEffect(() => {
    if (sessionId && !isSubscribed(sessionId)) {
      subscribeSession(sessionId, 0);
    }
  }, [sessionId]);

  const session = useSessionState(sessionId);

  if (!sessionId) {
    return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  }

  if (!session) {
    return <WidgetEmptyState>loading session...</WidgetEmptyState>;
  }

  const isActive = session.status === "running" || session.status === "starting";

  return (
    <div className="session-chat-widget" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden" }}>
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
    </div>
  );
}
