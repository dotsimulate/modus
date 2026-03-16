/**
 * AgentPortal — fixed-position ambient HUD for active agents and audio.
 *
 * Pill   — draggable PortalEye, always visible in top-right.
 *          Click to toggle panel. Drag to reposition.
 * Panel  — purpose-built dropdown with agent rows and audio player.
 *          Draggable surface, SE resize, localStorage persistence.
 *
 * Position, expansion state, and pinned sessions persist in localStorage.
 */

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import * as audioPlayer from "../audio-player";
import type { PlaybackState } from "../audio-player";
import { subscribeStore, getStoreSnapshot, getSessionState } from "../sessionStore";
import type { SessionInfo } from "../api/types";

/* ── Types ── */

type Props = {
  sessions: SessionInfo[];
  onNavigateSession: (id: string) => void;
  onPeekSession: (id: string) => void;
};

type VisibleSession = SessionInfo & {
  liveStatus: string;
  activeToolName?: string;
  isPinned: boolean;
  isActive: boolean;
};

type Pos = { top: number; left: number };
type Bounds = { top: number; left: number; width: number; height: number };
type PillDrag = { startX: number; startY: number; startPos: Pos; moved: boolean };
type PanelDrag = { startX: number; startY: number; bounds: Bounds } | null;

/* ── Constants ── */

const LS_EXPANDED = "ap:expanded";
const LS_PINNED   = "ap:pinned";
const LS_PILL     = "ap:pill";
const LS_PANEL    = "ap:panel";
const M = 8; // viewport margin
const PANEL_MIN_W = 240;
const PANEL_MIN_H = 100;

/* ── Persistence ── */

function loadPill(): Pos {
  try {
    const raw = localStorage.getItem(LS_PILL);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.top === "number" && typeof p.left === "number")
        return { top: clampN(p.top, M, window.innerHeight - 48), left: clampN(p.left, M, window.innerWidth - 48) };
    }
  } catch {}
  return { top: 48, left: Math.max(M, window.innerWidth - 52) };
}

function loadPinned(): Set<string> {
  try { const r = localStorage.getItem(LS_PINNED); return new Set(r ? JSON.parse(r) : []); }
  catch { return new Set(); }
}

function savePinned(ids: Set<string>) {
  try { localStorage.setItem(LS_PINNED, JSON.stringify([...ids])); } catch {}
}

function clampN(v: number, lo: number, hi: number) { return Math.min(Math.max(v, lo), hi); }

function clampBounds(b: Bounds): Bounds {
  const w = clampN(b.width, PANEL_MIN_W, window.innerWidth - M * 2);
  const h = clampN(b.height, PANEL_MIN_H, window.innerHeight - M * 2);
  return {
    width: w, height: h,
    left: clampN(b.left, M, window.innerWidth - w - M),
    top:  clampN(b.top, M, window.innerHeight - h - M),
  };
}

function loadPanel(pill: Pos): Bounds {
  try {
    const raw = localStorage.getItem(LS_PANEL);
    if (raw) {
      const b = JSON.parse(raw);
      if (typeof b.top === "number" && typeof b.left === "number" &&
          typeof b.width === "number" && typeof b.height === "number")
        return clampBounds(b);
    }
  } catch {}
  // Panel's top-right corner anchors to the pill — eye becomes the cornerstone
  const w = 300;
  return clampBounds({ top: pill.top, left: pill.left + 36 - w, width: w, height: 220 });
}

/* ── Hooks ── */

function useAudio(): PlaybackState {
  return useSyncExternalStore(audioPlayer.subscribe, audioPlayer.getState);
}
function useStoreRev(): number {
  return useSyncExternalStore(subscribeStore, getStoreSnapshot);
}

/* ══════════════════════════════════════════════════════════════
   PortalEye — circle ring + wandering dots
   ══════════════════════════════════════════════════════════════ */

