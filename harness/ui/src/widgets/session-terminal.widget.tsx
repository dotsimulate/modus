import { useEffect } from "react";
import type { WidgetProps } from "./types";
import { TerminalView } from "../components/TerminalView";
import { useProfiles } from "../providers/ProfileContext";
import { useOptionalRightPanelContext } from "../components/RightPanelContext";
import { subscribeSession, isSubscribed } from "../sessionStore";

export default function SessionTerminalWidget({ pageContext }: WidgetProps) {
  const { activeCwd } = useProfiles();
  const panel = useOptionalRightPanelContext();

  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const sessionId = panel?.sessionId ?? contextSessionId ?? null;

  useEffect(() => {
    if (sessionId && !panel && !isSubscribed(sessionId)) {
      subscribeSession(sessionId, 0);
    }
  }, [sessionId, panel]);

  return <TerminalView cwd={activeCwd} visible={true} sessionId={sessionId} />;
}
