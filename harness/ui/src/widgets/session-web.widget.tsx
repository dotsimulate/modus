/**
 * Session Web widget — session relationship graph as a page-embeddable widget.
 *
 * Config: { "type": "session-web", "id": "sw-1" }
 *
 * Wraps the existing SessionWeb component. Self-contained — fetches its own
 * data from the modus API and ProfileContext.
 */

import { SessionWeb } from "../components/SessionWeb";
import type { WidgetBase, WidgetProps } from "./types";

type SessionWebConfig = WidgetBase & {
  type: "session-web";
};

export default function SessionWebWidget(_props: WidgetProps<SessionWebConfig>) {
  return (
    <div className="session-web-widget" style={{ height: "100%", overflow: "hidden" }}>
      <SessionWeb />
    </div>
  );
}
