/**
 * AgentPortal — eye + panel.
 *
 * Collapsed: the eye. Drag to reposition. Click to expand.
 * Expanded:  panel materializes via clip-path.
 *            Eye is position:absolute top-right — no dead zone.
 *            Each session row = click to navigate. No other buttons.
 *            extraContent slot for caller-injected content (audio, etc).
 */

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { subscribeStore, getStoreSnapshot, getSessionState } from "../sessionStore";
import type { SessionInfo } from "../../../sdk/index";

/* ── Types ── */

type Props = {
  sessions: SessionInfo[];
  onNavigateSession: (id: string) => void;
  onPeekSession: (id: string) => void;
  extraContent?: React.ReactNode;
};

type VisibleSession = SessionInfo & {
  liveStatus: string;
  activeToolName?: string;
  isPinned: boolean;
  isActive: boolean;
};

type Pos = { top: number; right: number };

/* ── Constants ── */

const LS_EXPANDED = "ap:expanded";
const LS_PINNED   = "ap:pinned";
const LS_POS      = "ap:pos2";
const M = 14;

/* ── Persistence ── */

function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(LS_POS);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.top === "number" && typeof p.right === "number")
        return {
          top:   Math.min(Math.max(p.top,   M), window.innerHeight - 48),
          right: Math.min(Math.max(p.right, M), window.innerWidth  - 48),
        };
    }
  } catch {}
  return { top: 14, right: 14 };
}

function loadPinned(): Set<string> {
  try { const r = localStorage.getItem(LS_PINNED); return new Set(r ? JSON.parse(r) : []); }
  catch { return new Set(); }
}

/* ── Store hook ── */

function useStoreRev(): number {
  return useSyncExternalStore(subscribeStore, getStoreSnapshot);
}

/* ══════════════════════════════════════════════════════════════
   PortalEye
   ══════════════════════════════════════════════════════════════ */

function PortalEye({ agentCount }: { agentCount: number }) {
  const dots = Math.min(agentCount, 3);
  return (
    <svg className="ap-eye" width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1" className="ap-eye-ring" />
      {Array.from({ length: dots }, (_, i) => (
        <g key={i} transform={`rotate(${72 * i} 16 16)`}>
          <circle cx="16" cy="16" r="2.5" fill="currentColor" className={`ap-eye-dot ap-eye-dot--${i}`} />
        </g>
      ))}
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════
   AgentRow — dot + text. Click = navigate. Nothing else.
   ══════════════════════════════════════════════════════════════ */

function AgentRow({ session, onNavigate }: {
  session: VisibleSession;
  onNavigate: () => void;
}) {
  const label = session.profile ?? session.action_name ?? session.id.slice(0, 8);
  const tool  = session.activeToolName;
  const title = session.title ?? session.preview?.slice(0, 60) ?? null;

  return (
    <div
      className={`ap-row${session.isActive ? "" : " ap-row--idle"}`}
      onClick={onNavigate}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onNavigate(); }}
    >
      <span className={`ap-row-dot${
        session.liveStatus === "running"  ? " ap-row-dot--running" :
        session.liveStatus === "starting" ? " ap-row-dot--starting" :
        session.isPinned                  ? " ap-row-dot--pinned" : ""
      }`} />
      <div className="ap-row-info">
        <span className="ap-row-name">{label}</span>
        {session.isActive && tool
          ? <span className="ap-row-detail ap-row-detail--tool">{tool}</span>
          : title ? <span className="ap-row-detail">{title}</span>
          : null}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   AgentPortal
   ══════════════════════════════════════════════════════════════ */

export function AgentPortal({ sessions, onNavigateSession, extraContent }: Props) {
  useStoreRev();

  const [expanded,  setExpanded]  = useState(() => localStorage.getItem(LS_EXPANDED) === "1");
  const [pinnedIds]               = useState<Set<string>>(loadPinned);
  const [pos,       setPos]       = useState<Pos>(loadPos);

  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{
    startX: number; startY: number; startPos: Pos; moved: boolean;
  } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(LS_EXPANDED, expanded ? "1" : "0"); } catch {}
  }, [expanded]);

  // ── Sessions ──

  const visibleSessions: VisibleSession[] = sessions
    .map((s) => {
      const live       = getSessionState(s.id);
      const liveStatus = live?.status ?? s.status;
      const isActive   = liveStatus === "running" || liveStatus === "starting";
      const isPinned   = pinnedIds.has(s.id);
      return { ...s, liveStatus, activeToolName: live?.activeToolName, isActive, isPinned };
    })
    .filter((s) => s.isActive || s.isPinned)
    .sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return (b.last_message_at ?? 0) - (a.last_message_at ?? 0);
    });

  const activeSessions = visibleSessions.filter((s) => s.isActive);
  const hasAgents  = activeSessions.length > 0;
  const hasContent = visibleSessions.length > 0 || !!extraContent;

  // Auto-collapse when content disappears
  useEffect(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    if (!hasContent && expanded)
      collapseTimer.current = setTimeout(() => setExpanded(false), 2000);
    return () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); };
  }, [hasContent, expanded]);

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  // ── Drag — eye only ──

  const handleEyePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPos: { ...pos }, moved: false };

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (!d.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      d.moved = true;
      const next: Pos = {
        top:   Math.min(Math.max(d.startPos.top   + dy, M), window.innerHeight - 48),
        right: Math.min(Math.max(d.startPos.right - dx, M), window.innerWidth  - 48),
      };
      setPos(next);
      try { localStorage.setItem(LS_POS, JSON.stringify(next)); } catch {}
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup",   onUp);
      setTimeout(() => { dragRef.current = null; }, 0);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup",   onUp);
  }, [pos]);

  const handleEyeClick = useCallback(() => {
    if (dragRef.current?.moved) return;
    toggleExpanded();
  }, [toggleExpanded]);

  // ── Render ──

  return (
    <div
      className={[
        "ap-widget",
        expanded  && "ap-widget--open",
        hasAgents && "ap-widget--active",
        !hasContent && !expanded && "ap-widget--idle",
      ].filter(Boolean).join(" ")}
      style={{ top: pos.top, right: pos.right }}
      aria-label="Agent monitor"
    >
      {/* Eye — absolute top-right, drag + toggle only */}
      <div className="ap-head">
        <button
          className="ap-eye-btn"
          onPointerDown={handleEyePointerDown}
          onClick={handleEyeClick}
          title={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
        >
          <PortalEye agentCount={activeSessions.length} />
        </button>
      </div>

      {/* Body */}
      <div className="ap-body">
        {visibleSessions.length > 0 && (
          <div className="ap-section">
            {visibleSessions.map((s) => (
              <AgentRow
                key={s.id}
                session={s}
                onNavigate={() => onNavigateSession(s.id)}
              />
            ))}
          </div>
        )}

        {extraContent && (
          <div className={`ap-section${visibleSessions.length > 0 ? " ap-section--sep" : ""}`}>
            {extraContent}
          </div>
        )}

        {!hasContent && <div className="ap-empty">no active agents</div>}
      </div>
    </div>
  );
}
