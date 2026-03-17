/**
 * WebComposer — inline ConfigBar + ChatInput popup.
 *
 * Works with an existing session: loads/saves drafts via the same API
 * as the session page, sends messages via sendMessage. Text persists
 * until the user archives the session or clears the draft.
 *
 * Positioned at canvas coordinates when used on the SessionWeb canvas,
 * but decoupled enough to be rendered anywhere as a popup input.
 *
 * Draggable via a small grab handle at the top. Close button is
 * absolutely positioned in the top-right, outside ConfigBar's click zone.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { ConfigBar } from "./ConfigBar";
import { ChatInput } from "./ChatInput";
import { useSessionComposer } from "../hooks/useSessionComposer";
import { getDraft, saveDraft, sendMessage, stopSessionApi } from "../api";
import { subscribeSession, isSubscribed, getSessionState, setSessionState } from "../sessionStore";
import { nextMsgId } from "../api";
import type { Attachment } from "../api";

type Props = {
  /** Session to attach to — drafts persist here */
  sessionId: string;
  /** Canvas-space position (optional — omit for non-canvas usage) */
  x?: number;
  y?: number;
  onClose: () => void;
  /** Called after a message is successfully sent */
  onSent?: () => void;
  /** Report new position back to parent (e.g. for persisting after drag) */
  onMove?: (x: number, y: number) => void;
};

export function WebComposer({ sessionId, x, y, onClose, onSent, onMove }: Props) {
  const composer = useSessionComposer(null, null);
  const [input, setInput] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drag state
  const panelWidth = 420;
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  const dragRef = useRef<{ startX: number; startY: number; startDx: number; startDy: number } | null>(null);

  // Load draft on mount
  useEffect(() => {
    let cancelled = false;
    setDraftReady(false);
    getDraft(sessionId)
      .then((draft) => {
        if (!cancelled) { setInput(draft); setDraftReady(true); }
      })
      .catch(() => {
        if (!cancelled) { setInput(""); setDraftReady(true); }
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Auto-save draft on input change (debounced)
  useEffect(() => {
    if (!draftReady) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      saveDraft(sessionId, input).catch(() => {});
    }, 1000);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [input, sessionId, draftReady]);

  // Flush draft on close
  const handleClose = useCallback(() => {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    saveDraft(sessionId, input).catch(() => {});
    onClose();
  }, [sessionId, input, onClose]);

  // ── Drag to reposition ──

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startY: e.clientY, startDx: offset.dx, startDy: offset.dy };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = dragRef.current.startDx + (ev.clientX - dragRef.current.startX);
      const dy = dragRef.current.startDy + (ev.clientY - dragRef.current.startY);
      setOffset({ dx, dy });
    };

    const onMouseUp = (ev: MouseEvent) => {
      if (dragRef.current) {
        const finalDx = dragRef.current.startDx + (ev.clientX - dragRef.current.startX);
        const finalDy = dragRef.current.startDy + (ev.clientY - dragRef.current.startY);
        dragRef.current = null;
        if (x !== undefined && y !== undefined && onMove) {
          // Convert pixel offset back to canvas coords — but since we're inside
          // the transform container, dx/dy are already in canvas space
          onMove(x + finalDx, y + finalDy);
        }
      }
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [offset, x, y, onMove]);

  const session = getSessionState(sessionId);
  const isActive = session?.status === "running" || session?.status === "starting";

  const handleSend = useCallback(async (attachments: Attachment[], textOverride?: string) => {
    const prompt = (textOverride ?? input).trim();
    if (!prompt && attachments.length === 0) return;

    // Clear draft
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    setInput("");
    saveDraft(sessionId, "").catch(() => {});

    // Optimistic UI update
    const current = getSessionState(sessionId);
    if (current) {
      setSessionState(sessionId, {
        ...current,
        status: "running",
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
      }, session?.profile);
    }

    try {
      await sendMessage(
        sessionId,
        prompt,
        attachments.length > 0 ? attachments.map(a => ({
          type: a.type,
          mediaType: a.mediaType,
          data: a.data,
          name: a.name,
        })) : undefined,
        {
          profile: composer.activeProfileName || undefined,
          cwd: composer.projectCwd,
        },
      );
      if (!isSubscribed(sessionId)) {
        const latest = getSessionState(sessionId);
        subscribeSession(sessionId, latest?.lastSeq ?? 0, session?.profile ?? undefined);
      }
      onSent?.();
    } catch (err) {
      console.error("WebComposer: send failed:", err);
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
  }, [input, sessionId, session?.profile, composer.activeProfileName, composer.projectCwd, onSent]);

  const handleStop = useCallback(async () => {
    await stopSessionApi(sessionId).catch(() => {});
    const current = getSessionState(sessionId);
    if (current) {
      setSessionState(sessionId, { ...current, status: "idle" }, session?.profile);
    }
  }, [sessionId, session?.profile]);

  // Positioning
  const style: React.CSSProperties = x !== undefined && y !== undefined
    ? { left: (x - panelWidth / 2) + offset.dx, top: y + offset.dy }
    : {};

  return (
    <div
      ref={panelRef}
      className="web-composer"
      style={style}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
    >
      {/* Drag handle — full width bar at top, separate from ConfigBar */}
      <div className="web-composer-drag" onMouseDown={onDragStart}>
        <div className="web-composer-drag-grip" />
        <button
          className="web-composer-close"
          onClick={(e) => { e.stopPropagation(); handleClose(); }}
          onMouseDown={e => e.stopPropagation()}
          title="Close (draft saved)"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <ConfigBar
        profileName={composer.activeProfileName}
        model={composer.liveModel}
        agentConfig={composer.agentConfig}
        editorConfig={composer.editorAgentConfig}
        onAgentConfigChange={composer.setAgentConfig}
        profileTools={composer.profileData?.tools ?? "all"}
        editorProfileTools={composer.editorProfileData?.tools ?? "all"}
        availableProviders={composer.availableProviders}
        profileProvider={composer.liveProvider}
        editorProfileProvider={composer.editorProfileProvider}
        editorProfileModel={composer.editorProfileModel}
        profileEffort={composer.profileEffort}
        editorProfileEffort={composer.editorProfileEffort}
        editorProfileMaxTurns={composer.editorProfileMaxTurns}
        showProvider={true}
        profiles={composer.visibleProfiles}
        onSwitchProfile={composer.selectProfile}
        status={null}
        persistOpen
      />
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={handleSend}
        onStop={handleStop}
        sessionId={sessionId}
        sessionStatus={isActive ? (session?.status ?? null) : null}
        disabled={false}
        placeholder="start a conversation..."
        projectCwd={composer.projectCwd}
        userProfile={composer.userProfile}
        autoFocus
      />
    </div>
  );
}
