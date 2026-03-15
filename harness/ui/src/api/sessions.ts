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

// ── Tags ──

async function patchSessionTags(
  id: string,
  body: { tags?: string[]; add?: string; remove?: string },
): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/sessions/${id}/tags`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : "Failed to update session tags");
  }
  return Array.isArray(data?.tags) ? data.tags : [];
}

export async function addSessionTagApi(id: string, tag: string): Promise<string[]> {
  return patchSessionTags(id, { add: tag });
}

export async function removeSessionTagApi(id: string, tag: string): Promise<string[]> {
  return patchSessionTags(id, { remove: tag });
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

// ── Session UI State ──

export async function fetchSessionUiState(sessionId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/ui-state`, { headers: authHeaders() });
  return res.json();
}

export async function saveSessionUiState(sessionId: string, patch: Record<string, unknown>): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}/ui-state`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(patch),
  });
}

// ── Empty Session ──

export async function createEmptySession(opts?: {
  profile?: string;
  model?: string;
  provider?: string;
  cwd?: string;
  userProfile?: string;
}): Promise<string> {
  const res = await fetch(`${API_BASE}/api/sessions/empty`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(opts ?? {}),
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
    additionalDirectories?: string[];
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
    additionalDirectories?: string[];
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

// ── Message Content ──

export type TurnContent = {
  role: "user" | "assistant";
  seq: number;
  text: string;
  thinking?: string;
  toolCalls?: { name: string; input: Record<string, unknown>; result?: string }[];
  uuid?: string;
  artifacts?: Array<{
    id: number;
    sessionId: string;
    seq: number;
    targetMessageUuid?: string;
    name: string;
    mime: string;
    url: string;
    sourceAction?: string;
    createdAt: number;
    previewText?: string;
    metadata?: Record<string, unknown>;
  }>;
  timestamp: number;
};

export async function fetchMessageContent(sessionId: string, seq?: number): Promise<TurnContent | TurnContent[]> {
  const params = seq != null ? `?seq=${seq}` : "";
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages-content${params}`, { headers: authHeaders() });
  return res.json();
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

export type GeminiUsageInfo = {
  available: boolean;
  authType: string;
  model: string;
  checkedAt: number;
  quota: {
    remaining?: number;
    limit?: number;
    resetTime?: string;
  };
  tier?: string;
  paidTier?: string;
  error?: string;
};

export async function fetchAccountInfo(userProfile?: string): Promise<AccountInfo> {
  const params = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : "";
  const res = await fetch(`${API_BASE}/api/account${params}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchGeminiUsage(cwd?: string): Promise<GeminiUsageInfo> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const res = await fetch(`${API_BASE}/api/gemini/usage${params}`, { headers: authHeaders() });
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

export async function browsePath(
  path?: string,
  options?: { includeHidden?: boolean },
): Promise<import("./types").BrowseResult> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (options?.includeHidden) params.set("includeHidden", "1");
  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  const res = await fetch(`${API_BASE}/api/browse${suffix}`, { headers: authHeaders() });
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
