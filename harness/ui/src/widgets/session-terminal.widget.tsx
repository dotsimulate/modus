import { useEffect } from "react";
import type { WidgetProps } from "./types";
import { TerminalView } from "../components/TerminalView";
import { useProfiles } from "../providers/ProfileContext";
import { useOptionalRightPanelContext } from "../components/RightPanelContext";
import { ensureSubscribed } from "../sessionStore";

export default function SessionTerminalWidget({ pageContext }: WidgetProps) {
  const { activeCwd } = useProfiles();
  const panel = useOptionalRightPanelContext();

  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const sessionId = panel?.sessionId ?? contextSessionId ?? null;

  useEffect(() => {
    if (sessionId && !panel) void ensureSubscribed(sessionId);
  }, [sessionId, panel]);

  return <TerminalView cwd={activeCwd} visible={true} sessionId={sessionId} />;
}
