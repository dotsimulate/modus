import { API_BASE, authHeaders } from "./_fetch";
import type { MemoryItem } from "./types";

export async function fetchMemories(userProfile?: string, cwd?: string): Promise<MemoryItem[]> {
  const params = new URLSearchParams();
  if (userProfile) params.set("userProfile", userProfile);
  if (cwd) params.set("cwd", cwd);
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/api/memories${qs ? `?${qs}` : ""}`, { headers: authHeaders() });
  return res.json();
}
