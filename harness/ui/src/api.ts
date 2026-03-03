const API_BASE = import.meta.env.VITE_API_URL ?? "";
const AUTH_TOKEN = import.meta.env.VITE_HARNESS_TOKEN ?? "";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (AUTH_TOKEN) h["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  return h;
}

function tokenParam(): string {
  return AUTH_TOKEN ? `token=${AUTH_TOKEN}` : "";
}

// ── Types ──

export type Profile = {
  name: string;
  description: string;
  model: string;
  maxTurns: number;
  tools: string[] | "all";
  effort: string;
};

export type SessionInfo = {
  id: string;
  preview: string;
  profile: string | null;
  model: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  total_cost_usd: number;
  last_prompt: string | null;
  last_response: string | null;
};

export type MessageInfo = {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  thinking: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  model: string | null;
  turns: number | null;
  created_at: number;
};

export type ActiveSessionInfo = {
  id: string;
  status: string;
  profile: string | null;
  model: string | null;
  costUsd: number;
  numTurns: number;
  startedAt: number;
  lastEventAt: number;
  preview: string;
  seq: number;
  subscribers: number;
};

export type SessionStatusInfo = {
  sessionId: string;
  status: string;
  seq: number;
  costUsd: number;
  numTurns: number;
  startedAt: number;
  lastEventAt: number;
  error: string | null;
};

// ── API Functions ──

export async function fetchProfiles(): Promise<Profile[]> {
  const res = await fetch(`${API_BASE}/api/profiles`, { headers: authHeaders() });
  return res.json();
}

export async function healthCheck(): Promise<{ status: string; uptime: number }> {
  const res = await fetch(`${API_BASE}/health`);
  return res.json();
}

export async function fetchSessions(limit = 50): Promise<SessionInfo[]> {
  const res = await fetch(`${API_BASE}/api/sessions?limit=${limit}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchMessages(sessionId: string): Promise<MessageInfo[]> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, { headers: authHeaders() });
  return res.json();
}

export async function fetchSessionStatus(sessionId: string): Promise<SessionStatusInfo> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/status`, { headers: authHeaders() });
  return res.json();
}

export async function fetchActiveSessions(): Promise<ActiveSessionInfo[]> {
  const res = await fetch(`${API_BASE}/api/sessions/active`, { headers: authHeaders() });
  return res.json();
}

export async function deleteSessionApi(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${id}`, { method: "DELETE", headers: authHeaders() });
}

// ── Directory Browser ──

export type BrowseResult = {
  path: string;
  parent: string | null;
  dirs: string[];
};

export async function browsePath(path?: string): Promise<BrowseResult> {
  const params = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`${API_BASE}/api/browse${params}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("browse failed");
  return res.json();
}

// ── Session Actions ──

export type CreateSessionOpts = {
  prompt: string;
  profile?: string;
  model?: string;
  maxTurns?: number;
  effort?: string;
  cwd?: string;
  tools?: string[];
  disallowedTools?: string[];
  loadProjectSettings?: boolean;
  sessionId?: string;
};

export async function createSession(opts: CreateSessionOpts): Promise<{ sessionId: string; status: string }> {
  const res = await fetch(`${API_BASE}/api/sessions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(opts),
  });
  return res.json();
}

export async function sendMessage(sessionId: string, prompt: string): Promise<{ queued: boolean; status: string }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt }),
  });
  return res.json();
}

export async function interruptSession(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}/interrupt`, {
    method: "POST",
    headers: authHeaders(),
  });
}

export async function stopSessionApi(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}/stop`, {
    method: "POST",
    headers: authHeaders(),
  });
}

// ── Event Stream (SSE) ──

export type EventStreamCallbacks = {
  onEvent: (event: any, seq: number) => void;
  onDone: () => void;
  onError: (error: string) => void;
};

/**
 * Subscribe to a session's event stream via SSE.
 * Receives catch-up events from DB first, then live events.
 * Returns an abort function.
 */
export function subscribeEvents(
  sessionId: string,
  afterSeq: number,
  callbacks: EventStreamCallbacks,
): () => void {
  const abort = new AbortController();

  const tp = tokenParam();
  const params = [`after=${afterSeq}`, tp].filter(Boolean).join("&");
  const url = `${API_BASE}/api/sessions/${sessionId}/events?${params}`;

  fetch(url, { signal: abort.signal })
    .then(async (res) => {
      if (!res.ok) {
        callbacks.onError(`Event stream failed: ${res.statusText}`);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) { callbacks.onError("No response body"); return; }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        let currentId = "0";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("id: ")) {
            currentId = line.slice(4).trim();
          } else if (line.startsWith("data: ")) {
            if (currentEvent === "done") {
              callbacks.onDone();
            } else {
              try {
                const parsed = JSON.parse(line.slice(6));
                callbacks.onEvent(parsed, Number(currentId) || 0);
              } catch { /* skip */ }
            }
          }
        }
      }

      callbacks.onDone();
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        callbacks.onError(String(err));
      }
    });

  return () => abort.abort();
}
