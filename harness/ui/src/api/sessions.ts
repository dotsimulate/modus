import { API_BASE, authHeaders, tokenParam } from "./_fetch";
import type {
  SessionInfo, ActiveSessionInfo, SearchHit, SessionStatusInfo,
  ApiAttachment, CreateSessionOpts, EventStreamCallbacks,
} from "./types";

export async function fetchSessions(limit = 50): Promise<SessionInfo[]> {
  const res = await fetch(`${API_BASE}/api/sessions?limit=${limit}`, { headers: authHeaders() });
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

export async function searchSessions(query: string, limit = 20): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const res = await fetch(
    `${API_BASE}/api/sessions/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    { headers: authHeaders() },
  );
  return res.json();
}

export async function archiveSessionApi(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${id}`, { method: "DELETE", headers: authHeaders() });
}

// ── Draft Text ──

export async function getDraft(sessionId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/draft`, { headers: authHeaders() });
  const data = await res.json();
  return data.draft ?? "";
}

export async function saveDraft(sessionId: string, draft: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}/draft`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ draft }),
  });
}

// ── Empty Session ──

export async function createEmptySession(profile?: string, model?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/sessions/empty`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ profile, model }),
  });
  const data = await res.json();
  return data.sessionId;
}

// ── Session Actions ──

export async function createSession(opts: CreateSessionOpts): Promise<{ sessionId: string; status: string }> {
  const res = await fetch(`${API_BASE}/api/sessions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(opts),
  });
  return res.json();
}

export async function sendMessage(
  sessionId: string,
  prompt: string,
  attachments?: ApiAttachment[],
): Promise<{ queued: boolean; status: string }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt, attachments }),
  });
  return res.json();
}

export async function stopSessionApi(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}/stop`, {
    method: "POST",
    headers: authHeaders(),
  });
}

/** Update session config (tools, etc.) — takes effect on next turn */
export async function updateSessionConfig(
  sessionId: string,
  config: { disallowedTools?: string[]; tools?: string[] },
): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}/config`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(config),
  });
}

// ── Permission Responses ──

export async function respondToPermission(
  sessionId: string,
  response: import("./types").PermissionResponse,
): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}/permission-response`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(response),
  });
}

// ── Scoped queries ──

/** Fetch sessions with optional user profile scoping */
export async function fetchSessionsScoped(limit = 50, userProfile?: string): Promise<SessionInfo[]> {
  const params = [`limit=${limit}`];
  if (userProfile) params.push(`userProfile=${encodeURIComponent(userProfile)}`);
  const res = await fetch(`${API_BASE}/api/sessions?${params.join("&")}`, { headers: authHeaders() });
  return res.json();
}

/** Search sessions with optional user profile scoping */
export async function searchSessionsScoped(query: string, limit = 20, userProfile?: string): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const params = [`q=${encodeURIComponent(query)}`, `limit=${limit}`];
  if (userProfile) params.push(`userProfile=${encodeURIComponent(userProfile)}`);
  const res = await fetch(`${API_BASE}/api/sessions/search?${params.join("&")}`, { headers: authHeaders() });
  return res.json();
}

// ── Directory Browser ──

export async function browsePath(path?: string): Promise<import("./types").BrowseResult> {
  const params = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`${API_BASE}/api/browse${params}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("browse failed");
  return res.json();
}

// ── Event Stream (SSE) ──

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

  let doneFired = false;
  let gotServerDone = false;
  const fireDone = () => {
    if (doneFired) return;
    doneFired = true;
    if (gotServerDone) {
      callbacks.onDone();
    } else {
      // Stream ended without server "done" — network drop
      (callbacks.onDisconnect ?? callbacks.onDone)();
    }
  };

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
              gotServerDone = true;
              fireDone();
            } else {
              try {
                const parsed = JSON.parse(line.slice(6));
                callbacks.onEvent(parsed, Number(currentId) || 0);
              } catch { /* skip */ }
            }
          }
        }
      }

      fireDone();
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        callbacks.onError(String(err));
      }
    });

  return () => abort.abort();
}
