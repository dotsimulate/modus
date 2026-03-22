/**
 * fs-watcher — lightweight project-scoped filesystem watcher.
 *
 * Watches a single directory tree (the active project cwd) using recursive fs.watch.
 * Debounces per-directory and emits normalized change events to SSE subscribers.
 *
 * Security: only watches paths within the explicitly set root directory.
 */

import { watch as fsWatch, type FSWatcher } from "fs";
import { resolve, dirname, basename, relative } from "path";

// ── Types ──

export type FsChangeEvent = {
  /** Absolute path of the directory that changed */
  dir: string;
  /** What happened */
  kind: "add" | "remove" | "modify" | "unknown";
  /** Name of the file/folder that changed (if known) */
  entry: string | null;
};

export type FsSubscriber = {
  write(event: FsChangeEvent): void;
  close(): void;
};

// ── Exclusions ──

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".cache", ".parcel-cache", ".turbo",
  "target", // rust
  ".DS_Store",
]);

function shouldExclude(name: string): boolean {
  return EXCLUDE_DIRS.has(name) || name.startsWith(".cache");
}

// ── State ──

let watcher: FSWatcher | null = null;
let watchRoot: string | null = null;
const subscribers = new Set<FsSubscriber>();

// Debounce timers per-directory
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 300;

// Rate limiting — max events per second across all dirs
let eventCount = 0;
let rateLimitWindow: ReturnType<typeof setInterval> | null = null;
const MAX_EVENTS_PER_SEC = 15;

function startRateLimitWindow() {
  if (rateLimitWindow) return;
  rateLimitWindow = setInterval(() => { eventCount = 0; }, 1000);
}

function stopRateLimitWindow() {
  if (rateLimitWindow) { clearInterval(rateLimitWindow); rateLimitWindow = null; }
  eventCount = 0;
}

// ── Core ──

function emit(event: FsChangeEvent) {
  if (eventCount >= MAX_EVENTS_PER_SEC) return; // drop during bursts
  eventCount++;
  for (const sub of subscribers) {
    try { sub.write(event); } catch { subscribers.delete(sub); }
  }
}

function handleFsEvent(_eventType: string, filename: string | null) {
  if (!filename || !watchRoot) return;

  // filename from recursive watch is relative to the watch root
  const parts = filename.replace(/\\/g, "/").split("/");

  // Check if any path segment is excluded
  for (const part of parts) {
    if (shouldExclude(part)) return;
  }

  const fullPath = resolve(watchRoot, filename);
  const dir = parts.length > 1 ? resolve(watchRoot, parts.slice(0, -1).join("/")) : watchRoot;
  const entry = parts[parts.length - 1] || null;

  // Debounce per-directory
  const existing = debounceTimers.get(dir);
  if (existing) clearTimeout(existing);

  debounceTimers.set(dir, setTimeout(() => {
    debounceTimers.delete(dir);
    emit({ dir, kind: "unknown", entry });
  }, DEBOUNCE_MS));
}

/**
 * Start watching a directory tree. Replaces any existing watch.
 * Safe to call repeatedly — will only restart if root changes.
 */
export function startWatching(rootPath: string): void {
  const root = resolve(rootPath);
  if (watcher && watchRoot === root) return; // already watching this root

  stopWatching();
  watchRoot = root;

  try {
    watcher = fsWatch(root, { recursive: true }, handleFsEvent);
    watcher.on("error", (err) => {
      // Log but don't crash — watcher may fail on permission errors
      console.warn("[fs-watcher] error:", err.message);
    });
    startRateLimitWindow();
  } catch (err: any) {
    console.warn("[fs-watcher] failed to start:", err.message);
    watcher = null;
    watchRoot = null;
  }
}

/** Stop watching. Idempotent. */
export function stopWatching(): void {
  if (watcher) {
    try { watcher.close(); } catch { /* best effort */ }
    watcher = null;
  }
  watchRoot = null;
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  stopRateLimitWindow();
}

/** Subscribe to fs change events. Returns unsubscribe function. */
export function subscribeFsEvents(sub: FsSubscriber): () => void {
  subscribers.add(sub);
  return () => { subscribers.delete(sub); };
}

/** Get the currently watched root, or null if not watching. */
export function getWatchRoot(): string | null {
  return watchRoot;
}

/** Number of active subscribers (for health/debug). */
export function subscriberCount(): number {
  return subscribers.size;
}
