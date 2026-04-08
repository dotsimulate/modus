import type { WidgetDef } from "./types";
import { SessionEditsView } from "../components/SessionEditsView";
import { useProfiles } from "../providers/ProfileContext";
import { useRightPanelContext } from "../components/RightPanelContext";

export default function SessionEditsWidget() {
  const { activeCwd } = useProfiles();
  const { messages, sessionId } = useRightPanelContext();
  return <SessionEditsView messages={messages} sessionId={sessionId} cwd={activeCwd} />;
}
