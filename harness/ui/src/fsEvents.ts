/**
 * Filesystem change events — FileBrowser and FileViewer live refresh.
 *
 * The backend runs one shared watcher. Events arrive on the browser event
 * hub's `fs` channel; the watch root is set with a plain request rather than by
 * reopening a stream, and re-sent whenever the hub reconnects because a
 * restarted backend has forgotten it.
 */

import { API_BASE, authHeaders } from "./modusClient";
import { onHubConnection, onHubEvent } from "./eventHub";

export type FsChangeEvent = {
  dir: string;
  kind: "add" | "remove" | "modify" | "unknown";
  entry: string | null;
};

export type FsEventListener = (event: FsChangeEvent) => void;

let watchRoot: string | null = null;
let stopResync: (() => void) | null = null;

/** Subscribe to filesystem change events. Returns unsubscribe function. */
export function onFsChange(listener: FsEventListener): () => void {
  return onHubEvent("fs", (event) => listener(event as FsChangeEvent));
}

/** Point the shared watcher at a root. No-op if the root hasn't changed. */
export function setFsWatchRoot(root: string | null): void {
  if (root === watchRoot) return;
  watchRoot = root;
  if (!root) return;
  stopResync ??= onHubConnection((connected) => { if (connected) sendWatchRoot(); });
  sendWatchRoot();
}

function sendWatchRoot(): void {
  if (!watchRoot) return;
  let headers: Record<string, string>;
  try { headers = authHeaders(); } catch { return; }
  fetch(`${API_BASE}/api/events/fs/root`, {
    method: "POST",
    headers,
    body: JSON.stringify({ root: watchRoot }),
  }).catch(() => { /* re-sent on the next hub connect */ });
}
