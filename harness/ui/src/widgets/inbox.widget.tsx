/**
 * Inbox widget — sessions awaiting user response.
 *
 * Config: { "type": "inbox" }
 *
 * Shows sessions where the agent has responded and is waiting for the user.
 * Each card shows the profile, a preview of the last response, and time since
 * last activity. Clicking opens the session in the current page context.
 */

import { useMemo } from "react";
import type { SessionInfo } from "../../../sdk/index";
import { useSession } from "../providers/SessionContext";

import { getSessionState } from "../sessionStore";
import { timeAgo, fmtCost } from "../utils/format";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

type InboxConfig = WidgetBase & {
  type: "inbox";
  limit?: number;
};

/** A session is "awaiting response" when the agent finished and the user hasn't replied. */
function isAwaitingResponse(s: SessionInfo): boolean {
  // Must have a last_response (agent said something)
  if (!s.last_response) return false;
  // If the session is actively running, it's not waiting on the user
  const live = getSessionState(s.id);
  const status = live?.status ?? s.status;
  if (status === "running" || status === "streaming") return false;
  // If there's a last_prompt that's newer than or equal to last_response, the user already replied
  // We use message_count parity as a heuristic: odd = user's turn, even = agent's turn
  // But simpler: if last_response exists and status is idle/done, the agent finished its turn
  return true;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
}

export default function InboxWidget({ pageContext, onSelectSession }: WidgetProps<InboxConfig>) {
  const { serverSessions } = useSession();
  const inbox = useMemo(() => {
    const awaiting = serverSessions
      .filter(isAwaitingResponse)
      .sort((a, b) => b.last_message_at - a.last_message_at);
    return awaiting;
  }, [serverSessions]);

  const handleSelect = (id: string) => {
    if (pageContext) {
      pageContext.set("selectedSession", id);
    } else {
      onSelectSession(id);
    }
  };

  if (inbox.length === 0) {
    return <WidgetEmptyState>no sessions waiting</WidgetEmptyState>;
  }

  return (
    <div className="inbox-widget">
      {inbox.map((s) => (
        <button
          key={s.id}
          className="inbox-card"
          onClick={() => handleSelect(s.id)}
        >
          <div className="inbox-card-header">
            {s.profile && <span className="inbox-card-profile">{s.profile}</span>}
            <span className="inbox-card-time">{timeAgo(s.last_message_at)}</span>
          </div>
          {s.title && (
            <div className="inbox-card-title">{truncate(s.title, 80)}</div>
          )}
          <div className="inbox-card-response">
            {truncate(s.last_response ?? "", 200)}
          </div>
          <div className="inbox-card-meta">
            <span className="inbox-card-turns">{s.message_count} msgs</span>
            {s.total_cost_usd > 0 && (
              <span className="inbox-card-cost">{fmtCost(s.total_cost_usd)}</span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
