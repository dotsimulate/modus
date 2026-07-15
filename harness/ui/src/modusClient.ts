/**
 * Frontend singleton for ModusClient.
 *
 * Reads the auth token from localStorage (same key the old api/_fetch.ts used)
 * and exposes helpers for URL construction that some components need.
 */

import { ModusClient } from "../../sdk/index";
import { BACKEND_TARGET } from "./backendTarget";

const STORAGE_KEY = BACKEND_TARGET.mode === "browser"
  ? "harness_token"
  : `harness_token:${encodeURIComponent(BACKEND_TARGET.id)}`;

function getStoredToken(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

/** The shared ModusClient instance for all UI code. */
export const modus = new ModusClient({
  url: BACKEND_TARGET.apiBase,
  getToken: () => getStoredToken() || undefined,
});

// ── Helpers for URL-construction (image srcs, WebSocket URLs, etc.) ──

/** Base URL for the harness API (empty string = same origin). */
export const API_BASE: string = BACKEND_TARGET.apiBase;

/** Current auth token (reads live from localStorage). */
export function getAuthToken(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

/** Returns `token=...` or `""` — for use in URL query strings. */
export function tokenParam(): string {
  const t = getAuthToken();
  return t ? `token=${t}` : "";
}

/** Returns headers object with Authorization bearer if token exists. */
export function authHeaders(): Record<string, string> {
  const t = getAuthToken();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
}

/** Update the stored token (called after auth flows). */
export function setAuthToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
  // Re-create client internals would require a new instance — for now
  // the SDK reads the token we passed at construction. Auth flows that
  // change the token should reload the page.
}

/** Clear stored token. */
export function clearAuthToken(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ── Callback-based SSE (used by sessionStore) ──

export type EventStreamCallbacks = {
  onEvent: (event: any, seq: number) => void;
  onEventBatch?: (events: { event: string; data: any; seq: number }[]) => void;
  onDone: () => void;
  onDisconnect?: () => void;
  onError: (error: string) => void;
};

/**
 * Subscribe to session events using a callback-based interface.
 * Returns an unsubscribe function. This wraps the raw fetch SSE stream
 * to match the interface sessionStore expects.
 *
 * Read timeout: if no data (including server pings every 30s) arrives
 * within STALE_TIMEOUT_MS, the connection is considered dead and we
 * fire onDisconnect so the caller can reconnect.
 */
const STALE_TIMEOUT_MS = 45_000; // server pings every 30s — 45s means we missed at least one

export function subscribeEvents(
  sessionId: string,
  afterSeq: number,
  callbacks: EventStreamCallbacks,
): () => void {
  const abort = new AbortController();
  const params = `after=${afterSeq}`;
  const url = `${API_BASE}/api/sessions/${sessionId}/events?${params}`;

  let doneFired = false;
  let gotServerDone = false;
  const fireDone = () => {
    if (doneFired) return;
    doneFired = true;
    if (gotServerDone) {
      callbacks.onDone();
    } else {
      (callbacks.onDisconnect ?? callbacks.onDone)();
    }
  };

  // Stale-connection watchdog — resets on every chunk from the server
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetStaleTimer = () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      // No data for STALE_TIMEOUT_MS — connection is dead
      abort.abort();
      fireDone(); // triggers onDisconnect → reconnect
    }, STALE_TIMEOUT_MS);
  };
  const clearStaleTimer = () => {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
  };

  fetch(url, { signal: abort.signal, headers: authHeaders() })
    .then(async (res) => {
      if (!res.ok) {
        callbacks.onError(`Event stream failed: ${res.statusText}`);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) { callbacks.onError("No response body"); return; }

      const decoder = new TextDecoder();
      let buffer = "";
      let catchupBuffer: { event: string; data: any; seq: number }[] | null = null;

      resetStaleTimer(); // start the watchdog

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetStaleTimer(); // got data — connection is alive

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        let currentId = "0";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("id: ")) {
            currentId = line.slice(4).trim();
          } else if (line.startsWith("data: ")) {
            if (currentEvent === "done") {
              gotServerDone = true;
              clearStaleTimer();
              fireDone();
            } else if (currentEvent === "ping") {
              // Server keepalive — already reset the stale timer above, skip reducer
            } else if (currentEvent === "catchup-start") {
              catchupBuffer = [];
            } else if (currentEvent === "catchup-end" && catchupBuffer) {
              if (callbacks.onEventBatch) {
                callbacks.onEventBatch(catchupBuffer);
              } else {
                // Fallback: apply individually if no batch handler
                for (const evt of catchupBuffer) callbacks.onEvent(evt.data, evt.seq);
              }
              catchupBuffer = null;
            } else {
              try {
                const parsed = JSON.parse(line.slice(6));
                if (catchupBuffer) {
                  // Buffering during catch-up — collect, don't dispatch yet
                  catchupBuffer.push({ event: currentEvent, data: parsed, seq: Number(currentId) || 0 });
                } else {
                  callbacks.onEvent(parsed, Number(currentId) || 0);
                }
              } catch { /* skip malformed */ }
            }
          }
        }
      }
      clearStaleTimer();
      fireDone();
    })
    .catch((err) => {
      clearStaleTimer();
      if (err.name === "AbortError") return;
      // Network errors (TCP reset, Tailscale drop, etc.) should reconnect,
      // not permanently fail. Only use onError for non-recoverable API errors.
      fireDone(); // triggers onDisconnect → reconnect
    });

  return () => { clearStaleTimer(); abort.abort(); };
}

// ── Filesystem change events (browser-only EventSource) ──

export type FsChangeEvent = {
  dir: string;
  kind: "add" | "remove" | "modify" | "unknown";
  entry: string | null;
};

export type FsEventListener = (event: FsChangeEvent) => void;

const fsListeners = new Set<FsEventListener>();
let fsEventSource: EventSource | null = null;
let fsCurrentRoot: string | null = null;

function fsConnect(root: string) {
  if (fsEventSource) { fsEventSource.close(); fsEventSource = null; }
  fsCurrentRoot = root;

  const tp = tokenParam();
  const params = new URLSearchParams();
  params.set("root", root);
  if (tp) params.set("token", tp.split("=")[1]);

  const url = `${API_BASE}/api/events/fs?${params}`;
  const es = new EventSource(url);

  es.addEventListener("fs", (e) => {
    try {
      const data: FsChangeEvent = JSON.parse(e.data);
      for (const listener of fsListeners) {
        try { listener(data); } catch { /* listener error — don't break others */ }
      }
    } catch { /* malformed event */ }
  });

  es.onerror = () => {
    // EventSource auto-reconnects — no action needed
  };

  fsEventSource = es;
}

/** Subscribe to filesystem change events. Returns unsubscribe function. */
export function onFsChange(listener: FsEventListener): () => void {
  fsListeners.add(listener);
  return () => { fsListeners.delete(listener); };
}

/** Set the watch root and (re)connect. No-op if root hasn't changed. */
export function setFsWatchRoot(root: string | null) {
  if (!root) {
    if (fsEventSource) { fsEventSource.close(); fsEventSource = null; }
    fsCurrentRoot = null;
    return;
  }
  if (root === fsCurrentRoot && fsEventSource) return;
  fsConnect(root);
}

/** Disconnect and clean up. */
export function disconnectFsEvents() {
  if (fsEventSource) { fsEventSource.close(); fsEventSource = null; }
  fsCurrentRoot = null;
}
