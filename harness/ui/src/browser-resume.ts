export type BrowserResumeTarget = {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
};

export type BrowserResumeDocument = BrowserResumeTarget & {
  visibilityState?: DocumentVisibilityState;
};

export type BrowserResumeOptions = {
  windowTarget?: BrowserResumeTarget | null;
  documentTarget?: BrowserResumeDocument | null;
  now?: () => number;
  dedupeMs?: number;
};

const DEFAULT_DEDUPE_MS = 500;

/**
 * Notify long-lived connections when a browser returns from suspension.
 *
 * Mobile browsers can freeze timers and preserve a dead fetch without firing
 * its error path. Visibility, page-cache restore, focus, and network recovery
 * are therefore treated as one coalesced resume signal.
 */
export function subscribeBrowserResume(
  onResume: () => void,
  options: BrowserResumeOptions = {},
): () => void {
  const windowTarget = options.windowTarget
    ?? (typeof window === "undefined" ? null : window as unknown as BrowserResumeTarget);
  const documentTarget = options.documentTarget
    ?? (typeof document === "undefined" ? null : document as unknown as BrowserResumeDocument);
  if (!windowTarget || !documentTarget) return () => {};

  const now = options.now ?? Date.now;
  const dedupeMs = options.dedupeMs ?? DEFAULT_DEDUPE_MS;
  let lastResumeAt = Number.NEGATIVE_INFINITY;
  const signal: EventListener = () => {
    if (documentTarget.visibilityState === "hidden") return;
    const at = now();
    if (at - lastResumeAt < dedupeMs) return;
    lastResumeAt = at;
    onResume();
  };

  documentTarget.addEventListener("visibilitychange", signal);
  windowTarget.addEventListener("pageshow", signal);
  windowTarget.addEventListener("focus", signal);
  windowTarget.addEventListener("online", signal);

  return () => {
    documentTarget.removeEventListener("visibilitychange", signal);
    windowTarget.removeEventListener("pageshow", signal);
    windowTarget.removeEventListener("focus", signal);
    windowTarget.removeEventListener("online", signal);
  };
}
