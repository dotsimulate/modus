import { useEffect } from "react";
import { AgentActivityView } from "../components/AgentActivityView";
import { useOptionalRightPanelContext } from "../components/RightPanelContext";
import { useSessionState, ensureSubscribed } from "../sessionStore";
import type { WidgetProps } from "./types";

export default function AgentActivityWidget({ pageContext }: WidgetProps) {
  const panel = useOptionalRightPanelContext();

  // Resolve sessionId: panel context → pageContext → null
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const sessionId = panel?.sessionId ?? contextSessionId ?? null;

  useEffect(() => {
    if (sessionId && !panel) void ensureSubscribed(sessionId);
  }, [sessionId, panel]);

  const session = useSessionState(sessionId);

  // Panel provides messages directly; outside panel, get from session store
  const messages = panel?.messages ?? session?.messages ?? [];

  return <AgentActivityView messages={messages} />;
}
