import type { WidgetProps } from "./types";
import { TerminalView } from "../components/TerminalView";
import { useProfiles } from "../providers/ProfileContext";
import { useRightPanelContext } from "../components/RightPanelContext";

export default function SessionTerminalWidget(_: WidgetProps) {
  const { activeCwd } = useProfiles();
  const { sessionId } = useRightPanelContext();
  return <TerminalView cwd={activeCwd} visible={true} sessionId={sessionId} />;
}