function PortalEye({ agentCount, hasAudio, audioPlaying }: {
  agentCount: number; hasAudio: boolean; audioPlaying: boolean;
}) {
  const dots = Math.min(agentCount, 3);
  const audioOnly = hasAudio && agentCount === 0;

  return (
    <svg className="ap-eye" width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1" className="ap-eye-ring" />

      {Array.from({ length: dots }, (_, i) => (
        <g key={i} transform={`rotate(${72 * i} 16 16)`}>
          <circle cx="16" cy="16" r="2.5" fill="currentColor" className={`ap-eye-dot ap-eye-dot--${i}`} />
        </g>
      ))}

      {audioOnly && (
        <g className={`ap-eye-wave${audioPlaying ? " ap-eye-wave--playing" : ""}`}>
          <rect x="11.5" y="15" width="2" height="3" rx="1" fill="currentColor" className="ap-eye-wave-bar" style={{ animationDelay: "0ms" }} />
          <rect x="15"   y="13" width="2" height="7" rx="1" fill="currentColor" className="ap-eye-wave-bar" style={{ animationDelay: "110ms" }} />
          <rect x="18.5" y="15" width="2" height="3" rx="1" fill="currentColor" className="ap-eye-wave-bar" style={{ animationDelay: "55ms" }} />
        </g>
      )}
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════
   Sub-components — AgentRow, AudioRow
   ══════════════════════════════════════════════════════════════ */

const PinIcon = ({ filled }: { filled: boolean }) => (
  <svg width="9" height="9" viewBox="0 0 9 9"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor" strokeWidth={filled ? 0 : 1} aria-hidden="true">
    <path d="M4.5 0L5.56 2.95L8.56 2.95L6.15 4.77L7.16 7.7L4.5 5.85L1.84 7.7L2.85 4.77L0.44 2.95L3.44 2.95Z" />
  </svg>
);

function AgentRow({ session, onNavigate, onPeek, onTogglePin }: {
  session: VisibleSession;
  onNavigate: () => void;
  onPeek: () => void;
  onTogglePin: () => void;
}) {
  const label = session.profile ?? session.action_name ?? session.id.slice(0, 8);
  const tool  = session.activeToolName;
  const title = session.title ?? session.preview?.slice(0, 60) ?? null;

  return (
    <div className={`ap-row${session.isActive ? "" : " ap-row--idle"}`}>
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
      <div className="ap-row-actions">
        <button
          className={`ap-btn ap-btn-pin${session.isPinned ? " ap-btn-pin--on" : ""}`}
          onClick={onTogglePin}
          title={session.isPinned ? "Unpin" : "Pin"}
          aria-pressed={session.isPinned}
        >
          <PinIcon filled={session.isPinned} />
        </button>
        <button className="ap-btn" onClick={onPeek} title="Peek">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
            <rect x="1" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1" />
            <rect x="6" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1" />
            <rect x="1" y="6" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1" />
            <rect x="6" y="6" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button className="ap-btn" onClick={onNavigate} title="Go to session">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 5h6M5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function AudioRow({ audio, session, pct, onNavigate, onPeek }: {
  audio: PlaybackState; session: SessionInfo | null; pct: number;
  onNavigate?: () => void; onPeek?: () => void;
}) {
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (audio.activeId != null && audio.src)
      audioPlayer.toggle(audio.activeId, audio.src, audio.sessionId ?? undefined);
  }, [audio.activeId, audio.src, audio.sessionId]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    audioPlayer.seek(((e.clientX - rect.left) / rect.width) * audio.duration);
  }, [audio.duration]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const sessionLabel = session?.profile ?? session?.action_name ?? (audio.sessionId?.slice(0, 8) ?? null);

  return (
    <div className="ap-audio">
      <div className="ap-audio-controls">
        <button className="ap-audio-toggle" onClick={handleToggle} aria-label={audio.playing ? "Pause" : "Play"}>
          {audio.playing
            ? <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><rect x="0" y="0" width="2.5" height="10" rx="0.5" /><rect x="5.5" y="0" width="2.5" height="10" rx="0.5" /></svg>
            : <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><path d="M0 0L8 5L0 10Z" /></svg>}
        </button>
        {audio.playing && (
          <div className="ap-audio-viz" aria-hidden="true">
            <span className="ap-audio-viz-bar" style={{ animationDelay: "0ms" }} />
            <span className="ap-audio-viz-bar" style={{ animationDelay: "130ms" }} />
            <span className="ap-audio-viz-bar" style={{ animationDelay: "65ms" }} />
            <span className="ap-audio-viz-bar" style={{ animationDelay: "195ms" }} />
          </div>
        )}
        <div className="ap-audio-track" onClick={handleSeek} role="progressbar" aria-valuenow={pct}>
          <div className="ap-audio-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="ap-audio-time">
          {fmt(audio.currentTime)}<span className="ap-audio-time-total">/{fmt(audio.duration)}</span>
        </span>
      </div>
      {sessionLabel && (
        <div className="ap-audio-meta">
          <span className="ap-audio-label">{sessionLabel}</span>
          <div className="ap-row-actions">
            {onPeek && (
              <button className="ap-btn" onClick={onPeek} title="Peek">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                  <rect x="1" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1" />
                  <rect x="6" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1" />
                  <rect x="1" y="6" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1" />
                  <rect x="6" y="6" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1" />
                </svg>
              </button>
            )}
            {onNavigate && (
              <button className="ap-btn" onClick={onNavigate} title="Go to session">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M2 5h6M5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   AgentPortal — main component
   ══════════════════════════════════════════════════════════════ */

export function AgentPortal({ sessions, onNavigateSession, onPeekSession }: Props) {
  const audio = useAudio();
  useStoreRev();

  const [expanded,    setExpanded]    = useState(() => localStorage.getItem(LS_EXPANDED) === "1");
  const [pinnedIds,   setPinnedIds]   = useState<Set<string>>(loadPinned);
  const [pillPos,     setPillPos]     = useState<Pos>(loadPill);
  const [panelBounds, setPanelBounds] = useState<Bounds>(() => loadPanel(pillPos));

  const collapseTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pillDragRef    = useRef<PillDrag | null>(null);
  const panelDragRef   = useRef<PanelDrag>(null);
  const panelResizeRef = useRef<PanelDrag>(null);

  // Persist expanded
  useEffect(() => {
    try { localStorage.setItem(LS_EXPANDED, expanded ? "1" : "0"); } catch {}
  }, [expanded]);

  // ── Session data ──

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
  const hasAudio   = audio.activeId != null;
  const hasContent = visibleSessions.length > 0 || hasAudio;

  const audioSession = hasAudio && audio.sessionId
    ? sessions.find((s) => s.id === audio.sessionId) ?? null : null;
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;

  // Auto-collapse when content disappears
  useEffect(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    if (!hasContent && expanded)
      collapseTimer.current = setTimeout(() => setExpanded(false), 2000);
    return () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); };
  }, [hasContent, expanded]);

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  // ── Pill drag ──

  const onPillPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pillDragRef.current = { startX: e.clientX, startY: e.clientY, startPos: { ...pillPos }, moved: false };
  }, [pillPos]);

  const onPillPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = pillDragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    d.moved = true;
    const pos: Pos = {
      top:  clampN(d.startPos.top  + dy, M, window.innerHeight - 48),
      left: clampN(d.startPos.left + dx, M, window.innerWidth  - 48),
    };
    setPillPos(pos);
    try { localStorage.setItem(LS_PILL, JSON.stringify(pos)); } catch {}
  }, []);

  const onPillPointerUp = useCallback(() => {
    const d = pillDragRef.current;
    pillDragRef.current = null;
    if (d && !d.moved) toggleExpanded();
  }, [toggleExpanded]);

  // ── Panel drag + resize ──

  useEffect(() => {
    if (expanded) setPanelBounds(loadPanel(pillPos));
  }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!expanded) return;
    try { localStorage.setItem(LS_PANEL, JSON.stringify(panelBounds)); } catch {}
  }, [panelBounds, expanded]);

  useEffect(() => {
    if (!expanded) return;
    const h = () => setPanelBounds((b) => clampBounds(b));
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;

    const onMove = (e: PointerEvent) => {
      if (panelDragRef.current) {
        const dx = e.clientX - panelDragRef.current.startX;
        const dy = e.clientY - panelDragRef.current.startY;
        setPanelBounds(clampBounds({
          ...panelDragRef.current.bounds,
          left: panelDragRef.current.bounds.left + dx,
          top:  panelDragRef.current.bounds.top  + dy,
        }));
      }
      if (panelResizeRef.current) {
        const dx = e.clientX - panelResizeRef.current.startX;
        const dy = e.clientY - panelResizeRef.current.startY;
        setPanelBounds(clampBounds({
          ...panelResizeRef.current.bounds,
          width:  panelResizeRef.current.bounds.width  + dx,
          height: panelResizeRef.current.bounds.height + dy,
        }));
      }
    };

    const onUp = () => {
      panelDragRef.current   = null;
      panelResizeRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup",   onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup",   onUp);
    };
  }, [expanded]);

  const onPanelPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, input, textarea, a, [role=progressbar]")) return;
    e.preventDefault();
    panelDragRef.current = { startX: e.clientX, startY: e.clientY, bounds: panelBounds };
  };

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    panelResizeRef.current = { startX: e.clientX, startY: e.clientY, bounds: panelBounds };
  };

  // ── Pin ──

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      savePinned(next);
      return next;
    });
  }, []);

  // ── Header label ──

  const headerLabel = hasAgents
    ? `${activeSessions.length} active`
    : hasAudio
      ? "audio"
      : visibleSessions.length > 0
        ? `${visibleSessions.length} pinned`
        : "idle";

  // ── Render ──

  return (
    <>
      {/* ── Pill: always visible, draggable ── */}
      <button
        className={[
          "ap-pill",
          expanded && "ap-pill--open",
          hasAgents && "ap-pill--active",
          audio.playing && "ap-pill--playing",
          pinnedIds.size > 0 && !hasAgents && "ap-pill--pinned",
          !hasContent && pinnedIds.size === 0 && !expanded && "ap-pill--idle",
        ].filter(Boolean).join(" ")}
        style={{ top: pillPos.top, left: pillPos.left }}
        onPointerDown={onPillPointerDown}
        onPointerMove={onPillPointerMove}
        onPointerUp={onPillPointerUp}
        onPointerCancel={() => { pillDragRef.current = null; }}
        title={expanded ? "Close monitor" : "Open monitor"}
        aria-expanded={expanded}
      >
        <PortalEye agentCount={activeSessions.length} hasAudio={hasAudio} audioPlaying={audio.playing} />
      </button>

      {/* ── Panel: portal-mounted dropdown ── */}
      {expanded && createPortal(
        <div
          className="ap-panel"
          style={{
            top:    panelBounds.top,
            left:   panelBounds.left,
            width:  panelBounds.width,
            height: panelBounds.height,
          }}
          onPointerDown={onPanelPointerDown}
        >
          <div className="ap-panel-head">
            <span className="ap-panel-label">{headerLabel}</span>
            <button className="ap-panel-close" onClick={() => setExpanded(false)} title="Close" aria-label="Close">
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                <path d="M1 1L7 7M7 1L1 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="ap-panel-body">
            {visibleSessions.length > 0 && (
              <div className="ap-section">
                {visibleSessions.map((s) => (
                  <AgentRow
                    key={s.id}
                    session={s}
                    onTogglePin={() => togglePin(s.id)}
                    onNavigate={() => { onNavigateSession(s.id); setExpanded(false); }}
                    onPeek={() => onPeekSession(s.id)}
                  />
                ))}
              </div>
            )}

            {hasAudio && (
              <div className={`ap-section${visibleSessions.length > 0 ? " ap-section--sep" : ""}`}>
                <AudioRow
                  audio={audio}
                  session={audioSession}
                  pct={pct}
                  onNavigate={audioSession ? () => { onNavigateSession(audioSession.id); setExpanded(false); } : undefined}
                  onPeek={audioSession ? () => onPeekSession(audioSession.id) : undefined}
                />
              </div>
            )}

            {!hasContent && <div className="ap-empty">no active agents</div>}
          </div>

          <div className="ap-panel-resize" onPointerDown={onResizePointerDown} />
        </div>,
        document.body,
      )}
    </>
  );
}
