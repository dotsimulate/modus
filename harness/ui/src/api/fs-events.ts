/**
 * fs-events — EventSource client for filesystem change notifications.
 *
 * Connects to /api/events/fs SSE endpoint. Emits FsChangeEvent objects
 * to registered listeners. Auto-reconnects on disconnect.
 */

import { API_BASE, tokenParam } from "./_fetch";

export type FsChangeEvent = {
  dir: string;
  kind: "add" | "remove" | "modify" | "unknown";
  entry: string | null;
};

export type FsEventListener = (event: FsChangeEvent) => void;

const listeners = new Set<FsEventListener>();
let eventSource: EventSource | null = null;
let currentRoot: string | null = null;

function connect(root: string) {
  if (eventSource) { eventSource.close(); eventSource = null; }
  currentRoot = root;

  const tp = tokenParam();
  const params = new URLSearchParams();
  params.set("root", root);
  if (tp) params.set("token", tp.split("=")[1]);

  const url = `${API_BASE}/api/events/fs?${params}`;
  const es = new EventSource(url);

  es.addEventListener("fs", (e) => {
    try {
      const data: FsChangeEvent = JSON.parse(e.data);
      for (const listener of listeners) {
        try { listener(data); } catch { /* listener error — don't break others */ }
      }
    } catch { /* malformed event */ }
  });

  es.onerror = () => {
    // EventSource auto-reconnects — no action needed
  };

  eventSource = es;
}

/**
 * Subscribe to filesystem change events. Starts the SSE connection
 * on first subscriber if a root has been set.
 */
export function onFsChange(listener: FsEventListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Set the watch root and (re)connect. Call when activeCwd changes.
 * No-op if root hasn't changed.
 */
export function setFsWatchRoot(root: string | null) {
  if (!root) {
    if (eventSource) { eventSource.close(); eventSource = null; }
    currentRoot = null;
    return;
  }
  if (root === currentRoot && eventSource) return;
  connect(root);
}

/** Disconnect and clean up. */
export function disconnectFsEvents() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  currentRoot = null;
}
