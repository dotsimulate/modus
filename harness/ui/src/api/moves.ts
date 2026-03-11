import { API_BASE, authHeaders } from "./_fetch";

export type MoveInput = {
  name: string;
  label?: string;
  type: "text" | "textarea" | "select" | "toggle" | "number";
  options?: string[] | string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
};

export type MoveListItem = {
  name: string;
  label: string;
  description: string;
  icon?: string;
  mode?: "inline" | "branch" | "background";
  inputs?: MoveInput[];
  tags?: string[];
};

export type ActivateMoveResult = {
  token: string;
  mode: "inline" | "branch" | "background";
  spawnedSessionId?: string;
  moveRunId: number;
};

export async function fetchMoves(projectCwd: string): Promise<MoveListItem[]> {
  const res = await fetch(
    `${API_BASE}/api/moves?cwd=${encodeURIComponent(projectCwd)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return [];
  return res.json();
}

export async function activateMoveApi(
  sessionId: string,
  body: {
    moveName: string;
    inputs: Record<string, unknown>;
    cwd: string;
    userProfile?: string;
  },
): Promise<ActivateMoveResult> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/moves/activate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: "move activation failed" }));
  if (!res.ok) {
    throw new Error(data.error ?? "move activation failed");
  }
  return data;
}
