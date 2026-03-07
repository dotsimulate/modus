import { API_BASE, authHeaders } from "./_fetch";
import type { ActionInfo, ActionRun } from "./types";

export async function fetchActions(userProfile?: string | null): Promise<ActionInfo[]> {
  const params = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : "";
  const res = await fetch(`${API_BASE}/api/actions${params}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchActionRuns(name: string, limit = 20): Promise<ActionRun[]> {
  const res = await fetch(
    `${API_BASE}/api/actions/${encodeURIComponent(name)}/runs?limit=${limit}`,
    { headers: authHeaders() },
  );
  return res.json();
}

export async function triggerActionApi(name: string, userProfile?: string | null): Promise<void> {
  const res = await fetch(`${API_BASE}/api/actions/${encodeURIComponent(name)}/trigger`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ userProfile: userProfile ?? undefined }),
  });
  if (!res.ok) throw new Error("trigger failed");
}

export async function updateActionApi(
  name: string,
  updates: { enabled?: boolean; interval?: string },
): Promise<void> {
  await fetch(`${API_BASE}/api/actions/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function fetchActionInfo(name: string): Promise<{ contextSource: string; configSource: string }> {
  const res = await fetch(
    `${API_BASE}/api/actions/${encodeURIComponent(name)}/info`,
    { headers: authHeaders() },
  );
  return res.json();
}

export async function clearActionRunsApi(name: string): Promise<void> {
  await fetch(`${API_BASE}/api/actions/${encodeURIComponent(name)}/runs`, {
    method: "DELETE",
    headers: authHeaders(),
  });
}

export async function resetActionApi(name: string, skipConfirm = false): Promise<void> {
  await fetch(`${API_BASE}/api/actions/${encodeURIComponent(name)}/reset`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ skipConfirm }),
  });
}

export async function reloadActionsApi(): Promise<void> {
  await fetch(`${API_BASE}/api/actions/reload`, {
    method: "POST",
    headers: authHeaders(),
  });
}

export async function fetchActionPreferences(name: string): Promise<Record<string, boolean>> {
  const res = await fetch(
    `${API_BASE}/api/actions/${encodeURIComponent(name)}/preferences`,
    { headers: authHeaders() },
  );
  return res.json();
}
