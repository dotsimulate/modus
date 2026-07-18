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

export function backendUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${BACKEND_TARGET.apiBase}${normalizedPath}`;
}

/** Namespace backend-owned browser state while preserving existing browser keys. */
export function backendStorageKey(key: string): string {
  return BACKEND_TARGET.mode === "browser"
    ? key
    : `${key}:${encodeURIComponent(BACKEND_TARGET.id)}`;
}
