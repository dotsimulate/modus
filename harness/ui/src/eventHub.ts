/**
 * Browser event hub — one SSE connection per tab for every tab-wide channel.
 *
 * Chromium and WebView2 allow six HTTP/1.1 connections per host. Session
 * transcripts already share `/api/events/multi`; session lifecycle, control
 * intents and filesystem changes used to hold a stream each, which left one
 * slot for every ordinary request in the UI. They now share `/api/events/hub`,
 * so a tab holds two long-lived connections instead of five.
 *
 * The connection is reference-counted: it carries exactly the channels that
 * have listeners, reopens (debounced) when that set changes, and closes when it
 * is empty. Events emitted while the stream reopens are not replayed; consumers
 * that need a complete picture refresh on `onHubConnection(true)`.
 */

import { API_BASE, authHeaders } from "./modusClient";

export type HubChannel = "session" | "control" | "fs";
type HubListener = (data: unknown) => void;
type ConnectionListener = (connected: boolean) => void;

const listeners: Record<HubChannel, Set<HubListener>> = {
  session: new Set(),
  control: new Set(),
  fs: new Set(),
};
const connectionListeners = new Set<ConnectionListener>();

const STALE_TIMEOUT_MS = 45_000;  // server pings every 30s
const CONNECT_DEBOUNCE_MS = 40;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let abort: AbortController | null = null;
let openChannels = "";
let connected = false;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_MS;

/** Listen to one hub channel. The stream opens on demand and closes with the last listener. */
export function onHubEvent(channel: HubChannel, listener: HubListener): () => void {
  listeners[channel].add(listener);
  scheduleConnect();
  return () => {
    if (listeners[channel].delete(listener)) scheduleConnect();
  };
}

/** Observe the hub's live state; a `true` after `false` means events may have been missed. */
export function onHubConnection(listener: ConnectionListener): () => void {
  connectionListeners.add(listener);
  return () => { connectionListeners.delete(listener); };
}

/** Replace the stream after browser suspension, when its socket may be dead without an error. */
export function resumeEventHub(): void {
  reconnectDelay = RECONNECT_MIN_MS;
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  if (wantedChannels()) connect();
}

/** Test seam — drops every listener and the stream. */
export function resetEventHub(): void {
  for (const set of Object.values(listeners)) set.clear();
  connectionListeners.clear();
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  reconnectDelay = RECONNECT_MIN_MS;
  closeStream();
}

function wantedChannels(): string {
  return (Object.keys(listeners) as HubChannel[]).filter((channel) => listeners[channel].size > 0).join(",");
}

function setConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  for (const listener of connectionListeners) {
    try { listener(next); } catch { /* one consumer must not break the rest */ }
  }
}

function closeStream(): void {
  abort?.abort();
  abort = null;
  openChannels = "";
  setConnected(false);
}

function scheduleConnect(delay = CONNECT_DEBOUNCE_MS): void {
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    connectTimer = null;
    const wanted = wantedChannels();
    if (!wanted) { closeStream(); return; }
    if (abort && wanted === openChannels) return;
    connect();
  }, delay);
}

function connect(): void {
  // The old socket is released before the new one is requested, so a channel
  // change never briefly needs two of the tab's six connections.
  closeStream();
  const channels = wantedChannels();
  if (!channels) return;

  let headers: Record<string, string>;
  try {
    headers = authHeaders();
  } catch {
    // No credential store in this runtime — there is no stream to open, and
    // retrying would spin.
    return;
  }

  const controller = new AbortController();
  abort = controller;
  openChannels = channels;

  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStale = () => { if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; } };
  const resetStale = () => {
    clearStale();
    staleTimer = setTimeout(() => controller.abort(), STALE_TIMEOUT_MS);
  };
  const finish = () => {
    clearStale();
    if (abort !== controller) return; // superseded or closed on purpose
    abort = null;
    openChannels = "";
    setConnected(false);
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    scheduleConnect(delay);
  };

  // Bound the handshake too: a request queued for a socket has no response yet.
  resetStale();
  fetch(`${API_BASE}/api/events/hub?channels=${encodeURIComponent(channels)}`, {
    signal: controller.signal,
    headers,
  })
    .then(async (res) => {
      const reader = res.ok ? res.body?.getReader() : null;
      if (!reader) { finish(); return; }
      resetStale();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetStale();
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          handleFrame(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf("\n\n");
        }
      }
      finish();
    })
    .catch(() => finish());

  function handleFrame(frame: string): void {
    if (abort !== controller) return;
    let event = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event === "ready") {
      // A stream that connects is a stream that works — a backend restart
      // costs one second, not the last failure's delay.
      reconnectDelay = RECONNECT_MIN_MS;
      setConnected(true);
      return;
    }
    if (event !== "session" && event !== "control" && event !== "fs") return;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    for (const listener of [...listeners[event]]) {
      try { listener(parsed); } catch { /* listener error — don't break others */ }
    }
  }
}
