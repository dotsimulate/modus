/**
 * AgentPortal — always-on-top ambient HUD for active agents and audio.
 *
 * Pill   — compact top-nav indicator with PortalEye (MO-logo visual language).
 * Widget — MiniFloat portal. Drag any surface. SE-corner resize.
 *          Per-session pin keeps sessions visible when idle.
 *
 * State: expanded/collapsed + pinned session IDs persisted in localStorage.
 */

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import * as audioPlayer from "../audio-player";
import type { PlaybackState } from "../audio-player";
import { subscribeStore, getStoreSnapshot, getSessionState } from "../sessionStore";
import { MiniFloat } from "./MiniFloat";
import type { SessionInfo } from "../api/types";

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

const LS_EXPANDED = "ap:expanded";
const LS_PINNED   = "ap:pinned-sessions";

function loadPinnedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_PINNED);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

function savePinnedIds(ids: Set<string>) {
  try { localStorage.setItem(LS_PINNED, JSON.stringify([...ids])); } catch {}
}

function useAudioState(): PlaybackState {
  return useSyncExternalStore(audioPlayer.subscribe, audioPlayer.getState);
}

function useStoreRevision(): number {
  return useSyncExternalStore(subscribeStore, getStoreSnapshot);
}

// ── PortalEye: circle-ring + wandering dots, same grammar as MoLogo ──

function PortalEye({ agentCount, hasAudio, audioPlaying }: {
  agentCount: number; hasAudio: boolean; audioPlaying: boolean;
}) {
  const dots = Math.min(agentCount, 3);
  const audioOnly = hasAudio && agentCount === 0;

  return (
    <svg className="ap-eye" width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      {/* The ring — brightens with state via CSS */}
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1" className="ap-eye-ring" />

      {/* Agent wandering dots — one per active agent, rotated start positions */}
      {Array.from({ length: dots }, (_, i) => (
        <g key={i} transform={`rotate(${72 * i} 16 16)`}>
          <circle cx="16" cy="16" r="2.5" fill="currentColor" className={`ap-eye-dot ap-eye-dot--${i}`} />
        </g>
      ))}

      {/* Audio-only state: three small wave bars inside the ring */}
      {audioOnly && (
        <g className={`ap-eye-wave${audioPlaying ? " ap-eye-wave--playing" : ""}`}>
          <rect x="11.5" y="15" width="2"   height="3"  rx="1" fill="currentColor" className="ap-eye-wave-bar" style={{ animationDelay: "0ms" }} />
          <rect x="15"   y="13" width="2"   height="7"  rx="1" fill="currentColor" className="ap-eye-wave-bar" style={{ animationDelay: "110ms" }} />
          <rect x="18.5" y="15" width="2"   height="3"  rx="1" fill="currentColor" className="ap-eye-wave-bar" style={{ animationDelay: "55ms" }} />
        </g>
      )}

      {/* When agents + audio: ring gets a subtle pulse handled via CSS */}
    </svg>
  );
}

