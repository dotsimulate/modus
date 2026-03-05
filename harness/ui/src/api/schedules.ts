import { API_BASE, authHeaders } from "./_fetch";
import type { ScheduleInfo, ScheduleRun } from "./types";

export async function fetchSchedules(userProfile?: string | null): Promise<ScheduleInfo[]> {
  const params = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : "";
  const res = await fetch(`${API_BASE}/api/schedules${params}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchScheduleRuns(name: string, limit = 20): Promise<ScheduleRun[]> {
  const res = await fetch(
    `${API_BASE}/api/schedules/${encodeURIComponent(name)}/runs?limit=${limit}`,
    { headers: authHeaders() },
  );
  return res.json();
}

export async function triggerScheduleApi(name: string, userProfile?: string | null): Promise<void> {
  const res = await fetch(`${API_BASE}/api/schedules/${encodeURIComponent(name)}/trigger`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ userProfile: userProfile ?? undefined }),
  });
  if (!res.ok) throw new Error("trigger failed");
}

export async function updateScheduleApi(
  name: string,
  updates: { enabled?: boolean; interval?: string },
): Promise<void> {
  await fetch(`${API_BASE}/api/schedules/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function fetchScheduleInfo(name: string): Promise<{ contextSource: string; configSource: string }> {
  const res = await fetch(
    `${API_BASE}/api/schedules/${encodeURIComponent(name)}/info`,
    { headers: authHeaders() },
  );
  return res.json();
}

export async function clearScheduleRunsApi(name: string): Promise<void> {
  await fetch(`${API_BASE}/api/schedules/${encodeURIComponent(name)}/runs`, {
    method: "DELETE",
    headers: authHeaders(),
  });
}

export async function resetScheduleApi(name: string, skipConfirm = false): Promise<void> {
  await fetch(`${API_BASE}/api/schedules/${encodeURIComponent(name)}/reset`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ skipConfirm }),
  });
}

export async function fetchSchedulePreferences(name: string): Promise<Record<string, boolean>> {
  const res = await fetch(
    `${API_BASE}/api/schedules/${encodeURIComponent(name)}/preferences`,
    { headers: authHeaders() },
  );
  return res.json();
}
