export type DesktopBootstrapMode = "managed-local" | "external-local" | "remote";

export type DesktopTailscaleStatus = {
  enabled: boolean;
  state: "disabled" | "enabled" | "active" | "unavailable" | "blocked" | "error";
  url?: string;
  message?: string;
  targetPort?: number;
  pinConfigured: boolean;
};

export type DesktopBootstrapResponse = {
  mode: DesktopBootstrapMode;
  apiBase: string;
  targetId: string;
  label: string;
  token?: string;
  instanceId?: string;
  version: string;
  backendPid?: number;
  port?: number;
  tailscale?: DesktopTailscaleStatus;
};

type TauriInternals = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
    __TAURI__?: { core?: TauriInternals };
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && (
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
    || typeof window.__TAURI__?.core?.invoke === "function"
  );
}

async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<T>(command, args);
  }
  if (window.__TAURI__?.core?.invoke) {
    return window.__TAURI__.core.invoke<T>(command, args);
  }
  throw new Error("The Modus desktop lifecycle bridge is unavailable");
}

export async function bootstrapDesktop(
  mode: DesktopBootstrapMode,
  url?: string,
): Promise<DesktopBootstrapResponse> {
  return invokeDesktop<DesktopBootstrapResponse>("desktop_bootstrap", {
    request: { mode, ...(url ? { url } : {}) },
  });
}

/** Install and prove the supervisor-provided credential. The token never
 * appears in the URL or normal backend logs. */
export async function bindManagedDesktopTarget(response: DesktopBootstrapResponse): Promise<void> {
  if (response.mode !== "managed-local" || !response.token || !response.instanceId || !response.port) {
    throw new Error("Managed backend bootstrap returned an incomplete identity or credential");
  }
  const storageKey = `harness_token:${encodeURIComponent(response.targetId)}`;
  localStorage.setItem(storageKey, response.token);
  const verification = await fetch(`${response.apiBase}/api/auth/check`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${response.token}` },
  });
  if (!verification.ok) {
    localStorage.removeItem(storageKey);
    throw new Error(`Managed backend rejected its desktop credential (${verification.status})`);
  }
}

/** Acknowledge only after the configured SDK has independently authenticated. */
export async function acknowledgeManagedDesktopTarget(response: DesktopBootstrapResponse): Promise<void> {
  if (response.mode !== "managed-local" || !response.instanceId || !response.port) {
    throw new Error("Cannot acknowledge an incomplete managed backend identity");
  }
  await invokeDesktop<void>("desktop_ui_connected", {
    request: { backendId: response.instanceId, port: response.port },
  });
}

export async function quitDesktopModus(): Promise<void> {
  await invokeDesktop<void>("quit_modus");
}

export async function getDesktopTailscaleStatus(): Promise<DesktopTailscaleStatus> {
  return invokeDesktop<DesktopTailscaleStatus>("desktop_tailscale_status");
}

export async function setDesktopTailscaleEnabled(enabled: boolean): Promise<DesktopTailscaleStatus> {
  return invokeDesktop<DesktopTailscaleStatus>("desktop_set_tailscale_enabled", { enabled });
}
