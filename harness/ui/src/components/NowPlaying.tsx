import { useSyncExternalStore, useCallback } from "react";
import * as audioPlayer from "../audio-player";

function useAudioState() {
  return useSyncExternalStore(audioPlayer.subscribe, audioPlayer.getState);
}

type Props = {
  onNavigateSession?: (sessionId: string) => void;
};

export function NowPlaying({ onNavigateSession }: Props) {
  const state = useAudioState();

  const handleClick = useCallback(() => {
    if (state.sessionId && onNavigateSession) {
      onNavigateSession(state.sessionId);
    }
  }, [state.sessionId, onNavigateSession]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (state.activeId != null && state.src) {
      audioPlayer.toggle(state.activeId, state.src, state.sessionId ?? undefined);
    }
  }, [state.activeId, state.src, state.sessionId]);

  // Only render when there's an active track
  if (state.activeId == null) return null;

  const pct = state.duration ? (state.currentTime / state.duration) * 100 : 0;

  return (
    <div
      className={`now-playing${state.playing ? " now-playing--active" : ""}`}
      onClick={handleClick}
      title={state.sessionId ? "Go to session" : undefined}
    >
      <button className="now-playing-toggle" onClick={handleToggle} aria-label={state.playing ? "pause" : "play"}>
        {state.playing ? (
          <svg width="6" height="7" viewBox="0 0 6 7" fill="currentColor">
            <rect x="0" y="0" width="2" height="7" rx="0.5"/>
            <rect x="4" y="0" width="2" height="7" rx="0.5"/>
          </svg>
        ) : (
          <svg width="6" height="7" viewBox="0 0 6 7" fill="currentColor">
            <path d="M0 0 L6 3.5 L0 7 Z"/>
          </svg>
        )}
      </button>
      {state.playing && (
        <div className="now-playing-viz">
          <span className="now-playing-bar" style={{ animationDelay: "0ms" }} />
          <span className="now-playing-bar" style={{ animationDelay: "150ms" }} />
          <span className="now-playing-bar" style={{ animationDelay: "75ms" }} />
        </div>
      )}
      <div className="now-playing-track">
        <div className="now-playing-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
