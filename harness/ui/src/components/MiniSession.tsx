/**
 * MiniSession — compact inline session viewer.
 *
 * Shows status + last assistant text + permission overlay.
 * Uses the existing sessionStore (SSE subscription + event reducer)
 * so no new state management is needed.
 */

import { useEffect, useCallback } from "react";
import { useSessionState, ensureSubscribed } from "../sessionStore";
import { modus } from "../modusClient";
import { PermissionOverlay } from "./PermissionOverlay";

type Props = {
  sessionId: string;
  onNavigate?: (sessionId: string) => void;
};

function statusLabel(status: string, turns: number): string {
  if (status === "running" || status === "starting" || status === "interrupting") {
    return turns > 0 ? `working... (${turns} turn${turns !== 1 ? "s" : ""})` : "working...";
  }
  if (status === "error") return "error";
  return "idle";
}

/** Extract trailing text from the last assistant message */
function lastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].content) {
      return messages[i].content;
    }
  }
  return "";
}

/** Trim text to roughly N trailing lines */
function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}

export function MiniSession({ sessionId, onNavigate }: Props) {
  // Snapshot-then-subscribe (handles dedup + race-safe hydration internally)
  useEffect(() => {
    void ensureSubscribed(sessionId);
  }, [sessionId]);

  const session = useSessionState(sessionId);

  const handlePermission = useCallback(
    async (
      requestId: string,
      behavior: "allow" | "deny",
      updatedInput?: Record<string, unknown>,
      scope?: "once" | "session",
    ) => {
      await modus.respondToPermission(sessionId, { requestId, behavior, updatedInput, scope }).catch(() => {});
    },
    [sessionId],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't navigate when clicking interactive elements
      if ((e.target as HTMLElement).closest("button, input, textarea, a")) return;
      onNavigate?.(sessionId);
    },
    [sessionId, onNavigate],
  );

  if (!session) {
    return (
      <div className="mini-session">
        <div className="mini-session-status">
          <span className="mini-session-dot mini-session-dot--starting" />
          <span>connecting...</span>
        </div>
      </div>
    );
  }

  const isActive = session.status === "running" || session.status === "starting" || session.status === "interrupting";
  const turns = session.messages?.filter((m: any) => m.role === "assistant" && m.meta).length ?? 0;
  const tail = tailLines(lastAssistantText(session.messages ?? []), 3);
  const permissions = session.pendingPermissions ?? [];

  return (
    <div
      className={`mini-session${onNavigate ? " mini-session--clickable" : ""}`}
      onClick={handleClick}
    >
      {/* Status line */}
      <div className="mini-session-status">
        <span className={`mini-session-dot${isActive ? " mini-session-dot--active" : session.status === "error" ? " mini-session-dot--error" : ""}`} />
        <span className="mini-session-label">{statusLabel(session.status, turns)}</span>
        {onNavigate && (
          <button className="mini-session-expand" onClick={() => onNavigate(sessionId)}>
            open
          </button>
        )}
      </div>

      {/* Last assistant text (trailing 3 lines) */}
      {tail && (
        <div className="mini-session-text">{tail}</div>
      )}

      {/* Permissions — inline */}
      {permissions.length > 0 && (
        <PermissionOverlay
          permissions={permissions}
          sessionId={sessionId}
          onRespond={handlePermission}
        />
      )}
    </div>
  );
}
