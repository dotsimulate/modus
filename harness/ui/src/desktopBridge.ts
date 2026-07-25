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

export type DesktopUpdateCheck = {
  configured: boolean;
  available: boolean;
  version?: string | null;
  currentVersion: string;
  notes?: string | null;
  date?: string | null;
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

/**
 * Prove the supervisor-provided credential, then store a bounded session token.
 *
 * The stored credential is what the UI later splices into media and EventSource
 * URLs, which cannot carry an Authorization header. Persisting the supervisor
 * bearer there would put a non-revocable, full-authority credential into copied
 * links, browser history, and proxy logs, so it is exchanged for a revocable
 * browser-session token and never written to storage itself.
 */
export async function bindManagedDesktopTarget(response: DesktopBootstrapResponse): Promise<void> {
  if (response.mode !== "managed-local" || !response.token || !response.instanceId || !response.port) {
    throw new Error("Managed backend bootstrap returned an incomplete identity or credential");
  }
  const storageKey = `harness_token:${encodeURIComponent(response.targetId)}`;
  const verification = await fetch(`${response.apiBase}/api/auth/check`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${response.token}` },
  });
  if (!verification.ok) {
    throw new Error(`Managed backend rejected its desktop credential (${verification.status})`);
  }

  let stored = response.token;
  try {
    const exchange = await fetch(`${response.apiBase}/api/auth/exchange`, {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${response.token}` },
    });
    if (exchange.ok) {
      const minted = (await exchange.json())?.token;
      if (typeof minted === "string" && minted) stored = minted;
    }
  } catch {
    // Fall through to the supervisor credential below.
  }
  if (stored === response.token) {
    // Availability is preserved, but URL-carried resources will not authenticate
    // because a supervisor bearer is not accepted from a query string.
    console.warn("[desktop] session-token exchange unavailable; media and event URLs may not authenticate");
  }
  localStorage.setItem(storageKey, stored);
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

export async function checkDesktopUpdate(): Promise<DesktopUpdateCheck> {
  return invokeDesktop<DesktopUpdateCheck>("desktop_check_for_update");
}

export async function installPendingDesktopUpdate(): Promise<void> {
  await invokeDesktop<void>("desktop_install_pending_update");
}
