/**
 * SessionWindow — medium floating session viewer.
 *
 * Uses FloatingWindow shell + sessionStore subscription.
 * Shows a draggable header with status, scrollable message list,
 * and inline permission handling. A richer view than MiniSession,
 * lighter than the full ChatView page.
 */

import { useEffect, useCallback } from "react";
import { useSessionState, subscribeSession, isSubscribed } from "../sessionStore";
import { respondToPermission } from "../api";
import { FloatingWindow } from "./FloatingWindow";
import { ChatView } from "./ChatView";
import { PermissionOverlay } from "./PermissionOverlay";

type Props = {
  sessionId: string | null;
  onClose: () => void;
  onNavigate?: (sessionId: string) => void;
};

function statusLabel(status: string): string {
  if (status === "running" || status === "starting") return "working...";
  if (status === "error") return "error";
  return "idle";
}

export function SessionWindow({ sessionId, onClose, onNavigate }: Props) {
  useEffect(() => {
    if (sessionId && !isSubscribed(sessionId)) {
      subscribeSession(sessionId, 0);
    }
  }, [sessionId]);

  const session = useSessionState(sessionId);

  const handlePermission = useCallback(
    async (
      requestId: string,
      behavior: "allow" | "deny",
      updatedInput?: Record<string, unknown>,
      scope?: "once" | "session",
    ) => {
      if (!sessionId) return;
      await respondToPermission(sessionId, { requestId, behavior, updatedInput, scope }).catch(() => {});
    },
    [sessionId],
  );

  const isActive = session?.status === "running" || session?.status === "starting";
  const permissions = session?.pendingPermissions ?? [];

  return (
    <FloatingWindow
      open={!!sessionId}
      onClose={onClose}
      storageKey="session-window-bounds"
      minWidth={380}
      minHeight={240}
      className="session-window"
    >
      {({ onPointerDown }) => (
        <>
          {/* ── Header (drag zone) ── */}
          <div className="session-window-head" onPointerDown={onPointerDown}>
            <div className="session-window-status">
              <span className={`session-window-dot${isActive ? " session-window-dot--active" : session?.status === "error" ? " session-window-dot--error" : ""}`} />
              <span className="session-window-label">
                {session ? statusLabel(session.status) : "connecting..."}
              </span>
            </div>
            <div className="session-window-actions">
              {onNavigate && sessionId && (
                <button
                  className="session-window-btn"
                  onClick={() => onNavigate(sessionId)}
                  title="Open full view"
                >
                  expand
                </button>
              )}
              <button className="session-window-btn" onClick={onClose} title="Close">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

          {/* ── Messages ── */}
          <div className="session-window-body">
            {session ? (
              <ChatView
                messages={session.messages ?? []}
                streaming={isActive ?? false}
                streamFeed={session.streamFeed}
                showThinking={false}
                showMeta={false}
                showToolCalls={true}
                showGitEvents={false}
                emptyTitle="waiting"
                emptySubtitle="session starting..."
              />
            ) : (
              <div className="session-window-empty">connecting...</div>
            )}
          </div>

          {/* ── Permissions ── */}
          {permissions.length > 0 && sessionId && (
            <div className="session-window-permissions">
              <PermissionOverlay
                permissions={permissions}
                sessionId={sessionId}
                onRespond={handlePermission}
              />
            </div>
          )}
        </>
      )}
    </FloatingWindow>
  );
}
