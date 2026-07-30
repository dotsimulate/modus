import { normalizeBackendUrl, type BackendTarget, type BackendTargetMode } from "./backend-targets";

export { normalizeBackendUrl } from "./backend-targets";
export type { BackendTarget, BackendTargetMode } from "./backend-targets";

type ResolveBackendTargetOptions = {
  search?: string;
  envUrl?: string;
  pageOrigin?: string;
};

export function resolveBackendTarget(options: ResolveBackendTargetOptions = {}): BackendTarget {
  const params = new URLSearchParams(options.search ?? "");
  const queryUrl = params.get("modusTarget") ?? "";
  const apiBase = normalizeBackendUrl(queryUrl || options.envUrl || "");
  const modeParam = params.get("modusTargetMode");
  const mode: BackendTargetMode = modeParam === "managed-local"
    || modeParam === "external-local"
    || modeParam === "remote"
    ? modeParam
    : apiBase
      ? "external-local"
      : "browser";
  const explicitId = params.get("modusTargetId")?.trim();
  const identity = apiBase || options.pageOrigin || "same-origin";

  return {
    id: explicitId || `${mode}:${identity}`,
    label: params.get("modusTargetLabel")?.trim() || (apiBase ? new URL(apiBase).host : "This browser"),
    mode,
    apiBase,
  };
}

export const BACKEND_TARGET = resolveBackendTarget({
  search: typeof location === "undefined" ? "" : location.search,
  envUrl: import.meta.env.VITE_API_URL || "",
  pageOrigin: typeof location === "undefined" ? "" : location.origin,
});

/**
 * Rebind the shared target after the native desktop readiness handshake.
 *
 * Production bundlers may evaluate this module before a dynamic App import, so
 * import timing is not a safe way to wait for Rust to choose the managed port.
 * Mutating the exported object keeps every existing importer on the same live
 * target object.
 */
export function configureBackendTarget(options: ResolveBackendTargetOptions): BackendTarget {
  Object.assign(BACKEND_TARGET, resolveBackendTarget(options));
  return BACKEND_TARGET;
}

export function backendUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${BACKEND_TARGET.apiBase}${normalizedPath}`;
}

/**
 * A backend URL that still means something outside this document.
 *
 * `backendUrl()` is correct for fetching and wrong for sharing: in same-origin
 * browser mode `apiBase` is `""`, so it returns a root-relative path. That
 * resolves fine against the current page and is useless once it leaves — pasted
 * into another browser, handed to the share sheet, or sent to someone else it is
 * just a path with no host.
 *
 * The motivating case is a home-screen web app on iOS, which has no address bar
 * and no tabs, so "open in a new tab" cannot work and copying the link is the
 * only way out. `pageOrigin` is injected rather than read from `location` so
 * this is testable.
 */
export function shareableBackendUrl(path: string, pageOrigin?: string): string {
  const url = backendUrl(path);
  if (/^https?:\/\//i.test(url)) return url;
  const origin = (pageOrigin ?? (typeof location === "undefined" ? "" : location.origin)).replace(/\/+$/, "");
  // With no origin to resolve against, return the relative form unchanged rather
  // than inventing a host — a wrong absolute URL is worse than an honest path.
  return origin ? `${origin}${url}` : url;
}

/** Namespace backend-owned browser state while preserving existing browser keys. */
export function backendStorageKey(key: string): string {
  return BACKEND_TARGET.mode === "browser"
    ? key
    : `${key}:${encodeURIComponent(BACKEND_TARGET.id)}`;
}
