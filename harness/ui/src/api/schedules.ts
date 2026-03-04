import { API_BASE, authHeaders } from "./_fetch";
import type { ScheduleInfo, ScheduleRun } from "./types";

export async function fetchSchedules(): Promise<ScheduleInfo[]> {
  const res = await fetch(`${API_BASE}/api/schedules`, { headers: authHeaders() });
  return res.json();
}

export async function fetchScheduleRuns(name: string, limit = 20): Promise<ScheduleRun[]> {
  const res = await fetch(
    `${API_BASE}/api/schedules/${encodeURIComponent(name)}/runs?limit=${limit}`,
    { headers: authHeaders() },
  );
  return res.json();
}

export async function triggerScheduleApi(name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/schedules/${encodeURIComponent(name)}/trigger`, {
    method: "POST",
    headers: authHeaders(),
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