const PinIcon = ({ filled }: { filled: boolean }) => (
  <svg width="9" height="9" viewBox="0 0 9 9"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor" strokeWidth={filled ? 0 : 1} aria-hidden="true">
    <path d="M4.5 0L5.56 2.95L8.56 2.95L6.15 4.77L7.16 7.7L4.5 5.85L1.84 7.7L2.85 4.77L0.44 2.95L3.44 2.95Z"/>
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

  let dotClass = "ap-dot";
  if (session.liveStatus === "running")       dotClass += " ap-dot--running";
  else if (session.liveStatus === "starting") dotClass += " ap-dot--starting";
  else if (session.isPinned)                  dotClass += " ap-dot--pinned";

  return (
    <div className={`ap-agent-row${!session.isActive ? " ap-agent-row--idle" : ""}`}>
      <span className={dotClass} />
      <div className="ap-agent-info">
        <span className="ap-agent-profile">{label}</span>
        {session.isActive && tool
          ? <span className="ap-agent-tool">{tool}</span>
          : title ? <span className="ap-agent-preview">{title}</span>
          : null}
      </div>
      <div className="ap-agent-actions">
        <button
          className={`ap-action-btn ap-pin-btn${session.isPinned ? " ap-pin-btn--active" : ""}`}
          onClick={onTogglePin}
          title={session.isPinned ? "Unpin session" : "Pin session"}
          aria-pressed={session.isPinned}
        >
          <PinIcon filled={session.isPinned} />
        </button>
        <button className="ap-action-btn" onClick={onPeek} title="Open mini view">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
            <rect x="1" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1"/>
            <rect x="6" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1"/>
            <rect x="1" y="6" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1"/>
            <rect x="6" y="6" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1"/>
          </svg>
        </button>
        <button className="ap-action-btn" onClick={onNavigate} title="Open full view">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 5h6M5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
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
    <div className="ap-audio-row">
      <div className="ap-audio-controls">
        <button className="ap-audio-btn" onClick={handleToggle} aria-label={audio.playing ? "pause" : "play"}>
          {audio.playing
            ? <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><rect x="0" y="0" width="2.5" height="10" rx="0.5"/><rect x="5.5" y="0" width="2.5" height="10" rx="0.5"/></svg>
            : <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><path d="M0 0 L8 5 L0 10 Z"/></svg>}
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
          {fmt(audio.currentTime)}<span className="ap-audio-time--total">/{fmt(audio.duration)}</span>
        </span>
      </div>
      {sessionLabel && (
        <div className="ap-audio-meta">
          <span className="ap-audio-label">{sessionLabel}</span>
          <div className="ap-agent-actions">
            {onPeek && (
              <button className="ap-action-btn" onClick={onPeek} title="Open mini view">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                  <rect x="1" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1"/>
                  <rect x="6" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1"/>
                  <rect x="1" y="6" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1"/>
                  <rect x="6" y="6" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1"/>
                </svg>
              </button>
            )}
            {onNavigate && (
              <button className="ap-action-btn" onClick={onNavigate} title="Go to session">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M2 5h6M5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main ──

export function AgentPortal({ sessions, onNavigateSession, onPeekSession }: Props) {
  const audio = useAudioState();
  useStoreRevision();

  const [expanded,  setExpanded]  = useState(() => localStorage.getItem(LS_EXPANDED) === "1");
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(loadPinnedIds);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try { localStorage.setItem(LS_EXPANDED, expanded ? "1" : "0"); } catch {}
  }, [expanded]);

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

  useEffect(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    if (!hasContent && expanded)
      collapseTimer.current = setTimeout(() => setExpanded(false), 2000);
    return () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); };
  }, [hasContent, expanded]);

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      savePinnedIds(next);
      return next;
    });
  }, []);

  if (!hasContent && pinnedIds.size === 0 && !expanded) return null;

  return (
    <>
      <button
        className={[
          "agent-portal-pill",
          expanded ? "agent-portal-pill--open" : "",
          hasAgents ? "agent-portal-pill--agents" : "",
          audio.playing ? "agent-portal-pill--playing" : "",
          pinnedIds.size > 0 && !hasAgents ? "agent-portal-pill--pinned" : "",
        ].filter(Boolean).join(" ")}
        onClick={toggleExpanded}
        title={expanded ? "Hide monitor" : "Show monitor"}
        aria-expanded={expanded}
      >
        <PortalEye agentCount={activeSessions.length} hasAudio={hasAudio} audioPlaying={audio.playing} />
      </button>

      <MiniFloat
        open={expanded}
        storageKey="agent-portal-bounds"
        defaultBounds={{ width: 300, height: 200 }}
        minWidth={220}
        minHeight={80}
        className="agent-portal-window"
      >
        <button className="ap-close" onClick={() => setExpanded(false)} title="Close" aria-label="Close monitor">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
            <path d="M1 1L7 7M7 1L1 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>

        <div className="ap-body">
          {visibleSessions.length > 0 && (
            <div className="ap-section">
              {visibleSessions.map((s) => (
                <AgentRow key={s.id} session={s}
                  onTogglePin={() => togglePin(s.id)}
                  onNavigate={() => { onNavigateSession(s.id); setExpanded(false); }}
                  onPeek={() => onPeekSession(s.id)} />
              ))}
            </div>
          )}
          {hasAudio && (
            <div className={`ap-section ap-section--audio${visibleSessions.length > 0 ? " ap-section--bordered" : ""}`}>
              <AudioRow audio={audio} session={audioSession} pct={pct}
                onNavigate={audioSession ? () => { onNavigateSession(audioSession.id); setExpanded(false); } : undefined}
                onPeek={audioSession ? () => onPeekSession(audioSession.id) : undefined} />
            </div>
          )}
          {!hasContent && <div className="ap-empty">no active agents</div>}
        </div>
      </MiniFloat>
    </>
  );
}
