/**
 * AgentPortal — one fixed element. The eye is everything.
 *
 * Collapsed: the eye. A circle with wandering dots.
 * Expanded:  the panel materializes from the eye via clip-path.
 *            The eye stays top-right — it IS the close affordance.
 *
 * Drag the eye to reposition. Click to toggle. No X. No portal.
 */

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
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

type Pos = { top: number; right: number };

/* ── Constants ── */

const LS_EXPANDED = "ap:expanded";
const LS_PINNED   = "ap:pinned";
const LS_POS      = "ap:pos2"; // new key — top/right schema
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

function savePinned(ids: Set<string>) {
  try { localStorage.setItem(LS_PINNED, JSON.stringify([...ids])); } catch {}
}

/* ── Hooks ── */

function useAudio(): PlaybackState {
  return useSyncExternalStore(audioPlayer.subscribe, audioPlayer.getState);
}
function useStoreRev(): number {
  return useSyncExternalStore(subscribeStore, getStoreSnapshot);
}

/* ══════════════════════════════════════════════════════════════
   PortalEye
   ══════════════════════════════════════════════════════════════ */

function PortalEye({ agentCount, hasAudio, audioPlaying }: {
  agentCount: number; hasAudio: boolean; audioPlaying: boolean;
}) {
  const dots = Math.min(agentCount, 3);

  return (
    <svg className="ap-eye" width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1" className="ap-eye-ring" />

      {Array.from({ length: dots }, (_, i) => (
        <g key={i} transform={`rotate(${72 * i} 16 16)`}>
          <circle cx="16" cy="16" r="2.5" fill="currentColor" className={`ap-eye-dot ap-eye-dot--${i}`} />
        </g>
      ))}

      {hasAudio && (
        <circle
          cx="16" cy="16" r="3"
          fill="currentColor"
          className={`ap-eye-audio-dot${audioPlaying ? " ap-eye-audio-dot--playing" : ""}`}
        />
      )}
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════
   AgentRow, AudioRow
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
   AgentPortal
   ══════════════════════════════════════════════════════════════ */

export function AgentPortal({ sessions, onNavigateSession, onPeekSession }: Props) {
  const audio = useAudio();
  useStoreRev();

  const [expanded,  setExpanded]  = useState(() => localStorage.getItem(LS_EXPANDED) === "1");
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(loadPinned);
  const [pos,       setPos]       = useState<Pos>(loadPos);

  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drag state — closured in global listeners, not stored in component state
  const dragRef = useRef<{
    startX: number; startY: number; startPos: Pos; moved: boolean;
  } | null>(null);

  // Persist expanded
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

  // ── Drag (on the eye — it's the only drag handle) ──
  // Uses global pointermove/pointerup so we can drag without pointer capture
  // fighting with the click event.

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
      // Leave dragRef intact for the click handler below; clear after microtask
      setTimeout(() => { dragRef.current = null; }, 0);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup",   onUp);
  }, [pos]);

  const handleEyeClick = useCallback(() => {
    // If this pointer-sequence was a drag, skip the toggle
    if (dragRef.current?.moved) return;
    toggleExpanded();
  }, [toggleExpanded]);

  // ── Pin ──

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      savePinned(next);
      return next;
    });
  }, []);

  // ── Render ──

  return (
    <div
      className={[
        "ap-widget",
        expanded            && "ap-widget--open",
        hasAgents           && "ap-widget--active",
        audio.playing       && "ap-widget--playing",
        !hasContent && !expanded && "ap-widget--idle",
      ].filter(Boolean).join(" ")}
      style={{ top: pos.top, right: pos.right }}
      aria-label="Agent monitor"
    >
      {/* Eye — always at top-right, the only head element */}
      <div className="ap-head">
        <button
          className="ap-eye-btn"
          onPointerDown={handleEyePointerDown}
          onClick={handleEyeClick}
          title={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
        >
          <PortalEye agentCount={activeSessions.length} hasAudio={hasAudio} audioPlaying={audio.playing} />
        </button>
      </div>

      {/* Body — always in DOM, pointer-events toggled via CSS */}
      <div className="ap-body">
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
    </div>
  );
}
