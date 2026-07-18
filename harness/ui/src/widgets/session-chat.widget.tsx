/**
 * Session Chat widget — conversation view for a single session.
 *
 * Config: { "type": "session-chat", "id": "chat-1", "sessionId": "optional-id" }
 *
 * Shows the message thread for a given session. If no sessionId in config,
 * shows an empty state. Uses sessionStore for live SSE streaming.
 * Includes the PermissionOverlay for tool permission prompts.
 */

import { useEffect, useCallback } from "react";
import { useSessionState, useSessionHistoryLoadState, ensureSubscribed, loadOlderSessionHistory, loadSessionMessageDetails } from "../sessionStore";
import { modus } from "../modusClient";
import { ChatView } from "../components/ChatView";
import { PermissionOverlay } from "../components/PermissionOverlay";
import { useSession } from "../providers/SessionContext";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";
import { useProfiles } from "../providers/ProfileContext";
import { resolveInterfaceSettings } from "../interface-settings";

type SessionChatConfig = WidgetBase & {
  type: "session-chat";
  sessionId?: string;
};

export default function SessionChatWidget({ config, pageContext }: WidgetProps<SessionChatConfig>) {
  const { branchFromSessionMessage } = useSession();
  const { activeUP, profiles } = useProfiles();
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const selectedSession = pageContext?.get("selectedSession") as string | undefined;
  const sessionId = contextSessionId ?? selectedSession ?? config.sessionId ?? null;

  // Snapshot-then-subscribe (handles dedup + race-safe hydration internally)
  useEffect(() => {
    if (sessionId) void ensureSubscribed(sessionId);
  }, [sessionId]);

  const session = useSessionState(sessionId);
  const historyLoad = useSessionHistoryLoadState(sessionId);
  const retryHistory = useCallback(() => {
    if (sessionId) void ensureSubscribed(sessionId, { forceHistoryRefresh: true });
  }, [sessionId]);
  const loadOlderHistory = useCallback(() => {
    return sessionId ? loadOlderSessionHistory(sessionId) : Promise.resolve();
  }, [sessionId]);
  const loadMessageDetails = useCallback((seq: number) => {
    return sessionId ? loadSessionMessageDetails(sessionId, seq) : Promise.resolve();
  }, [sessionId]);

  // Permission responses MUST use this widget's own sessionId, not the
  // context's activeSessionId. Failing to do so sends the response to the
  // wrong session and leaves AskUserQuestion pending forever.
  const handlePermission = useCallback(async (
    requestId: string,
    behavior: "allow" | "deny",
    updatedInput?: Record<string, unknown>,
    scope?: "once" | "session",
  ) => {
    if (!sessionId) return;
    await modus.respondToPermission(sessionId, { requestId, behavior, updatedInput, scope }).catch(() => {});
  }, [sessionId]);

  const handleBranch = useCallback(async (seq: number, prefill?: string, restoreCode?: boolean, providerMessageId?: string) => {
    if (!sessionId) return;
    await branchFromSessionMessage(sessionId, seq, prefill, restoreCode, providerMessageId);
  }, [branchFromSessionMessage, sessionId]);

  if (!sessionId) {
    return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  }

  if (!session) {
    return <WidgetEmptyState>loading session...</WidgetEmptyState>;
  }

  const isActive = session.status === "running" || session.status === "starting" || session.status === "interrupting";
  const permissions = session.pendingPermissions ?? [];
  const profileUi = profiles.find((profile) => profile.name === session.profile)?.ui;
  const interfaceSettings = resolveInterfaceSettings(activeUP?.interface);
  const conversation = interfaceSettings.conversation;

  return (
    <div className="session-chat-widget" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", position: "relative" }}>
      <ChatView
        messages={session.messages ?? []}
        sessionId={sessionId}
        provider={session.provider ?? session.agentConfig?.provider}
        streaming={isActive}
        streamFeed={session.streamFeed}
        showThinking={profileUi?.showThinking ?? conversation.showThinking}
        showMeta={profileUi?.showMeta ?? conversation.showMeta}
        toolCallDisplay={profileUi?.showToolCalls === false ? "hidden" : conversation.toolCalls}
        showGitEvents={profileUi?.showGitEvents ?? conversation.showGitEvents}
        showFileChanges={conversation.showFileChanges}
        emptyTitle={historyLoad.status === "loading" ? "loading messages…" : historyLoad.status === "error" ? "messages unavailable" : "no messages"}
        emptySubtitle={historyLoad.status === "loading" ? "fetching this conversation" : historyLoad.status === "error" ? (historyLoad.error ?? "could not load this conversation") : "session has no messages yet"}
        emptyActionLabel={historyLoad.status === "error" ? "retry" : undefined}
        onEmptyAction={historyLoad.status === "error" ? retryHistory : undefined}
        hasOlderMessages={historyLoad.hasMore}
        loadingOlderMessages={historyLoad.loadingOlder}
        olderMessagesError={historyLoad.olderError}
        onLoadOlderMessages={loadOlderHistory}
        onLoadMessageDetails={loadMessageDetails}
        onBranch={handleBranch}
      />
      {permissions.length > 0 && (
        <PermissionOverlay
          permissions={permissions}
          sessionId={sessionId}
          onRespond={handlePermission}
        />
      )}
    </div>
  );
}
