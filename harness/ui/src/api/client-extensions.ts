import { API_BASE, authHeaders, tokenParam } from "./_fetch";
import type { ClientExtensionManifestItem } from "./types";

export async function fetchClientExtensions(cwd?: string, userProfile?: string | null): Promise<ClientExtensionManifestItem[]> {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  if (userProfile) params.set("userProfile", userProfile);
  const tp = tokenParam();
  if (tp) params.set("token", tp.replace(/^token=/, ""));
  const query = params.toString();
  const res = await fetch(`${API_BASE}/api/client-extensions${query ? `?${query}` : ""}`, {
    headers: authHeaders(),
  });
  return res.json();
}
