/**
 * When the OS file dialog is the right picker, and how to reconcile its answer.
 *
 * `FolderPicker` and `FilePicker` browse the *harness backend's* filesystem via
 * `GET /api/browse`. The native dialog browses the *client's*. Those are the
 * same tree only when a Tauri window is driving a local backend — so the
 * server-side browser is not a poor fallback, it is the only correct picker for
 * a remote backend or a phone client, and it stays.
 *
 * The decision itself is pure and lives here so it can be pinned without a DOM.
 */

import { BACKEND_TARGET, type BackendTargetMode } from "./backendTarget";
import { isTauriRuntime } from "./desktopBridge";
import { modus } from "./modusClient";
import { parentDir } from "./folderPath";

/**
 * Whether a client-side dialog would pick paths this backend can open.
 *
 * Both local modes qualify: `managed-local` is the backend this desktop app
 * spawned, `external-local` one already running on the same machine. `remote`
 * and `browser` do not — in `remote` the agent's files live elsewhere, and in
 * `browser` there is no native dialog to reach.
 */
export function nativePickerApplies(tauri: boolean, mode: BackendTargetMode): boolean {
  return tauri && (mode === "managed-local" || mode === "external-local");
}

export function nativePickerAvailable(): boolean {
  return nativePickerApplies(isTauriRuntime(), BACKEND_TARGET.mode);
}

/**
 * Host to name in the in-app browser's header, or null to stay unlabelled.
 *
 * Naming it answers the question the picker otherwise raises — *whose* folders
 * are these? — but only where the answer is non-obvious. It is suppressed when
 * the native dialog was available (that path never renders this component) and
 * when the backend is same-origin, because then the address bar already says it.
 */
export function browsedHostLabel(native: boolean, apiBase: string, fallback: string): string | null {
  if (native || !apiBase) return null;
  try {
    return new URL(apiBase).host;
  } catch {
    return fallback || null;
  }
}

export function browsedHost(): string | null {
  return browsedHostLabel(nativePickerAvailable(), BACKEND_TARGET.apiBase, BACKEND_TARGET.label);
}

/**
 * Re-resolve a client-picked directory through the backend.
 *
 * Returns the server's own `resolve()`d form, which is what every other path in
 * the harness is stored as, and null when the backend cannot open it at all.
 * Doing this makes a native pick indistinguishable from an in-app one
 * downstream, and turns "the agent failed on a path that does not exist there"
 * into a failure at the moment of picking.
 */
export async function canonicalFolder(path: string): Promise<string | null> {
  try {
    return (await modus.browse(path)).path;
  } catch {
    return null;
  }
}

/**
 * The file-picking counterpart: list the containing directory and confirm the
 * chosen name is in it. `/api/browse` only lists directories, so a file's
 * canonical form has to be rebuilt from its parent's.
 */
export async function canonicalFile(path: string): Promise<string | null> {
  const name = path.split(/[/\\]+/).filter(Boolean).pop();
  const parent = parentDir(path);
  if (!name || !parent) return null;
  try {
    const listing = await modus.browse(parent, { includeFiles: true });
    if (!listing.files?.includes(name)) return null;
    return `${listing.path.replace(/[/\\]+$/, "")}${separatorOf(listing.path)}${name}`;
  } catch {
    return null;
  }
}

/** Match the separator the server used, so the stored path reads as one path. */
function separatorOf(serverPath: string): string {
  return serverPath.includes("\\") && !serverPath.includes("/") ? "\\" : "/";
}
