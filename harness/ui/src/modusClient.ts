/**
 * Frontend singleton for ModusClient.
 *
 * Reads the auth token from localStorage (same key the old api/_fetch.ts used)
 * and exposes helpers for URL construction that some components need.
 */

import { ModusClient } from "../../sdk/index";

const STORAGE_KEY = "harness_token";

function getStoredToken(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

/** The shared ModusClient instance for all UI code. */
export const modus = new ModusClient({
  url: import.meta.env.VITE_API_URL || "",
  getToken: () => getStoredToken() || undefined,
});

// ── Helpers for URL-construction (image srcs, WebSocket URLs, etc.) ──

/** Base URL for the harness API (empty string = same origin). */
export const API_BASE: string = import.meta.env.VITE_API_URL || "";

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
  onDone: () => void;
  onDisconnect?: () => void;
  onError: (error: string) => void;
};

/**
 * Subscribe to session events using a callback-based interface.
 * Returns an unsubscribe function. This wraps the raw fetch SSE stream
 * to match the interface sessionStore expects.
 */
export function subscribeEvents(
  sessionId: string,
  afterSeq: number,
  callbacks: EventStreamCallbacks,
): () => void {
  const abort = new AbortController();
  const tp = tokenParam();
  const params = [`after=${afterSeq}`, tp].filter(Boolean).join("&");
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

  fetch(url, { signal: abort.signal })
    .then(async (res) => {
      if (!res.ok) {
        callbacks.onError(`Event stream failed: ${res.statusText}`);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) { callbacks.onError("No response body"); return; }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

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
              fireDone();
            } else {
              try {
                const parsed = JSON.parse(line.slice(6));
                callbacks.onEvent(parsed, Number(currentId) || 0);
              } catch { /* skip */ }
            }
          }
        }
      }
      fireDone();
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        callbacks.onError(String(err));
      }
    });

  return () => abort.abort();
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
