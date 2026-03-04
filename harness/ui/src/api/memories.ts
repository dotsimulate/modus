import { API_BASE, authHeaders } from "./_fetch";
import type { MemoryItem } from "./types";

export async function fetchMemories(): Promise<MemoryItem[]> {
  const res = await fetch(`${API_BASE}/api/memories`, { headers: authHeaders() });
  return res.json();
}
