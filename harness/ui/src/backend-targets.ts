export type BackendTargetMode = "managed-local" | "external-local" | "remote" | "browser";

export type BackendTarget = {
  id: string;
  label: string;
  mode: BackendTargetMode;
  apiBase: string;
};

export type SavedBackendTarget = {
  id: string;
  label: string;
  mode: "managed-local" | "external-local" | "remote";
  url?: string;
  lastConnectedAt?: string;
  backendId?: string;
};

export type BackendProbe = {
  backendId?: string;
  host?: string;
  instance?: string;
};

export function backendIdentityChanged(expected?: string, actual?: string): boolean {
  // Once a target has been pinned, losing the identity is itself a change.
  // Otherwise a replacement or downgraded backend could bypass the pin simply
  // by omitting its identity from the probe response.
  return !!expected && actual !== expected;
}

const TARGETS_KEY = "modus:backend-targets:v1";
const ACTIVE_TARGET_KEY = "modus:active-backend-target:v1";

export const LOCAL_BACKEND_TARGET: SavedBackendTarget = {
  id: "local",
  label: "Local Modus",
  mode: "managed-local",
};

export const EXTERNAL_LOCAL_BACKEND_TARGET: SavedBackendTarget = {
  id: "external-local",
  label: "Development daemon",
  mode: "external-local",
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

export function normalizeRemoteBackendUrl(value: string): string {
  const origin = normalizeBackendUrl(value);
  if (!origin) throw new Error("Enter the Tailscale HTTPS address for this backend");
  const url = new URL(origin);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("Remote backends must use HTTPS. Use the Tailscale Serve address, not a raw port.");
  }
  return origin;
}

function sanitizeSavedTarget(value: unknown): SavedBackendTarget | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.id === "local") return { ...LOCAL_BACKEND_TARGET };
  if (record.id === "external-local") return { ...EXTERNAL_LOCAL_BACKEND_TARGET };
  if (record.mode !== "remote" || typeof record.url !== "string") return null;
  try {
    const url = normalizeRemoteBackendUrl(record.url);
    return {
      id: `remote:${url}`,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : new URL(url).host,
      mode: "remote",
      url,
      ...(typeof record.lastConnectedAt === "string" ? { lastConnectedAt: record.lastConnectedAt } : {}),
      ...(typeof record.backendId === "string" && record.backendId.trim() ? { backendId: record.backendId } : {}),
    };
  } catch {
    return null;
  }
}

export function loadBackendTargets(storage: Pick<Storage, "getItem"> = localStorage): SavedBackendTarget[] {
  let stored: unknown[] = [];
  try {
    const raw = storage.getItem(TARGETS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) stored = parsed;
  } catch {
    // A malformed client preference must not strand startup.
  }
  const remote = stored
    .map(sanitizeSavedTarget)
    .filter((target): target is SavedBackendTarget => !!target && target.mode === "remote");
  const deduped = new Map(remote.map((target) => [target.id, target]));
  return [LOCAL_BACKEND_TARGET, EXTERNAL_LOCAL_BACKEND_TARGET, ...deduped.values()];
}

function persistBackendTargets(targets: SavedBackendTarget[], storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(TARGETS_KEY, JSON.stringify(targets.filter((target) => target.mode === "remote")));
}

export function getActiveBackendTarget(storage: Pick<Storage, "getItem"> = localStorage): SavedBackendTarget {
  const targets = loadBackendTargets(storage);
  const activeId = storage.getItem(ACTIVE_TARGET_KEY) || "local";
  return targets.find((target) => target.id === activeId) ?? LOCAL_BACKEND_TARGET;
}

export function saveRemoteBackendTarget(
  label: string,
  value: string,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): SavedBackendTarget {
  const url = normalizeRemoteBackendUrl(value);
  const target: SavedBackendTarget = {
    id: `remote:${url}`,
    label: label.trim() || new URL(url).host,
    mode: "remote",
    url,
  };
  const targets = loadBackendTargets(storage);
  const existing = targets.find((candidate) => candidate.id === target.id);
  persistBackendTargets([
    LOCAL_BACKEND_TARGET,
    EXTERNAL_LOCAL_BACKEND_TARGET,
    ...targets.filter((candidate) => candidate.mode === "remote" && candidate.id !== target.id),
    { ...existing, ...target },
  ], storage);
  return { ...existing, ...target };
}

export function rememberBackendConnected(
  target: SavedBackendTarget,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): void {
  storage.setItem(ACTIVE_TARGET_KEY, target.id);
  if (target.id === "local") return;
  const targets = loadBackendTargets(storage);
  persistBackendTargets([
    LOCAL_BACKEND_TARGET,
    EXTERNAL_LOCAL_BACKEND_TARGET,
    ...targets.filter((candidate) => candidate.mode === "remote" && candidate.id !== target.id),
    { ...target, lastConnectedAt: new Date().toISOString() },
  ], storage);
}

export function removeBackendTarget(
  id: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage,
): void {
  if (id === "local" || id === "external-local") return;
  persistBackendTargets(loadBackendTargets(storage).filter((target) => target.id !== id), storage);
  if (storage.getItem(ACTIVE_TARGET_KEY) === id) storage.removeItem(ACTIVE_TARGET_KEY);
}

export function targetSearchParams(target: SavedBackendTarget, currentSearch = ""): URLSearchParams {
  const params = new URLSearchParams(currentSearch);
  for (const name of ["modusDiscover", "modusTarget", "modusTargetId", "modusTargetMode", "modusTargetLabel", "cwd"]) {
    params.delete(name);
  }
  if (target.id === "local") {
    params.set("modusDiscover", "local");
  } else if (target.id === "external-local") {
    params.set("modusDiscover", "external");
  } else {
    params.set("modusTarget", target.url!);
    params.set("modusTargetId", target.id);
    params.set("modusTargetMode", "remote");
    params.set("modusTargetLabel", target.label);
  }
  return params;
}

export function activateBackendTarget(target: SavedBackendTarget): void {
  localStorage.setItem(ACTIVE_TARGET_KEY, target.id);
  const params = targetSearchParams(target, window.location.search);
  const query = params.toString();
  window.location.assign(`${window.location.pathname}${query ? `?${query}` : ""}`);
}

export function isDesktopClient(search = window.location.search, origin = window.location.origin): boolean {
  const params = new URLSearchParams(search);
  return params.has("modusDiscover")
    || params.has("modusTarget")
    || origin === "tauri://localhost"
    || /^https?:\/\/tauri\.localhost$/i.test(origin);
}

export async function probeBackendTarget(url: string, timeoutMs = 4_000): Promise<boolean> {
  return !!await inspectBackendTarget(url, timeoutMs);
}

export async function inspectBackendTarget(url: string, timeoutMs = 4_000): Promise<BackendProbe | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizeBackendUrl(url)}/api/auth/status`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.required !== "boolean" || typeof body.setup !== "boolean") return null;
    const backend = body.backend && typeof body.backend === "object"
      ? body.backend as Record<string, unknown>
      : null;
    return {
      ...(typeof backend?.id === "string" && backend.id.trim() ? { backendId: backend.id } : {}),
      ...(typeof backend?.host === "string" ? { host: backend.host } : {}),
      ...(typeof backend?.instance === "string" ? { instance: backend.instance } : {}),
    };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}
