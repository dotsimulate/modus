export type BackendTargetMode = "managed-local" | "external-local" | "remote" | "browser";

export type BackendTarget = {
  id: string;
  label: string;
  mode: BackendTargetMode;
  apiBase: string;
};

type ResolveBackendTargetOptions = {
  search?: string;
  envUrl?: string;
  pageOrigin?: string;
};

export function normalizeBackendUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate) return "";
  const url = new URL(candidate);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Backend target must be an HTTP(S) origin without embedded credentials");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("Backend target must be an origin without a path, query, or fragment");
  }
  return url.origin;
}

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
  const identity = apiBase || options.pageOrigin || "same-origin";

  return {
    id: `${mode}:${identity}`,
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
