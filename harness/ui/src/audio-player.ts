/**
 * Singleton audio player service.
 *
 * Owns a single <audio> element attached to document.body so playback
 * survives React unmount/remount cycles and page navigation.  Components
 * subscribe to state changes and render a thin UI on top.
 */

import { getAuthToken } from "./modusClient";
import { backendUrl } from "./backendTarget";

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
  /** Last playback error message (cleared on successful play) */
  error: string | null;
};

type Listener = (state: PlaybackState) => void;

declare global {
  interface Window {
    __MODUS_AUDIO_PLAYER__?: {
      play: typeof play;
      autoPlay: typeof autoPlay;
      toggle: typeof toggle;
      seek: typeof seek;
      stop: typeof stop;
      hasPlayed: typeof hasPlayed;
      getState: typeof getState;
      subscribe: typeof subscribe;
    };
  }
}

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
  error: null,
};

// Mobile unlock: some browsers require a user-gesture play() before
// programmatic playback works.  We listen for the first touchstart/click
// and silently play+pause an empty source to unlock the element.
let _unlocked = false;
function unlockAudio() {
  if (_unlocked) return;
  _unlocked = true;
  const el = ensureElement();
  // Play a tiny silent buffer to unlock the audio element on iOS/Android
  el.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
  const p = el.play();
  if (p) p.then(() => { el.pause(); el.removeAttribute("src"); }).catch(() => {});
  document.removeEventListener("touchstart", unlockAudio, true);
  document.removeEventListener("click", unlockAudio, true);
}
if (typeof document !== "undefined") {
  document.addEventListener("touchstart", unlockAudio, { capture: true, once: true });
  document.addEventListener("click", unlockAudio, { capture: true, once: true });
}
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
  el.addEventListener("ended", () => { revokeBlobUrl(); update({ activeId: null, src: null, sessionId: null, playing: false, currentTime: 0, duration: 0, error: null }); });
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
  el.addEventListener("error", () => {
    const e = el.error;
    const codeNames: Record<number, string> = {
      1: "MEDIA_ERR_ABORTED",
      2: "MEDIA_ERR_NETWORK",
      3: "MEDIA_ERR_DECODE",
      4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
    };
    const codeName = e ? (codeNames[e.code] || `code ${e.code}`) : "unknown";
    const ct = el.dataset.contentType || "unknown";
    const msg = e
      ? `${codeName}: ${e.message || "media error"} (type: ${ct})`
      : "unknown audio error";
    console.error("[audio-player] element error:", msg, "src:", el.src);
    update({ playing: false, error: msg });
  });

  _el = el;
  return el;
}

/**
 * Absolute URL for an artifact.
 *
 * Artifact urls are root-relative, so under the desktop shell they resolve
 * against tauri.localhost rather than the backend and return the SPA's
 * index.html — which is what surfaced as "bad content-type: text/html" instead
 * of playback. backendUrl() is a no-op when apiBase is "" (same-origin browser).
 */
export function resolveUrl(url: string): string {
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;
  return backendUrl(url);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function handlePlayError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[audio-player] play failed:", msg);
  update({ playing: false, error: msg });
}

/** Revoke the previous blob URL if any. */
let _blobUrl: string | null = null;
function revokeBlobUrl() {
  if (_blobUrl) { URL.revokeObjectURL(_blobUrl); _blobUrl = null; }
}

/** Play an artifact. If it's already playing, this is a no-op. */
export function play(id: number, url: string, sessionId?: string) {
  const el = ensureElement();
  if (_state.activeId === id && _state.src === url) {
    if (el.paused) el.play().then(() => update({ error: null })).catch(handlePlayError);
    return;
  }
  const src = resolveUrl(url);
  update({ activeId: id, src: url, sessionId: sessionId ?? null, currentTime: 0, duration: 0, playing: false, error: null });
  _played.add(id);
  savePlayed(_played);

  // Fetch audio with a bearer header, then give the element a blob URL.
  // The element cannot set headers, and a token in the request URL would
  // also reach browser, proxy, and backend URL logs.
  revokeBlobUrl();
  const token = getAuthToken();
  fetch(src, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const ct = res.headers.get("content-type") || "";
      if (!ct.startsWith("audio/")) throw new Error(`bad content-type: ${ct}`);
      return res.blob();
    })
    .then((blob) => {
      // The element's error handler reports this back. It was read there and
      // never written, so every decode failure said "(type: unknown)" — the one
      // detail that identifies a wrong or unsupported format.
      el.dataset.contentType = blob.type || "unknown";
      _blobUrl = URL.createObjectURL(blob);
      el.src = _blobUrl;
      return el.play();
    })
    .then(() => update({ error: null }))
    .catch(handlePlayError);
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
    if (el.paused) el.play().then(() => update({ error: null })).catch(handlePlayError);
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
  // The `ended` handler revokes; stopping by hand has to as well, or the blob
  // stays resident for the life of the document.
  revokeBlobUrl();
  update({ activeId: null, src: null, sessionId: null, playing: false, currentTime: 0, duration: 0, error: null });
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

if (typeof window !== "undefined") {
  window.__MODUS_AUDIO_PLAYER__ = {
    play,
    autoPlay,
    toggle,
    seek,
    stop,
    hasPlayed,
    getState,
    subscribe,
  };
}
