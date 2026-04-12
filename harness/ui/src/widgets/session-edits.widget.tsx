import { useEffect } from "react";
import { SessionEditsView } from "../components/SessionEditsView";
import { useProfiles } from "../providers/ProfileContext";
import { useOptionalRightPanelContext } from "../components/RightPanelContext";
import { useSessionState, subscribeSession, isSubscribed } from "../sessionStore";
import type { WidgetProps } from "./types";

export default function SessionEditsWidget({ pageContext }: WidgetProps) {
  const { activeCwd } = useProfiles();
  const panel = useOptionalRightPanelContext();

  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const sessionId = panel?.sessionId ?? contextSessionId ?? null;

  useEffect(() => {
    if (sessionId && !panel && !isSubscribed(sessionId)) {
      subscribeSession(sessionId, 0);
    }
  }, [sessionId, panel]);

  const session = useSessionState(sessionId);
  const messages = panel?.messages ?? session?.messages ?? [];

  return <SessionEditsView messages={messages} sessionId={sessionId} cwd={activeCwd} />;
}
