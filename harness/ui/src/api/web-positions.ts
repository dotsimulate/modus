import { API_BASE, authHeaders } from "./_fetch";

export type WebPosition = {
  nodeId: string;
  x: number;
  y: number;
  pinned: boolean;
};

export async function fetchWebPositions(scope: string): Promise<WebPosition[]> {
  const res = await fetch(`${API_BASE}/api/web/positions?scope=${encodeURIComponent(scope)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) return [];
  return res.json();
}

export async function patchWebPositions(
  scope: string,
  positions: { nodeId: string; x: number; y: number; pinned?: boolean }[],
): Promise<void> {
  await fetch(`${API_BASE}/api/web/positions`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ scope, positions }),
  });
}
