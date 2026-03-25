/**
 * SessionWindow — medium floating session viewer.
 *
 * Uses FloatingWindow shell + sessionStore subscription.
 * Shows a draggable header with status, scrollable message list,
 * and inline permission handling. A richer view than MiniSession,
 * lighter than the full ChatView page.
 */

import { useEffect, useCallback, useEffectEvent, useRef, useState } from "react";
import type { Attachment, MoveBinding } from "../api";
import { getDraft, saveDraft, sendMessage, stopSessionApi, respondToPermission, nextMsgId } from "../api";
import { useSessionState, subscribeSession, isSubscribed, getSessionState, setSessionState } from "../sessionStore";
import { useProfiles } from "../providers/ProfileProvider";
import { FloatingWindow } from "./FloatingWindow";
import { ChatView } from "./ChatView";
import { ChatInput } from "./ChatInput";
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
  const { projectRoot } = useProfiles();
  const [input, setInput] = useState("");
  const [queuedMessage, setQueuedMessage] = useState<{ text: string; attachments: Attachment[] } | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftReadyRef = useRef(false);

  useEffect(() => {
    if (sessionId && !isSubscribed(sessionId)) {
      subscribeSession(sessionId, 0);
    }
  }, [sessionId]);

  const session = useSessionState(sessionId);
  const isActive = session?.status === "running" || session?.status === "starting";
  const permissions = session?.pendingPermissions ?? [];
  const resetComposer = useEffectEvent(() => {
    setInput("");
    setQueuedMessage(null);
  });

  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      draftReadyRef.current = false;
      resetComposer();
      return () => { cancelled = true; };
    }
    draftReadyRef.current = false;
    resetComposer();
    getDraft(sessionId)
      .then((draft) => {
        if (cancelled) return;
        setInput(draft);
        draftReadyRef.current = true;
      })
      .catch(() => {
        if (cancelled) return;
        setInput("");
        draftReadyRef.current = true;
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !draftReadyRef.current) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      saveDraft(sessionId, input).catch(() => {});
    }, 1000);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [input, sessionId]);

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

  function handleInputChange(text: string) {
    setInput(text);
  }

  async function handleStop() {
    if (!sessionId) return;
    await stopSessionApi(sessionId).catch(() => {});
    const current = getSessionState(sessionId);
    if (current) {
      setSessionState(sessionId, { ...current, status: "idle" }, session?.profile);
    }
  }

  async function sendPrompt(prompt: string, attachments: Attachment[], moves?: MoveBinding[]) {
    if (!sessionId) return;
    if (!prompt && attachments.length === 0) return;

    if (isActive) {
      setQueuedMessage({ text: prompt, attachments });
      return;
    }

    const current = getSessionState(sessionId);
    if (!current) return;

    const updated = {
      ...current,
      status: "running" as const,
      messages: [
        ...current.messages,
        {
          id: nextMsgId(),
          role: "user" as const,
          content: prompt,
          timestamp: Date.now(),
          attachments: attachments.length > 0 ? attachments : undefined,
        },
      ],
    };
    setSessionState(sessionId, updated, session?.profile);

    try {
      await sendMessage(
        sessionId,
        prompt,
        attachments.length > 0 ? attachments.map((att) => ({
          type: att.type,
          mediaType: att.mediaType,
          data: att.data,
          name: att.name,
        })) : undefined,
        {
          profile: session?.profile ?? undefined,
          cwd: current.cwd,
          loadProjectSettings: current.loadProjectSettings,
          moves,
        },
      );
      if (!isSubscribed(sessionId)) {
        const latest = getSessionState(sessionId);
        subscribeSession(sessionId, latest?.lastSeq ?? 0, session?.profile ?? undefined);
      }
    } catch (err) {
      const latest = getSessionState(sessionId);
      if (latest) {
        setSessionState(sessionId, {
          ...latest,
          status: "error",
          messages: [
            ...latest.messages,
            { id: nextMsgId(), role: "assistant", content: `Error: ${err}` },
          ],
        }, session?.profile);
      }
    }
  }

  async function handleSend(attachments: Attachment[], textOverride?: string, moves?: MoveBinding[]) {
    if (!sessionId) return;
    const prompt = (textOverride ?? input).trim();
    if (!prompt && attachments.length === 0) return;

    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }

    setInput("");
    saveDraft(sessionId, "").catch(() => {});
    await sendPrompt(prompt, attachments, moves);
  }

  const flushQueuedMessage = useEffectEvent((text: string, attachments: Attachment[]) => {
    setQueuedMessage(null);
    void sendPrompt(text, attachments);
  });

  useEffect(() => {
    if (!queuedMessage || !sessionId) return;
    if (session?.status === "running" || session?.status === "starting") return;
    const { text, attachments } = queuedMessage;
    setTimeout(() => {
      flushQueuedMessage(text, attachments);
    }, 0);
  }, [queuedMessage, session?.status, sessionId]);

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

          {sessionId && (
            <div className="session-window-input">
              <ChatInput
                value={input}
                onChange={handleInputChange}
                onSend={handleSend}
                onStop={handleStop}
                sessionStatus={session?.status ?? null}
                disabled={false}
                sessionId={sessionId}
                projectCwd={projectRoot ?? session?.cwd}
                autoFocus
              />
            </div>
          )}

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
