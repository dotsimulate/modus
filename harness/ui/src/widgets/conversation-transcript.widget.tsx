/** Canonical continuous transcript renderer used by the core Transcript lens. */

import { useCallback, useEffect } from "react";
import type { Message } from "../../../sdk/index";
import { ChatView } from "../components/ChatView";
import { useProfiles } from "../providers/ProfileContext";
import { useSessionActions } from "../providers/SessionContext";
import {
  ensureSubscribed,
  loadOlderSessionHistory,
  loadSessionMessageDetails,
  useSessionHistoryLoadState,
  useSessionState,
} from "../sessionStore";
import { useInterfaceSettings } from "../useInterfaceSettings";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

const EMPTY_MESSAGES: Message[] = [];

type ConversationTranscriptConfig = WidgetBase & {
  type: "conversation-transcript";
  sessionId?: string;
};

export default function ConversationTranscriptWidget({ config, pageContext }: WidgetProps<ConversationTranscriptConfig>) {
  const { activeUP, profiles } = useProfiles();
  const { branchFromSessionMessage } = useSessionActions();
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const selectedSession = pageContext?.get("selectedSession") as string | undefined;
  const sessionId = contextSessionId ?? selectedSession ?? config.sessionId ?? null;
  const turnSessionId = pageContext?.get("turnSessionId");
  const rawTurnNumber = pageContext?.get("turnNumber");
  const focusTurnNumber = (typeof turnSessionId !== "string" || turnSessionId === sessionId)
    && typeof rawTurnNumber === "number"
    ? rawTurnNumber
    : null;

  useEffect(() => {
    if (sessionId) void ensureSubscribed(sessionId);
  }, [sessionId]);

  const session = useSessionState(sessionId);
  const historyLoad = useSessionHistoryLoadState(sessionId);
  const retryHistory = useCallback(() => {
    if (sessionId) void ensureSubscribed(sessionId, { forceHistoryRefresh: true });
  }, [sessionId]);
  const loadOlderHistory = useCallback(
    () => sessionId ? loadOlderSessionHistory(sessionId) : Promise.resolve(),
    [sessionId],
  );
  const loadMessageDetails = useCallback(
    (seq: number) => sessionId ? loadSessionMessageDetails(sessionId, seq) : Promise.resolve(),
    [sessionId],
  );
  const handleBranch = useCallback(async (
    seq: number,
    prefill?: string,
    restoreCode?: boolean,
    providerMessageId?: string,
  ) => {
    if (sessionId) {
      await branchFromSessionMessage(sessionId, seq, prefill, restoreCode, providerMessageId);
    }
  }, [branchFromSessionMessage, sessionId]);

  if (!sessionId) return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  if (!session) return <WidgetEmptyState>loading session…</WidgetEmptyState>;

  const profileUi = profiles.find((profile) => profile.name === session.profile)?.ui;
  const interfaceSettings = useInterfaceSettings(activeUP?.interface);
  const conversation = interfaceSettings.conversation;
  const showThinking = profileUi?.showThinking ?? conversation.showThinking;
  const showMeta = profileUi?.showMeta ?? conversation.showMeta;
  const toolCallDisplay = profileUi?.showToolCalls === false ? "hidden" : conversation.toolCalls;
  const isActive = session.status === "running"
    || session.status === "starting"
    || session.status === "interrupting";

  return (
    <ChatView
      fontScale={interfaceSettings.chat.fontScale / 100}
      focusTurnNumber={focusTurnNumber}
      messages={session.messages ?? EMPTY_MESSAGES}
      sessionId={sessionId}
      provider={session.provider ?? session.agentConfig?.provider}
      streaming={isActive}
      streamFeed={session.streamFeed}
      showThinking={showThinking}
      showMeta={showMeta}
      toolCallDisplay={toolCallDisplay}
      showGitEvents={profileUi?.showGitEvents ?? conversation.showGitEvents}
      cwd={session.cwd ?? null}
      showFileChanges={conversation.showFileChanges}
      emptyTitle={historyLoad.status === "loading"
        ? "loading messages…"
        : historyLoad.status === "error" ? "messages unavailable" : "no messages"}
      emptySubtitle={historyLoad.status === "loading"
        ? "fetching this conversation"
        : historyLoad.status === "error"
          ? (historyLoad.error ?? "could not load this conversation")
          : "session has no messages yet"}
      emptyActionLabel={historyLoad.status === "error" ? "retry" : undefined}
      onEmptyAction={historyLoad.status === "error" ? retryHistory : undefined}
      hasOlderMessages={historyLoad.hasMore}
      loadingOlderMessages={historyLoad.loadingOlder}
      olderMessagesError={historyLoad.olderError}
      olderTurnCount={historyLoad.olderTurnCount}
      onLoadOlderMessages={loadOlderHistory}
      onLoadMessageDetails={loadMessageDetails}
      onBranch={handleBranch}
    />
  );
}
