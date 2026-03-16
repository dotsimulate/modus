/**
 * Singleton audio player service.
 *
 * Owns a single <audio> element attached to document.body so playback
 * survives React unmount/remount cycles and page navigation.  Components
 * subscribe to state changes and render a thin UI on top.
 */

import { tokenParam } from "./api/_fetch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlaybackState = {
  /** Artifact ID currently loaded (null = idle) */
  activeId: number | null;
  /** Source URL of the active track */
  src: string | null;
  /** Session that owns this artifact */
  sessionId: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
};

type Listener = (state: PlaybackState) => void;

// ---------------------------------------------------------------------------
// Played-tracking (persisted in sessionStorage)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "harness:played-artifacts";

function loadPlayed(): Set<number> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function savePlayed(set: Set<number>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {}
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _el: HTMLAudioElement | null = null;
let _state: PlaybackState = {
  activeId: null,
  src: null,
  sessionId: null,
  playing: false,
  currentTime: 0,
  duration: 0,
};
const _listeners = new Set<Listener>();
const _played = loadPlayed();

function emit() {
  for (const fn of _listeners) fn(_state);
}

function update(patch: Partial<PlaybackState>) {
  _state = { ..._state, ...patch };
  emit();
}

function ensureElement(): HTMLAudioElement {
  if (_el) return _el;
  const el = document.createElement("audio");
  el.preload = "auto";
  el.style.display = "none";
  document.body.appendChild(el);

  el.addEventListener("play", () => update({ playing: true }));
  el.addEventListener("pause", () => update({ playing: false }));
  el.addEventListener("ended", () => update({ activeId: null, src: null, sessionId: null, playing: false, currentTime: 0, duration: 0 }));
  el.addEventListener("timeupdate", () =>
    update({ currentTime: el.currentTime }),
  );
  el.addEventListener("loadedmetadata", () => {
    const d = el.duration;
    if (isFinite(d) && d > 0) update({ duration: d });
  });
  el.addEventListener("durationchange", () => {
    const d = el.duration;
    if (isFinite(d) && d > 0) update({ duration: d });
  });

  _el = el;
  return el;
}

function resolveUrl(url: string): string {
  const tp = tokenParam();
  return tp ? `${url}?${tp}` : url;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Play an artifact. If it's already playing, this is a no-op. */
export function play(id: number, url: string, sessionId?: string) {
  const el = ensureElement();
  if (_state.activeId === id && _state.src === url) {
    if (el.paused) el.play().catch(() => {});
    return;
  }
  const src = resolveUrl(url);
  el.src = src;
  update({ activeId: id, src: url, sessionId: sessionId ?? null, currentTime: 0, duration: 0, playing: false });
  _played.add(id);
  savePlayed(_played);
  el.play().catch(() => {});
}

/** Auto-play an artifact only if it hasn't been played yet this session. */
export function autoPlay(id: number, url: string, sessionId?: string) {
  if (_played.has(id)) return;
  play(id, url, sessionId);
}

/** Toggle play/pause for the given artifact. If a different track is active, starts this one. */
export function toggle(id: number, url: string, sessionId?: string) {
  const el = ensureElement();
  if (_state.activeId === id) {
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  } else {
    play(id, url, sessionId);
  }
}

/** Seek within the currently active track. */
export function seek(time: number) {
  const el = ensureElement();
  el.currentTime = time;
}

/** Stop playback and unload. */
export function stop() {
  if (!_el) return;
  _el.pause();
  _el.removeAttribute("src");
  _el.load();
  update({ activeId: null, src: null, sessionId: null, playing: false, currentTime: 0, duration: 0 });
}

/** Check if an artifact has already been played this session. */
export function hasPlayed(id: number): boolean {
  return _played.has(id);
}

/** Get current state snapshot. */
export function getState(): PlaybackState {
  return _state;
}

/** Subscribe to state changes. Returns unsubscribe function. */
export function subscribe(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
