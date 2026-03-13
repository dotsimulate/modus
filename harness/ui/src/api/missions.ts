import { API_BASE, authHeaders } from "./_fetch";

// ── API Response Types ──

export type MissionRunStatus = "pending" | "running" | "completed" | "error" | "paused";
export type MissionTransferKind = "delegation" | "report" | "review" | "escalation";

export type MissionListItem = {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  stepCount: number;
  roles: string[];
  tags: string[];
};

export type MissionRunSummary = {
  id: number;
  missionName: string;
  status: MissionRunStatus;
  currentStepIndex: number;
  haltKind: string | null;
  haltMessage: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type MissionStepRunSummary = {
  id: number;
  stepId: string;
  stepOrder: number;
  role: string;
  title: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
};

export type MissionTransferSummary = {
  id: number;
  stepId: string;
  fromSessionId: string | null;
  toSessionId: string | null;
  kind: MissionTransferKind;
  summary: string | null;
  createdAt: number;
};

export type MissionGateResultSummary = {
  id: number;
  stepId: string;
  gateType: string;
  status: "pass" | "fail";
  evidence: string | null;
  checkedAt: number;
};

// ── Fetch functions ──

export async function fetchMissions(cwd: string): Promise<MissionListItem[]> {
  const res = await fetch(
    `${API_BASE}/api/missions?cwd=${encodeURIComponent(cwd)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return [];
  return res.json();
}

export async function fetchMissionRuns(opts?: {
  cwd?: string;
  status?: MissionRunStatus;
}): Promise<MissionRunSummary[]> {
  const params = new URLSearchParams();
  if (opts?.cwd) params.set("cwd", opts.cwd);
  if (opts?.status) params.set("status", opts.status);
  const query = params.toString();
  const res = await fetch(
    `${API_BASE}/api/missions/runs${query ? `?${query}` : ""}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return [];
  return res.json();
}

export async function fetchMissionRunDetail(id: number): Promise<MissionRunSummary | null> {
  const res = await fetch(
    `${API_BASE}/api/missions/runs/${id}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return null;
  return res.json();
}

export async function fetchMissionTransfers(runId: number): Promise<MissionTransferSummary[]> {
  const res = await fetch(
    `${API_BASE}/api/missions/runs/${runId}/transfers`,
    { headers: authHeaders() },
  );
  if (!res.ok) return [];
  return res.json();
}

export async function fetchMissionSessions(runId: number): Promise<string[]> {
  const res = await fetch(
    `${API_BASE}/api/missions/runs/${runId}/sessions`,
    { headers: authHeaders() },
  );
  if (!res.ok) return [];
  return res.json();
}

export async function fetchMissionSteps(runId: number): Promise<MissionStepRunSummary[]> {
  const res = await fetch(
    `${API_BASE}/api/missions/runs/${runId}/steps`,
    { headers: authHeaders() },
  );
  if (!res.ok) return [];
  return res.json();
}

export async function fetchMissionGates(runId: number): Promise<MissionGateResultSummary[]> {
  const res = await fetch(
    `${API_BASE}/api/missions/runs/${runId}/gates`,
    { headers: authHeaders() },
  );
  if (!res.ok) return [];
  return res.json();
}

export async function startMissionApi(body: {
  missionName: string;
  cwd: string;
  userProfile?: string;
}): Promise<{ runId: number }> {
  const res = await fetch(`${API_BASE}/api/missions/start`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: "mission start failed" }));
  if (!res.ok) throw new Error(data.error ?? "mission start failed");
  return data;
}

export async function pauseMissionApi(id: number, reason: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/missions/runs/${id}/pause`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "pause failed" }));
    throw new Error(data.error ?? "pause failed");
  }
}

export async function resumeMissionApi(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/missions/runs/${id}/resume`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "resume failed" }));
    throw new Error(data.error ?? "resume failed");
  }
}
