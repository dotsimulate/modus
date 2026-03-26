import { useEffect, useSyncExternalStore, type MouseEvent } from "react";
import type { SessionArtifact } from "../../../sdk/index";
import * as audioPlayer from "../audio-player";

declare global {
  interface Window {
    __MODUS_AUDIO_ARTIFACT__?: typeof AudioArtifact;
  }
}

function useAudioPlayer() {
  return useSyncExternalStore(audioPlayer.subscribe, audioPlayer.getState);
}

function sessionIdFromUrl(url: string): string | undefined {
  const m = url.match(/\/api\/sessions\/([^/]+)\/artifacts\//);
  return m?.[1];
}

export function AudioArtifact({
  artifact,
  autoPlay = false,
}: {
  artifact: SessionArtifact;
  autoPlay?: boolean;
}) {
  const state = useAudioPlayer();
  const isActive = state.activeId === artifact.id;
  const playing = isActive && state.playing;
  const error = isActive ? state.error : null;
  const currentTime = isActive ? state.currentTime : 0;
  const duration = isActive ? state.duration : 0;
  const sid = sessionIdFromUrl(artifact.url);

  useEffect(() => {
    if (autoPlay) audioPlayer.autoPlay(artifact.id, artifact.url, sid);
  }, [autoPlay, artifact.id, artifact.url, sid]);

  function fmt(s: number) {
    if (!s || !isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  function handleToggle() {
    audioPlayer.toggle(artifact.id, artifact.url, sid);
  }

  function handleSeek(e: MouseEvent<HTMLDivElement>) {
    if (!isActive || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    audioPlayer.seek(((e.clientX - rect.left) / rect.width) * duration);
  }

  const pct = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div className="audio-artifact" title={artifact.name}>
      <div className="audio-artifact-player">
        <button className="audio-artifact-btn" onClick={handleToggle} aria-label={playing ? "pause" : "play"}>
          {playing ? (
            <svg width="7" height="8" viewBox="0 0 7 8" fill="currentColor">
              <rect x="0" y="0" width="2" height="8" rx="0.5"/>
              <rect x="5" y="0" width="2" height="8" rx="0.5"/>
            </svg>
          ) : (
            <svg width="7" height="8" viewBox="0 0 7 8" fill="currentColor">
              <path d="M0 0 L7 4 L0 8 Z"/>
            </svg>
          )}
        </button>
        <div className="audio-artifact-track" onClick={handleSeek}>
          <div className="audio-artifact-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="audio-artifact-time">{fmt(currentTime)}<span className="audio-artifact-time--total">/{fmt(duration)}</span></div>
      </div>
      {error && <div className="audio-artifact-error">{error}</div>}
    </div>
  );
}

if (typeof window !== "undefined") {
  window.__MODUS_AUDIO_ARTIFACT__ = AudioArtifact;
}
