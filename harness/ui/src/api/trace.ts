import { API_BASE, authHeaders } from "./_fetch";

export type TouchRecord = {
  sessionId: string;
  seq: number;
  timestamp: number;
  provider: string | null;
  cwd: string | null;
  filePath: string;
  fileKind: "code" | "docs";
  op: "read" | "write" | "edit" | "grep" | "glob" | "ls" | "command" | "mention";
  confidence: "explicit" | "derived" | "heuristic";
  toolName: string;
};

export type TouchSummary = {
  total: number;
  byOp: Record<string, number>;
  byConfidence: Record<string, number>;
  byProvider: Record<string, number>;
  byFileKind: Record<string, number>;
  uniqueFiles: number;
  uniqueSessions: number;
};

export type TouchesResponse = {
  touches: TouchRecord[];
  summary: TouchSummary;
};

export type TouchQuery = {
  limit?: number;
  userProfile?: string;
  cwd?: string;
  from?: number;
  to?: number;
  ops?: string[];
  confidence?: string[];
  sessionId?: string;
};

export async function fetchTouches(query: TouchQuery = {}): Promise<TouchesResponse> {
  const params = new URLSearchParams();
  if (query.limit != null) params.set("limit", String(query.limit));
  if (query.userProfile) params.set("userProfile", query.userProfile);
  if (query.cwd) params.set("cwd", query.cwd);
  if (query.from != null) params.set("from", String(query.from));
  if (query.to != null) params.set("to", String(query.to));
  if (query.ops?.length) params.set("ops", query.ops.join(","));
  if (query.confidence?.length) params.set("confidence", query.confidence.join(","));
  if (query.sessionId) params.set("sessionId", query.sessionId);

  const res = await fetch(`${API_BASE}/api/trace/touches?${params}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`trace fetch failed: ${res.status}`);
  return res.json();
}
