import { API_BASE, authHeaders, tokenParam } from "./_fetch";
import type {
  SessionInfo, ActiveSessionInfo, SearchHit, SessionStatusInfo,
  AgentConfigState, ApiAttachment, CreateSessionOpts, EventStreamCallbacks,
} from "./types";

export async function fetchSessions(limit = 50): Promise<SessionInfo[]> {
  const res = await fetch(`${API_BASE}/api/sessions?limit=${limit}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchSessionStatus(sessionId: string): Promise<SessionStatusInfo> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/status`, { headers: authHeaders() });
  return res.json();
}

export async function fetchActiveSessions(userProfile?: string): Promise<ActiveSessionInfo[]> {
  const params = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : "";
  const res = await fetch(`${API_BASE}/api/sessions/active${params}`, { headers: authHeaders() });
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

// ── Title ──

export async function updateSessionTitle(id: string, title: string | null): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${id}/title`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ title }),
  });
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

export async function createEmptySession(profile?: string, model?: string, provider?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/sessions/empty`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ profile, model, provider }),
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
  config?: {
    profile?: string;
    provider?: string;
    model?: string;
    effort?: string;
    maxTurns?: number;
    tools?: string[];
    disallowedTools?: string[];
    toolStates?: Record<string, "inherit" | "on" | "off">;
    providerControls?: AgentConfigState["providerControls"];
    cwd?: string;
    loadProjectSettings?: boolean;
  },
): Promise<{ queued: boolean; status: string }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt, attachments, ...config }),
  });
  return res.json();
}

export async function stopSessionApi(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}/stop`, {
    method: "POST",
    headers: authHeaders(),
  });
}

export async function stopTaskApi(sessionId: string, taskId: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}/stop-task`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
}

/** Switch active profile on a running/idle session */
export async function switchSessionProfile(
  sessionId: string,
  profile: string,
  contextMode?: "full" | "summary" | "lastResponse",
): Promise<{ ok: boolean; profile?: string }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/profile`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ profile, contextMode }),
  });
  const text = await res.text();
  const data = text
    ? (() => {
        try {
          return JSON.parse(text);
        } catch {
          return { error: text };
        }
      })()
    : {};
  if (!res.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : `Profile switch failed (${res.status})`);
  }
  return data;
}

/** Update session config (tools, etc.) — takes effect on next turn */
export async function updateSessionConfig(
  sessionId: string,
  config: {
    provider?: string;
    model?: string;
    effort?: string;
    maxTurns?: number | null;
    tools?: string[];
    disallowedTools?: string[];
    toolStates?: AgentConfigState["toolStates"];
    providerControls?: AgentConfigState["providerControls"];
    cwd?: string;
    loadProjectSettings?: boolean;
  },
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

// ── Branching ──

export async function branchSessionApi(sourceId: string, seq: number): Promise<string> {
  const res = await fetch(`${API_BASE}/api/sessions/${sourceId}/branch`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ seq }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.sessionId;
}

// ── Stats ──

export type SessionStats = {
  totals: { sessions: number; cost: number; messages: number; firstSession: number | null; lastSession: number | null };
  byProject: { project: string; sessions: number; cost: number; messages: number }[];
  byProfile: { profile: string; sessions: number; cost: number; messages: number }[];
  byModel: { model: string; sessions: number; cost: number }[];
  daily: { day: string; sessions: number; cost: number }[];
  topSessions: { id: string; preview: string; cost: number; messages: number; profile: string | null; cwd: string | null }[];
};

export async function fetchSessionStats(userProfile?: string): Promise<SessionStats> {
  const params = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : "";
  const res = await fetch(`${API_BASE}/api/stats/sessions${params}`, { headers: authHeaders() });
  return res.json();
}

// ── Account ──

export type AccountInfo = {
  account: {
    loggedIn: boolean;
    authMethod: string;
    apiProvider: string;
    email: string;
    orgId: string;
    orgName: string;
    subscriptionType: string;
  } | null;
  costs: {
    today: { cost: number; sessions: number; messages: number };
    week: { cost: number; sessions: number; messages: number };
    month: { cost: number; sessions: number; messages: number };
  };
};

export async function fetchAccountInfo(userProfile?: string): Promise<AccountInfo> {
  const params = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : "";
  const res = await fetch(`${API_BASE}/api/account${params}`, { headers: authHeaders() });
  return res.json();
}

// ── Scoped queries ──

/** Fetch sessions with optional user profile scoping and action filter */
export async function fetchSessionsScoped(limit = 50, userProfile?: string, action?: string): Promise<SessionInfo[]> {
  const params = [`limit=${limit}`];
  if (userProfile) params.push(`userProfile=${encodeURIComponent(userProfile)}`);
  if (action) params.push(`action=${encodeURIComponent(action)}`);
  const res = await fetch(`${API_BASE}/api/sessions?${params.join("&")}`, { headers: authHeaders() });
  return res.json();
}

/** Fetch sessions filtered by agent profile name, optionally scoped to a user profile */
export async function fetchSessionsByProfile(profile: string, limit = 10, userProfile?: string): Promise<SessionInfo[]> {
  const params = [`profile=${encodeURIComponent(profile)}`, `limit=${limit}`];
  if (userProfile) params.push(`userProfile=${encodeURIComponent(userProfile)}`);
  const res = await fetch(
    `${API_BASE}/api/sessions?${params.join("&")}`,
    { headers: authHeaders() },
  );
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

// ── File Reader ──

export async function readFileContent(path: string): Promise<string | null> {
  const res = await fetch(`${API_BASE}/api/file-read?path=${encodeURIComponent(path)}`, { headers: authHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  return data.content ?? null;
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
