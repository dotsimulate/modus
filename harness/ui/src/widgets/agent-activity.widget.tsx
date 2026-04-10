import { AgentActivityView } from "../components/AgentActivityView";
import { useRightPanelContext } from "../components/RightPanelContext";

export default function AgentActivityWidget() {
  const { messages } = useRightPanelContext();
  return <AgentActivityView messages={messages} />;
}
