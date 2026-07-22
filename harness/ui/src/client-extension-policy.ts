import type { BackendTargetMode } from "./backendTarget";
import type { ClientExtensionManifestItem } from "../../sdk/types";

/**
 * Backend-supplied modules may execute in an ordinary browser or against a
 * local desktop backend. A remote backend must never inject code into the
 * native desktop renderer, which also carries local Tauri authority.
 */
export function mayLoadBackendClientExtensions(
  targetMode: BackendTargetMode,
  nativeDesktop: boolean,
): boolean {
  return !(nativeDesktop && targetMode === "remote");
}

export async function refreshBackendClientExtensions(options: {
  targetMode: BackendTargetMode;
  nativeDesktop: boolean;
  list: () => Promise<ClientExtensionManifestItem[]>;
  load: (items: ClientExtensionManifestItem[]) => Promise<void>;
  unload: () => Promise<void>;
  cancelled?: () => boolean;
}): Promise<"blocked" | "cancelled" | "loaded"> {
  if (!mayLoadBackendClientExtensions(options.targetMode, options.nativeDesktop)) {
    await options.unload();
    return "blocked";
  }
  const items = await options.list();
  if (options.cancelled?.()) return "cancelled";
  await options.load(items);
  return "loaded";
}
