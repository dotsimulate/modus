/**
 * Actions Manager widget — actions view as a page-embeddable widget.
 *
 * Config: { "type": "actions-manager", "id": "am-1" }
 *
 * Wraps the existing Actions component. Uses ProfileContext internally
 * for cwd/profile resolution. onSelectSession comes from WidgetProps.
 */

import { Actions } from "../components/Actions";
import type { WidgetBase, WidgetProps } from "./types";

type ActionsManagerConfig = WidgetBase & {
  type: "actions-manager";
};

export default function ActionsManagerWidget({ onSelectSession, pageContext }: WidgetProps<ActionsManagerConfig>) {
  const handleSelectSession = (id: string) => {
    if (pageContext) { pageContext.set("selectedSession", id); } else { onSelectSession(id); }
  };

  return (
    <div className="actions-manager-widget" style={{ height: "100%", overflow: "auto" }}>
      <Actions onSelectSession={handleSelectSession} />
    </div>
  );
}
