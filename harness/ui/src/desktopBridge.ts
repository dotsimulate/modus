import type { NamedVault, VaultListResponse, VaultPolicy } from "../../sdk/types";

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

export type DesktopVaultStatus = {
  slug: string | null;
  running: boolean;
  databasePath: string;
};

export type DesktopUpdateCheck = {
  configured: boolean;
  available: boolean;
  version?: string | null;
  currentVersion: string;
  notes?: string | null;
  date?: string | null;
};

export type DesktopVaultRootMode = "initialize" | "register";

export type DesktopVaultRegistrationRequest = {
  slug: string;
  root: string;
  name?: string;
  mode: DesktopVaultRootMode;
};

/**
 * Destination of a `modus://` deep link, validated in Rust.
 *
 * Tagged by `kind` rather than discriminated by which field is present, so a
 * new link kind cannot be silently mistaken for an existing one. Must match
 * `DeepLinkTarget` in `desktop/src-tauri/src/deep_link.rs`.
 */
export type DesktopDeepLinkTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "page"; project: string; slug: string };

type TauriInternals = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
};

type TauriEvents = {
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
    __TAURI__?: { core?: TauriInternals; event?: TauriEvents };
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
  vault?: string,
): Promise<DesktopBootstrapResponse> {
  return invokeDesktop<DesktopBootstrapResponse>("desktop_bootstrap", {
    request: { mode, ...(url ? { url } : {}), ...(vault ? { vault } : {}) },
  });
}

export async function openDesktopVault(slug: string | null): Promise<DesktopBootstrapResponse> {
  return invokeDesktop<DesktopBootstrapResponse>("desktop_open_vault", {
    request: { slug },
  });
}

export async function getDesktopVaultStatus(slug: string | null): Promise<DesktopVaultStatus> {
  return invokeDesktop<DesktopVaultStatus>("desktop_vault_status", {
    request: { slug },
  });
}

export async function listDesktopVaults(): Promise<VaultListResponse> {
  return invokeDesktop<VaultListResponse>("desktop_list_vaults");
}

export async function createDesktopVault(
  request: DesktopVaultRegistrationRequest,
): Promise<NamedVault> {
  return invokeDesktop<NamedVault>("desktop_create_vault", { request });
}

export async function repairDesktopVault(
  request: DesktopVaultRegistrationRequest,
): Promise<NamedVault> {
  return invokeDesktop<NamedVault>("desktop_repair_vault", { request });
}

export async function updateDesktopVault(
  slug: string,
  patch: { name?: string; autostart?: boolean },
): Promise<NamedVault> {
  return invokeDesktop<NamedVault>("desktop_update_vault", { slug, patch });
}

export async function getDesktopVaultPolicy(slug: string | null): Promise<VaultPolicy> {
  return invokeDesktop<VaultPolicy>("desktop_vault_policy", { request: { slug } });
}

export async function chooseDesktopVaultFolder(): Promise<string | null> {
  return invokeDesktop<string | null>("desktop_choose_vault_folder");
}

export type DesktopPickRequest = {
  title?: string;
  /** Directory the dialog opens in. Ignored by Rust unless it exists. */
  initialPath?: string;
  /** Extension allowlist for file picks, e.g. [".png", ".jpg"]. */
  accept?: string[];
};

/**
 * Open the OS folder dialog. Resolves to null when the user dismisses it.
 *
 * This picks a path on the *client's* filesystem, which the harness backend can
 * only open when the two share a machine. Callers must gate on
 * `nativePickerAvailable()` rather than on `isTauriRuntime()` alone.
 */
export async function pickDesktopFolder(request: DesktopPickRequest = {}): Promise<string | null> {
  return invokeDesktop<string | null>("desktop_pick_folder", { request });
}

/** Open the OS file dialog. Resolves to null when the user dismisses it. */
export async function pickDesktopFile(request: DesktopPickRequest = {}): Promise<string | null> {
  return invokeDesktop<string | null>("desktop_pick_file", { request });
}

/**
 * Open a URL in the system browser instead of navigating this webview.
 *
 * Rust refuses any scheme outside `http`/`https`; callers should classify with
 * `classifyLinkTarget` first so a refusal is a bug rather than routine.
 */
export async function openDesktopExternalUrl(url: string): Promise<void> {
  await invokeDesktop<void>("desktop_open_external_url", { url });
}

/**
 * Show a path selected in the OS file manager.
 *
 * Acts on the *client's* filesystem, so gate on `nativePickerApplies` — a
 * desktop window driving a remote backend must not offer this.
 */
export async function revealDesktopPath(path: string): Promise<void> {
  await invokeDesktop<void>("desktop_reveal_path", { path });
}

/** Hand a path to its default program. Same filesystem caveat as reveal. */
export async function openDesktopPath(path: string): Promise<void> {
  await invokeDesktop<void>("desktop_open_path", { path });
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

/** Must match `DEEP_LINK_EVENT` in `desktop/src-tauri/src/deep_link.rs`. */
const DEEP_LINK_EVENT = "modus:deep-link";

/**
 * Claim a link that arrived before this webview was listening.
 *
 * When the OS launches Modus *because* of a `modus://` link, the URL is handled
 * in Rust before any listener exists, so it is parked there and claimed once.
 * Returns null on an ordinary start.
 */
export async function takePendingDeepLink(): Promise<DesktopDeepLinkTarget | null> {
  return invokeDesktop<DesktopDeepLinkTarget | null>("desktop_take_pending_deep_link");
}

/** Subscribe to `modus://` links delivered while the app is already running. */
export async function onDesktopDeepLink(
  handler: (target: DesktopDeepLinkTarget) => void,
): Promise<() => void> {
  // Provided by `withGlobalTauri`; absent in the browser build.
  const events = window.__TAURI__?.event;
  if (!events?.listen) return () => {};
  return events.listen<DesktopDeepLinkTarget>(DEEP_LINK_EVENT, (event) => handler(event.payload));
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
