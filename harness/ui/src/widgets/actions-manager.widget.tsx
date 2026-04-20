/**
 * Actions Manager widget — actions view as a page-embeddable widget.
 *
 * Config: { "type": "actions-manager", "id": "am-1" }
 *
 * Wraps the existing Actions component. Uses ProfileContext internally
 * for cwd/profile resolution. onSelectSession comes from WidgetProps.
 */

import { Actions } from "../components/Actions";
import { useUiIntent } from "./intents";
import type { WidgetBase, WidgetProps } from "./types";

type ActionsManagerConfig = WidgetBase & {
  type: "actions-manager";
};

export default function ActionsManagerWidget({ onSelectSession, pageContext }: WidgetProps<ActionsManagerConfig>) {
  const { dispatch } = useUiIntent(pageContext);

  const handleSelectSession = (id: string) => {
    pageContext?.set("selectedSession", id);
    onSelectSession(id);
  };

  return (
    <div className="actions-manager-widget">
      <Actions
        onSelectSession={handleSelectSession}
        onOpenTerminal={(ownerType, ownerName, label) => {
          dispatch({ type: "open-terminal", ownerType, ownerName, label });
        }}
      />
    </div>
  );
}
