const API_BASE = import.meta.env.VITE_API_URL ?? "";

// Auth token — PIN session token from login (stored in localStorage).
// HARNESS_TOKEN is for agents only; browsers authenticate via PIN.
function getAuthToken(): string {
  return localStorage.getItem("harness_token") || "";
}

export function setAuthToken(token: string) {
  localStorage.setItem("harness_token", token);
}

export function clearAuthToken() {
  localStorage.removeItem("harness_token");
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const token = getAuthToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

function tokenParam(): string {
  const token = getAuthToken();
  return token ? `token=${token}` : "";
}

// ── PIN Auth ──

/** Check if PIN auth is required */
export async function authStatus(): Promise<{ required: boolean; setup: boolean; name: string | null }> {
  const res = await fetch(`${API_BASE}/api/auth/status`);
  return res.json();
}

/** First-run setup — set a new PIN (only works if none exists) */
export async function setupNewPin(pin: string, name?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin, name }),
  });
  if (!res.ok) throw new Error("Setup failed");
  const data = await res.json();
  return data.token;
}

/** Verify PIN, returns session token on success */
export async function verifyPin(pin: string, name?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin, name }),
  });
  if (!res.ok) throw new Error("Wrong PIN");
  const data = await res.json();
  return data.token;
}

/** Get current user info */
export async function fetchMe(): Promise<{ name: string | null }> {
  const res = await fetch(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
  return res.json();
}

/** Lock — invalidate all browser sessions server-side */
export async function lockAll(): Promise<void> {
  await fetch(`${API_BASE}/api/auth/lock`, { method: "POST", headers: authHeaders() });
}

/** Check if current token is still valid — throws on 401 */
export async function checkToken(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sessions?limit=1`, { headers: authHeaders() });
  if (!res.ok) throw new Error("unauthorized");
}

// ── Types ──

export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export type Profile = {
  name: string;
  description: string;
  prompt: string;
  promptMode?: "custom" | "append";
  model?: string;
  effort?: string;
  maxTurns?: number;
  tools?: string[] | "all";
  disallowedTools?: string[];
  loadProjectSettings?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
};

export type GlobalConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

export type SessionInfo = {
  id: string;
  preview: string;
  profile: string | null;
  model: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  last_message_at: number;
  message_count: number;
  total_cost_usd: number;
  last_prompt: string | null;
  last_response: string | null;
  cwd: string | null;
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
  cwd: string | null;
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

export async function fetchProfile(name: string): Promise<Profile> {
  const res = await fetch(`${API_BASE}/api/profiles/${name}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Profile not found: ${name}`);
  return res.json();
}

export async function saveProfileApi(name: string, profile: Omit<Profile, "name">): Promise<void> {
  await fetch(`${API_BASE}/api/profiles/${name}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(profile),
  });
}

export async function deleteProfileApi(name: string): Promise<void> {
  await fetch(`${API_BASE}/api/profiles/${name}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
}

export async function fetchGlobalConfig(): Promise<GlobalConfig> {
  const res = await fetch(`${API_BASE}/api/profiles/_global`, { headers: authHeaders() });
  return res.json();
}

export async function saveGlobalConfigApi(config: GlobalConfig): Promise<void> {
  await fetch(`${API_BASE}/api/profiles/_global`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(config),
  });
}

export async function checkSecrets(vars: string[]): Promise<{ status: Record<string, boolean>; secretsFile: string }> {
  const res = await fetch(`${API_BASE}/api/secrets/check`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ vars }),
  });
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

export async function fetchSessionStatus(sessionId: string): Promise<SessionStatusInfo> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/status`, { headers: authHeaders() });
  return res.json();
}

export async function fetchActiveSessions(): Promise<ActiveSessionInfo[]> {
  const res = await fetch(`${API_BASE}/api/sessions/active`, { headers: authHeaders() });
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

export type ApiAttachment = {
  type: "image";
  mediaType: string;
  data: string;
  name?: string;
};

export type CreateSessionOpts = {
  prompt: string;
  attachments?: ApiAttachment[];
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

// ── Memories ──

export type MemoryItem = {
  id: string;
  type: string;
  tags: string[];
  confidence: string;
  created: string;
  profile: string | null;
  body: string;
};

export async function fetchMemories(): Promise<MemoryItem[]> {
  const res = await fetch(`${API_BASE}/api/memories`, { headers: authHeaders() });
  return res.json();
}

// ── Event Stream (SSE) ──

export type EventStreamCallbacks = {
  onEvent: (event: any, seq: number) => void;
  onDone: () => void;
  /** Stream closed without server sending "done" — likely network drop */
  onDisconnect?: () => void;
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
