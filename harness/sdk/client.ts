import { readFileMutationResponse, type FileMutationResult } from "../file-mutation-errors";
import type { SearchOptions } from "../session-search";
import type {
  ModusClientOptions,
  InteractOptions,
  InteractResult,
  SessionInfo,
  SessionIndex,
  ActiveSessionInfo,
  SearchHit,
  SessionStatusInfo,
  CreateSessionOpts,
  SendMessageOpts,
  SteerResult,
  MoveBinding,
  TurnContent,
  SessionHistorySnapshot,
  SessionTurnIndex,
  ConversationResourceRegistry,
  TypedSSEEvent,
  EventStreamHandle,
  EventStreamCallbacks,
  Profile,
  ResolvedProfileConfig,
  ProfileUi,
  GlobalConfig,
  TextToSpeechConfig,
  TextToSpeechProviderId,
  TtsProviderHealth,
  MoveListItem,
  SkillListItem,
  SkillContent,
  ActivateMoveResult,
  MoveWidgetInfo,
  AttachMoveResult,
  AmbientMoveInfo,
  PermissionResponseOpts,
  PermissionResponse,
  SessionTagsResult,
  ActionInfo,
  ActionRun,
  MissionRunSummary,
  MissionStepRunSummary,
  MissionTransferSummary,
  MissionGateResultSummary,
  MissionListItem,
  UserProfile,
  UserProfileUiConfig,
  UserProfileState,
  ProviderCapabilities,
  ProviderHealthInfo,
  ProviderModel,
  DetectedProvider,
  GitStatus,
  GitCommit,
  GitCommitDetail,
  FileDiff,
  BrowseResult,
  FileSearchResponse,
  PreviewManifest,
  ArtifactShelfResponse,
  PromptListItem,
  RenderResult,
  SessionStats,
  AccountInfo,
  ClaudePlanUsageSnapshot,
  ProviderUsageAnalytics,
  DeepAnalytics,
  MemoryItem,
  PromptCache,
  ModusPlugin,
  PluginSettingsSnapshot,
  NamedVault,
  VaultListResponse,
  VaultPolicy,
  ClientExtensionManifestItem,
  ProjectUiState,
  ProjectUiAssetInfo,
  ActiveProjectUiAsset,
  InitStatus,
  InitResult,
  ProjectInfo,
  TouchesResponse,
  TouchQuery,
  FileSessionRef,
  FileSessionsResponse,
  TerminalInfo,
  CreateTerminalOpts,
  ProcessSnapshot,
  MemoryStatus,
  WebPosition,
  MissionRunStatus,
  ApiAttachment,
  ActivityEntry,
  ActivitySummaryResult,
  NoteListItem,
  NoteDetail,
  BranchPreview,
  BranchResult,
  RewindPreview,
  RewindResult,
} from "./types";

/** Error thrown by ModusClient on non-OK HTTP responses. */
export class ModusError extends Error {
  status: number;
  detail: string;
  path: string;
  constructor(status: number, detail: string, path: string) {
    super(`${status} ${detail} (${path})`);
    this.name = "ModusError";
    this.status = status;
    this.detail = detail;
    this.path = path;
  }
}

/** HTTP client for the MO harness API. Handles auth, sessions, profiles, moves, actions, and all other harness operations. */
export class ModusClient {
  private url: string;
  private _token: string | undefined;
  private _browserSessionToken: string | undefined;
  private pin: string | undefined;
  private getTokenFn: (() => string | undefined) | undefined;
  private getBrowserSessionTokenFn: (() => string | undefined) | undefined;
  private authPromise: Promise<void> | null = null;

  /** Creates a client targeting the given harness URL, with optional token, PIN, or dynamic token callback for auth. */
  constructor(opts: ModusClientOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this._token = opts.token;
    this._browserSessionToken = opts.browserSessionToken;
    this.pin = opts.pin;
    this.getTokenFn = opts.getToken;
    this.getBrowserSessionTokenFn = opts.getBrowserSessionToken;
  }

  /** Returns the current auth token, preferring the dynamic getToken callback over the stored token. */
  get token(): string | undefined {
    return this.getTokenFn?.() ?? this._token;
  }

  /** Sets the stored bearer token directly. */
  setToken(token: string) { this._token = token; this._browserSessionToken = undefined; }
  /** Clears the stored bearer token. */
  clearToken() { this._token = undefined; this._browserSessionToken = undefined; }
  /** Returns the base harness URL (trailing slashes stripped). */
  get baseUrl(): string { return this.url; }

  /** Builds request headers with Content-Type and Authorization (if a token is available). */
  authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const t = this.token;
    if (t) h["Authorization"] = `Bearer ${t}`;
    return h;
  }

  /** Returns only an explicitly designated browser-session token for native resource URLs. */
  private get browserSessionToken(): string | undefined {
    const token = this.getBrowserSessionTokenFn?.() ?? this._browserSessionToken;
    return token && token === this.token ? token : undefined;
  }

  /** Returns a `token=xxx` query string fragment, or empty string without a browser session. */
  tokenParam(): string {
    const token = this.browserSessionToken;
    return token ? `token=${encodeURIComponent(token)}` : "";
  }

  private async ensureAuth(): Promise<void> {
    if (this.token || !this.pin) return;
    if (this.authPromise) return this.authPromise;
    this.authPromise = (async () => {
      const res = await globalThis.fetch(`${this.url}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: this.pin }),
      });
      const data = await res.json() as { ok?: boolean; token?: string; error?: string };
      if (!res.ok || !data.token) throw new Error(`PIN auth failed: ${data.error ?? res.statusText}`);
      this._token = data.token;
      this._browserSessionToken = data.token;
    })();
    return this.authPromise;
  }

  // ── Interact ──
  /** Sends a prompt to a session (creating one if needed). With `subscribe: true`, returns an SSE event stream; otherwise returns the final result. */
  async interact(opts: InteractOptions & { subscribe: true }): Promise<EventStreamHandle>;
  async interact(opts: InteractOptions & { subscribe?: false }): Promise<InteractResult>;
  async interact(opts: InteractOptions): Promise<InteractResult | EventStreamHandle> {
    const shouldSubscribe = opts.subscribe ?? false;
    const body = { ...opts, subscribe: shouldSubscribe };
    if (shouldSubscribe) return this.interactStream(body);
    const res = await this.fetch("/api/sessions/interact", { method: "POST", body: JSON.stringify(body) });
    return res.json() as Promise<InteractResult>;
  }

  private async interactStream(body: Record<string, unknown>): Promise<EventStreamHandle> {
    const controller = new AbortController();
    const res = await this.fetch("/api/sessions/interact", { method: "POST", body: JSON.stringify(body), signal: controller.signal });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body for SSE stream");
    return { events: parseSSEStream(reader), abort: () => controller.abort() };
  }

  // ── Auth ──
  /** Fetches an intentionally unauthenticated endpoint and preserves HTTP failures as typed errors. */
  private async publicFetchOrThrow(path: string, init?: RequestInit): Promise<Response> {
    const res = await globalThis.fetch(`${this.url}${path}`, init);
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new ModusError(res.status, detail || res.statusText, path);
    }
    return res;
  }

  /** Checks auth state. A host bearer token additionally reveals local PIN-management authority. */
  async authStatus(): Promise<{ required: boolean; setup: boolean; pinEnabled?: boolean; needsName?: boolean; tokenRequired?: boolean; canManagePin?: boolean; name: string | null }> {
    const token = this.token;
    const res = await this.publicFetchOrThrow(
      "/api/auth/status",
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    );
    return res.json();
  }
  /** Sets the browser display name without enabling PIN auth. */
  async setUserName(name: string): Promise<string | null> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.publicFetchOrThrow("/api/auth/name", { method: "POST", headers, body: JSON.stringify({ name }) });
    const data = await res.json() as { token?: string };
    return data.token || null;
  }
  /** Creates a browser session token when PIN auth is disabled but API auth is active. */
  async createBrowserSession(): Promise<string | null> {
    const res = await this.publicFetchOrThrow("/api/auth/session", { method: "POST", headers: { "Content-Type": "application/json" } });
    const data = await res.json() as { token?: string };
    return data.token || null;
  }
  /** Sets up a new PIN from the local host authority. */
  async setupNewPin(pin: string, name?: string): Promise<void> {
    const res = await this.fetch("/api/auth/setup", { method: "POST", body: JSON.stringify({ pin, name }) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as any).error || "Failed to set PIN"); }
  }
  /** Verifies an existing PIN and returns a bearer token. */
  async verifyPin(pin: string, name?: string): Promise<string> {
    const res = await this.publicFetchOrThrow("/api/auth/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin, name }) });
    return (await res.json()).token;
  }
  /** Returns the authenticated user's name. */
  async fetchMe(): Promise<{ name: string | null }> { return (await this.fetch("/api/auth/me")).json(); }
  /** Revokes all active tokens (locks all sessions). */
  async lockAll(): Promise<void> { await this.fetch("/api/auth/lock", { method: "POST" }); }
  /** Lightweight token validity check. Throws ModusError on explicit unauthorized. */
  async checkToken(): Promise<"agent" | "browser" | undefined> {
    const r = await this.fetch("/api/auth/check");
    if (!r.ok) {
      throw new ModusError(r.status, r.statusText || "auth check failed", "/api/auth/check");
    }
    const data = await r.json() as { kind?: "agent" | "browser" };
    return data.kind;
  }
  /** Changes the auth PIN. Throws if the old PIN is wrong. */
  async changePin(oldPin: string, newPin: string): Promise<void> {
    const res = await this.fetch("/api/auth/change-pin", { method: "POST", body: JSON.stringify({ oldPin, newPin }) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as any).error || "Failed to change PIN"); }
  }
  /** Replaces a forgotten file-managed PIN using local host authority. */
  async resetPin(newPin: string): Promise<void> {
    const res = await this.fetch("/api/auth/reset-pin", { method: "POST", body: JSON.stringify({ newPin }) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as any).error || "Failed to reset PIN"); }
  }
  /** Disables a file-managed browser PIN using local host authority. */
  async disablePin(): Promise<void> {
    const res = await this.fetch("/api/auth/disable-pin", { method: "POST" });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as any).error || "Failed to disable PIN"); }
  }
  /** Checks server health. No auth required. */
  async healthCheck(): Promise<{ status: string; uptime: number }> { return (await globalThis.fetch(`${this.url}/health`)).json(); }

  // ── Sessions ──
  /** Lists sessions, optionally filtered by limit, user profile, action, or agent profile. */
  async listSessions(opts?: { limit?: number; userProfile?: string; action?: string; profile?: string }): Promise<SessionInfo[]> {
    const p = new URLSearchParams();
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.userProfile) p.set("userProfile", opts.userProfile);
    if (opts?.action) p.set("action", opts.action);
    if (opts?.profile) p.set("profile", opts.profile);
    const q = p.toString();
    return (await this.fetch(`/api/sessions${q ? `?${q}` : ""}`)).json();
  }
  /** Returns a lightweight, project-attributed snapshot across every project. */
  async getSessionIndex(limit = 250): Promise<SessionIndex> {
    return (await this.fetch(`/api/sessions/index?limit=${encodeURIComponent(String(limit))}`)).json();
  }
  /** Returns currently running sessions, optionally scoped to a user profile. */
  async getActiveSessions(userProfile?: string): Promise<ActiveSessionInfo[]> {
    const q = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : "";
    return (await this.fetch(`/api/sessions/active${q}`)).json();
  }
  /** Returns the status of a single session. */
  async getSessionStatus(id: string): Promise<SessionStatusInfo> { return (await this.fetch(`/api/sessions/${id}/status`)).json(); }
  /** Creates and optionally starts a session with the given profile, prompt, and config.
   *
   *  Throws on a rejected create. An error body has no `sessionId`, and callers
   *  destructure one out and key their store on it — so swallowing the status
   *  turns a 400 into an `undefined` session id that reaches a Map as a key and
   *  breaks every later lookup, long after the request that caused it. */
  async createSession(opts: CreateSessionOpts): Promise<{ sessionId: string; status: string }> {
    return (await this.fetchOrThrow("/api/sessions", { method: "POST", body: JSON.stringify(opts) })).json();
  }
  /** Creates a session without starting it, returning just the session ID. Throws on a rejected create. */
  async createEmptySession(opts?: { profile?: string; model?: string; provider?: string; cwd?: string; userProfile?: string }): Promise<string> {
    const data = await (await this.fetchOrThrow("/api/sessions/empty", { method: "POST", body: JSON.stringify(opts ?? {}) })).json();
    return data.sessionId;
  }
  /** Queues a message to a session. Accepts a string prompt or a SendMessageOpts object; string form uses the remaining args for attachments and config. */
  async sendMessage(sessionId: string, opts: SendMessageOpts | string, attachments?: ApiAttachment[], config?: Record<string, unknown>): Promise<{ queued: boolean; status: string; dispatchId?: string }> {
    const body = typeof opts === "string" ? { prompt: opts, attachments, ...config } : opts;
    return (await this.fetch(`/api/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify(body) })).json();
  }
  async cancelQueuedDispatch(sessionId: string, dispatchId: string): Promise<{ ok: boolean }> {
    return (await this.fetch(`/api/sessions/${sessionId}/dispatch/${dispatchId}`, { method: "DELETE" })).json();
  }
  /** Stops a running session. */
  async stopSession(id: string): Promise<void> { await this.fetch(`/api/sessions/${id}/stop`, { method: "POST" }); }
  /** Stops a specific task within a session. */
  async stopTask(id: string, taskId: string): Promise<{ ok: boolean }> {
    return (await this.fetch(`/api/sessions/${id}/stop-task`, { method: "POST", body: JSON.stringify({ taskId }) })).json();
  }
  /** Injects a steering prompt mid-turn without waiting for completion. `mode`
   *  distinguishes a live injection ("steer") from a fallback queue ("queued",
   *  cancellable via `dispatchId`). Takes the same move bindings as sendMessage. */
  async steerSession(id: string, prompt: string, attachments?: unknown[], moves?: MoveBinding[]): Promise<SteerResult> {
    return (await this.fetchOrThrow(`/api/sessions/${id}/steer`, { method: "POST", body: JSON.stringify({ prompt, attachments, moves }) })).json();
  }
  /** Gets rendered message content. With a seq number, returns a single turn; without, returns all turns. */
  async getMessages(id: string, seq?: number): Promise<TurnContent | TurnContent[]> {
    const q = seq != null ? `?seq=${seq}` : "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetchOrThrow(`/api/sessions/${id}/messages-content${q}`, {
        signal: controller.signal,
      });
      const data = await response.json() as TurnContent | TurnContent[];
      const turns = Array.isArray(data) ? data : [data];
      if (turns.some((turn) => (
        !turn || (turn.role !== "user" && turn.role !== "assistant")
        || typeof turn.seq !== "number" || typeof turn.text !== "string"
      ))) {
        throw new Error("Invalid message content response");
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Gets a semantic history snapshot for ordinary session hydration. */
  async getSessionHistorySnapshot(id: string, opts?: { signal?: AbortSignal; limit?: number | "all"; beforeSeq?: number; beforeCreatedAt?: number; beforeId?: number; details?: "full" | "summary" }): Promise<SessionHistorySnapshot> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.beforeSeq != null) params.set("beforeSeq", String(opts.beforeSeq));
    if (opts?.beforeCreatedAt != null) params.set("beforeCreatedAt", String(opts.beforeCreatedAt));
    if (opts?.beforeId != null) params.set("beforeId", String(opts.beforeId));
    if (opts?.details) params.set("details", opts.details);
    const q = params.toString();
    return (await this.fetch(`/api/sessions/${id}/history-snapshot${q ? `?${q}` : ""}`, { signal: opts?.signal })).json();
  }
  /** Lists every turn in a session with no bodies — for surfaces that navigate
   *  by turn and need the shape of the conversation before its content. */
  async getSessionTurnIndex(id: string, opts?: { signal?: AbortSignal; limit?: number }): Promise<SessionTurnIndex> {
    const q = opts?.limit != null ? `?limit=${opts.limit}` : "";
    return (await this.fetch(`/api/sessions/${id}/turns${q}`, { signal: opts?.signal })).json();
  }
  /** Discovers conversation lens recipes and trusted-local projection modules
   *  under project → Vault → enabled exposed plugin → harness precedence. */
  async listConversationResources(cwd: string, opts?: { signal?: AbortSignal }): Promise<ConversationResourceRegistry> {
    return (await this.fetch(`/api/conversation-lenses?cwd=${encodeURIComponent(cwd)}`, {
      signal: opts?.signal,
    })).json();
  }
  /** Soft-deletes (archives) a session. */
  async archiveSession(id: string): Promise<void> { await this.fetch(`/api/sessions/${id}`, { method: "DELETE" }); }

  async markSessionReplyRead(id: string, seq: number): Promise<{ last_reply_seq: number; read_reply_seq: number }> {
    const response = await this.fetchOrThrow(`/api/sessions/${encodeURIComponent(id)}/read`, {
      method: "POST", body: JSON.stringify({ seq }),
    });
    return response.json();
  }
  /** Restores an archived session. */
  async unarchiveSession(id: string): Promise<void> { await this.fetch(`/api/sessions/${id}/unarchive`, { method: "POST" }); }
  /** Lists archived sessions. */
  async listArchivedSessions(limit?: number): Promise<SessionInfo[]> {
    const q = limit ? `?limit=${limit}` : "";
    return (await this.fetch(`/api/sessions/archived${q}`)).json();
  }
  /** Sets or clears a session's title (pass null to clear). */
  async updateTitle(id: string, title: string | null): Promise<void> {
    await this.fetch(`/api/sessions/${id}/title`, { method: "PATCH", body: JSON.stringify({ title }) });
  }
  /** All words/quoted phrases must match within a session. Defaults to relevance order. */
  async searchSessions(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    const p = new URLSearchParams({ q: query });
    if (opts?.limit !== undefined) p.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) p.set("offset", String(opts.offset));
    if (opts?.sort) p.set("sort", opts.sort);
    if (opts?.userProfile) p.set("userProfile", opts.userProfile);
    return (await this.fetch(`/api/sessions/search?${p}`)).json();
  }

  // ── Tags ──
  /** Returns all tags on a session. */
  async getTags(id: string): Promise<string[]> { const d: SessionTagsResult = await (await this.fetch(`/api/sessions/${id}/tags`)).json(); return d.tags; }
  /** Adds a tag to a session. */
  async addTag(id: string, tag: string): Promise<SessionTagsResult> {
    const res = await this.fetch(`/api/sessions/${id}/tags`, { method: "PATCH", body: JSON.stringify({ add: tag }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new ModusError(res.status, typeof d?.error === "string" ? d.error : "Failed to update session tags", `/api/sessions/${id}/tags`);
    return { tags: Array.isArray(d?.tags) ? d.tags : [] };
  }
  /** Removes a tag from a session. */
  async removeTag(id: string, tag: string): Promise<SessionTagsResult> {
    const res = await this.fetch(`/api/sessions/${id}/tags`, { method: "PATCH", body: JSON.stringify({ remove: tag }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new ModusError(res.status, typeof d?.error === "string" ? d.error : "Failed to update session tags", `/api/sessions/${id}/tags`);
    return { tags: Array.isArray(d?.tags) ? d.tags : [] };
  }
  /** Finds a session by its tag (unique lookup). Throws if not found. */
  async getSessionByTag(tag: string): Promise<{ id: string; status: string; profile: string; tags: string[]; createdAt: string; updatedAt: string }> {
    return (await this.fetchOrThrow(`/api/sessions/by-tag/${encodeURIComponent(tag)}`)).json();
  }

  // ── Session Config ──
  /** Patches a session's runtime config (model, provider, etc.). */
  async updateConfig(id: string, config: Record<string, unknown>): Promise<{ ok: boolean }> {
    return (await this.fetch(`/api/sessions/${id}/config`, { method: "PATCH", body: JSON.stringify(config) })).json();
  }
  /** Switches a session's agent profile mid-conversation. */
  async switchProfile(id: string, profile: string, contextMode?: string): Promise<{ ok: boolean; profile: string }> {
    const res = await this.fetch(`/api/sessions/${id}/profile`, { method: "PATCH", body: JSON.stringify({ profile, contextMode }) });
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return { error: text }; } })() : {};
    if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : `Profile switch failed (${res.status})`);
    return data;
  }
  /** Responds to a pending permission request (allow/deny). */
  async respondToPermission(id: string, opts: PermissionResponseOpts | PermissionResponse): Promise<{ ok: boolean }> {
    return (await this.fetch(`/api/sessions/${id}/permission-response`, { method: "POST", body: JSON.stringify(opts) })).json();
  }
  /** Previews both the provider-native conversation fork and exact managed-file workspace actions. */
  async previewBranch(id: string, seq: number, opts?: { restoreCode?: boolean; checkpointSeq?: number; providerMessageId?: string }): Promise<BranchPreview> {
    const d = await (await this.fetch(`/api/sessions/${id}/branch/preview`, { method: "POST", body: JSON.stringify({ seq, ...opts }) })).json();
    if (d.error) throw new Error(d.error);
    return d;
  }
  /** Creates a branch only after an explicit, freshly displayed confirmation. */
  async branchSession(id: string, seq: number, opts: { restoreCode?: boolean; checkpointSeq?: number; providerMessageId?: string; confirmed: true }): Promise<BranchResult> {
    const d = await (await this.fetch(`/api/sessions/${id}/branch`, { method: "POST", body: JSON.stringify({ seq, ...opts }) })).json();
    if (d.error) throw new Error(d.error);
    return d;
  }
  /** Previews an exact checkpoint restore, including an undo checkpoint. */
  async previewCheckpointRestore(id: string, checkpointId: number): Promise<RewindPreview> {
    const d = await (await this.fetch(`/api/sessions/${id}/checkpoints/${checkpointId}/preview`)).json();
    if (d.error) throw new Error(d.error);
    return d;
  }
  /** Restores a previously previewed checkpoint. The server requires confirmation again. */
  async restoreCheckpoint(id: string, checkpointId: number, confirmed: true): Promise<RewindResult> {
    const d = await (await this.fetch(`/api/sessions/${id}/checkpoints/${checkpointId}/restore`, { method: "POST", body: JSON.stringify({ confirmed }) })).json();
    if (d.error) throw new Error(d.error);
    return d;
  }

  // ── Draft / UI State ──
  /** Returns the unsent message draft for a session, or empty string if none. */
  async getDraft(id: string): Promise<string> { const d = await (await this.fetch(`/api/ui/sessions/${id}/draft`)).json(); return d.draft ?? ""; }
  /** Saves an unsent message draft for a session. */
  async saveDraft(id: string, draft: string): Promise<void> { await this.fetch(`/api/ui/sessions/${id}/draft`, { method: "PUT", body: JSON.stringify({ draft }) }); }
  /** Returns arbitrary UI state for a session. */
  async getSessionUiState(id: string): Promise<Record<string, unknown>> { return (await this.fetch(`/api/ui/sessions/${id}/state`)).json(); }
  /** Patches arbitrary UI state for a session (shallow merge). */
  async saveSessionUiState(id: string, patch: Record<string, unknown>): Promise<void> { await this.fetch(`/api/ui/sessions/${id}/state`, { method: "PATCH", body: JSON.stringify(patch) }); }

  // ── Events (SSE) ──
  /** Subscribes to SSE events for a session via callbacks. Returns an unsubscribe function. Fires onDone on server completion, onDisconnect (or onDone) on connection loss. */
  subscribeEvents(sessionId: string, afterSeq: number, callbacks: EventStreamCallbacks): () => void {
    const abort = new AbortController();
    const params = `after=${afterSeq}`;
    const url = `${this.url}/api/sessions/${sessionId}/events?${params}`;
    let doneFired = false, gotServerDone = false;
    const fireDone = () => { if (doneFired) return; doneFired = true; gotServerDone ? callbacks.onDone() : (callbacks.onDisconnect ?? callbacks.onDone)(); };
    globalThis.fetch(url, { signal: abort.signal, headers: this.authHeaders() }).then(async (res) => {
      if (!res.ok) { callbacks.onError(`Event stream failed: ${res.statusText}`); return; }
      const reader = res.body?.getReader();
      if (!reader) { callbacks.onError("No response body"); return; }
      const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        let currentEvent = "", currentId = "0";
        for (const line of lines) {
          if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
          else if (line.startsWith("id: ")) currentId = line.slice(4).trim();
          else if (line.startsWith("data: ")) {
            if (currentEvent === "done") { gotServerDone = true; fireDone(); }
            else { try { callbacks.onEvent(JSON.parse(line.slice(6)), Number(currentId) || 0); } catch {} }
          }
        }
      }
      fireDone();
    }).catch((err) => { if (err.name !== "AbortError") callbacks.onError(String(err)); });
    return () => abort.abort();
  }
  /** Subscribes to the global session event stream (all sessions). Returns an async-iterable EventStreamHandle. */
  subscribeGlobalEvents(): EventStreamHandle {
    const controller = new AbortController(); const self = this;
    const events = (async function* () {
      let staleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetStale = () => {
        if (staleTimer) clearTimeout(staleTimer);
        staleTimer = setTimeout(() => controller.abort(), 45_000);
      };
      const res = await globalThis.fetch(`${self.url}/api/events/sessions`, {
        signal: controller.signal,
        headers: self.authHeaders(),
      });
      if (!res.ok) throw new ModusError(res.status, res.statusText, "/api/events/sessions");
      const reader = res.body?.getReader(); if (!reader) throw new Error("No response body");
      resetStale();
      try {
        yield* parseSSEStream(reader, resetStale);
      } finally {
        if (staleTimer) clearTimeout(staleTimer);
      }
    })();
    return { events, abort: () => controller.abort() };
  }

  // ── Profiles ──
  /** Lists agent profiles, optionally scoped to a project directory. */
  /** Pass `includeUi` to resolve each profile's UI config in the same response instead of one request per profile. */
  async listProfiles(cwd?: string, opts?: { includeUi?: boolean }): Promise<Profile[]> { const params = new URLSearchParams(); if (cwd) params.set("cwd", cwd); if (opts?.includeUi) params.set("ui", "1"); const q = params.toString(); return (await this.fetch(`/api/profiles${q ? `?${q}` : ""}`)).json(); }
  /** Returns a single agent profile by name. Throws on not found. */
  async getProfile(name: string, cwd?: string): Promise<Profile> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; return (await this.fetchOrThrow(`/api/profiles/${encodeURIComponent(name)}${q}`)).json(); }
  async getResolvedProfileConfig(name: string, opts?: { cwd?: string; sessionId?: string }): Promise<ResolvedProfileConfig> { const params = new URLSearchParams(); if (opts?.cwd) params.set("cwd", opts.cwd); if (opts?.sessionId) params.set("sessionId", opts.sessionId); const q = params.toString(); return (await this.fetchOrThrow(`/api/profiles/${encodeURIComponent(name)}/resolved-config${q ? `?${q}` : ""}`)).json(); }
  /** Returns the UI configuration for an agent profile. */
  async getProfileUiConfig(name: string, cwd?: string): Promise<ProfileUi> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; const r = await this.fetch(`/api/profiles/${encodeURIComponent(name)}/ui-config${q}`); if (!r.ok) throw new Error(`Profile UI config not found: ${name}`); return r.json(); }
  /** Creates or fully replaces an agent profile. */
  async saveProfile(name: string, profile: Record<string, unknown>, cwd?: string): Promise<void> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; const r = await this.fetch(`/api/profiles/${encodeURIComponent(name)}${q}`, { method: "PUT", body: JSON.stringify(profile) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to save profile: ${name}`); } }
  /** Partially updates an agent profile's UI config. */
  async patchProfileUiConfig(name: string, patch: Partial<ProfileUi>, cwd?: string): Promise<void> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; const r = await this.fetch(`/api/profiles/${encodeURIComponent(name)}/ui-config${q}`, { method: "PATCH", body: JSON.stringify(patch) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to update profile UI config: ${name}`); } }
  /** Deletes an agent profile. */
  async deleteProfile(name: string, cwd?: string): Promise<void> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; await this.fetch(`/api/profiles/${encodeURIComponent(name)}${q}`, { method: "DELETE" }); }
  /** Returns the global config (_global.json), optionally merged with project-level config when cwd is provided. */
  async getGlobalConfig(cwd?: string, opts?: { stored?: boolean }): Promise<GlobalConfig> { const params = new URLSearchParams(); if (cwd) params.set("cwd", cwd); if (opts?.stored) params.set("stored", "1"); const q = params.toString(); return (await this.fetch(`/api/profiles/_global${q ? `?${q}` : ""}`)).json(); }
  /** Saves the global config. */
  async saveGlobalConfig(config: GlobalConfig, cwd?: string): Promise<void> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; const r = await this.fetch(`/api/profiles/_global${q}`, { method: "PUT", body: JSON.stringify(config) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || "Failed to save global config"); } }
  /** Checks which environment variable names have values set in the secrets store. */
  async checkSecrets(vars: string[]): Promise<{ status: Record<string, boolean>; secretsFile: string }> { return (await this.fetch("/api/secrets/check", { method: "POST", body: JSON.stringify({ vars }) })).json(); }

  // ── Prompt Cache ──
  /** Returns the user's saved prompt cache. */
  async getPromptCache(): Promise<PromptCache> { return (await this.fetch("/api/prompt-cache")).json(); }
  /** Overwrites the user's saved prompt cache. */
  async savePromptCache(cache: PromptCache): Promise<void> { const r = await this.fetch("/api/prompt-cache", { method: "PUT", body: JSON.stringify(cache) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || "Failed to save prompt cache"); } }

  // ── Providers ──
  /** Lists registered provider names. */
  async listProviders(): Promise<string[]> { return (await this.fetch("/api/providers")).json(); }
  /** Lists providers that can answer a one-shot completion without spawning a session. */
  async listOneShotProviders(): Promise<string[]> { return (await this.fetch("/api/providers/one-shot")).json(); }
  /** Returns capabilities for all providers (streaming, tools, vision, etc.). */
  async getProviderCapabilities(): Promise<ProviderCapabilities[]> { return (await this.fetch("/api/provider-capabilities")).json(); }
  /** Returns health/reachability status of all providers. */
  async getProviderHealth(): Promise<ProviderHealthInfo[]> { return (await this.fetch("/api/provider-health")).json(); }
  /** Explicitly probes known localhost ports and returns definition proposals without registering them. */
  async detectLocalProviders(): Promise<DetectedProvider[]> { return (await this.fetchOrThrow("/api/providers/detect", { method: "POST" })).json(); }
  /** Lists available models for a provider. Returns empty array on error. */
  async getProviderModels(provider: string): Promise<ProviderModel[]> { const r = await this.fetch(`/api/providers/${encodeURIComponent(provider)}/models`); if (!r.ok) return []; return r.json(); }

  // ── Text To Speech ──
  async getTextToSpeechConfig(cwd?: string): Promise<TextToSpeechConfig> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return (await this.fetch(`/api/tts/config${q}`)).json();
  }

  async patchTextToSpeechConfig(config: TextToSpeechConfig, cwd?: string): Promise<TextToSpeechConfig> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return (await this.fetchOrThrow(`/api/tts/config${q}`, {
      method: "PATCH",
      body: JSON.stringify(config),
    })).json();
  }

  async getTextToSpeechHealth(cwd?: string): Promise<TtsProviderHealth[]> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return (await this.fetch(`/api/tts/health${q}`)).json();
  }

  async listTextToSpeechVoices(provider?: TextToSpeechProviderId, cwd?: string): Promise<{ provider: TextToSpeechProviderId; voices: string[] }> {
    const p = new URLSearchParams();
    if (provider) p.set("provider", provider);
    if (cwd) p.set("cwd", cwd);
    const q = p.toString();
    return (await this.fetch(`/api/tts/voices${q ? `?${q}` : ""}`)).json();
  }

  // ── User Profiles ──
  /** Lists all user profiles. */
  /** Pass `includeUi` to resolve each profile's UI config (including clientExtensions) in the same response. */
  async listUserProfiles(opts?: { includeUi?: boolean }): Promise<UserProfile[]> { return (await this.fetch(`/api/user-profiles${opts?.includeUi ? "?ui=1" : ""}`)).json(); }
  /** Returns a single user profile. Throws if not found. */
  async getUserProfile(name: string): Promise<UserProfile> { const r = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}`); if (!r.ok) throw new Error(`User profile not found: ${name}`); return r.json(); }
  /** Returns UI config for a user profile. */
  async getUserProfileUiConfig(name: string): Promise<UserProfileUiConfig> { const r = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}/ui-config`); if (!r.ok) throw new Error(`User profile UI config not found: ${name}`); return r.json(); }
  /** Creates or fully replaces a user profile. */
  async saveUserProfile(name: string, profile: Record<string, unknown>): Promise<void> { const r = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(profile) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to save user profile: ${name}`); } }
  /** Partially updates a user profile. */
  async patchUserProfile(name: string, patch: Partial<UserProfile>): Promise<void> { const r = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify(patch) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to update user profile: ${name}`); } }
  /** Partially updates a user profile's UI config. */
  async patchUserProfileUiConfig(name: string, patch: Partial<UserProfileUiConfig>): Promise<void> { const r = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}/ui-config`, { method: "PATCH", body: JSON.stringify(patch) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to update user profile UI config: ${name}`); } }
  /** Returns runtime state for a user profile (selected session, etc.). */
  async getUserProfileState(name: string): Promise<UserProfileState> { return (await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}/state`)).json(); }
  /** Partially updates a user profile's runtime state. */
  async patchUserProfileState(name: string, patch: Partial<UserProfileState>): Promise<void> { await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}/state`, { method: "PATCH", body: JSON.stringify(patch) }); }

  // ── Skills ──
  /** Lists skills installed for a project (project, user home, enabled plugins). Empty on error. */
  async listSkills(cwd: string): Promise<SkillListItem[]> { const r = await this.fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) return []; return r.json(); }
  /** Reads one skill's full SKILL.md text. Null when it does not resolve. */
  async getSkill(name: string, cwd: string): Promise<SkillContent | null> { const r = await this.fetch(`/api/skills/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) return null; return r.json(); }

  // ── Moves ──
  /** Lists available moves for a project. Returns empty array on error. */
  async listMoves(cwd: string): Promise<MoveListItem[]> { const r = await this.fetch(`/api/moves?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) return []; return r.json(); }
  /** Constructs the URL for a move's widget HTML. */
  getWidgetUrl(moveName: string, cwd: string): string { const q = new URLSearchParams({ cwd }); const token = this.browserSessionToken; if (token) q.set("token", token); return `${this.url}/api/moves/${encodeURIComponent(moveName)}/widget?${q}`; }
  /** Constructs the URL for a move's widget CSS. */
  getWidgetCssUrl(moveName: string, cwd: string): string { const q = new URLSearchParams({ cwd }); const token = this.browserSessionToken; if (token) q.set("token", token); return `${this.url}/api/moves/${encodeURIComponent(moveName)}/widget.css?${q}`; }
  /**
   * Activate a move within an existing session. The session must already exist
   * and have a running provider. Use this when you have an active session and
   * want to add a move to it (e.g., ambient context, inline gathering).
   *
   * If you don't have a session yet, use `activateProjectMove()` which creates one.
   */
  async activateMove(sessionId: string, body: { moveName: string; inputs: Record<string, unknown>; cwd: string; userProfile?: string; modeOverride?: "inline" | "branch" | "background"; forceNewSession?: boolean }): Promise<ActivateMoveResult> {
    const r = await this.fetch(`/api/sessions/${sessionId}/moves/activate`, { method: "POST", body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({ error: "move activation failed" })); if (!r.ok) throw new Error(d.error ?? "move activation failed"); return d;
  }
  /**
   * Activate a move at project level, creating a new session automatically.
   * Use this when you want to launch a move without managing session lifecycle.
   * The harness creates an empty session, activates the move, and returns the
   * API token + session ID.
   *
   * This is the simplest activation path for standalone/widget moves.
   */
  async activateProjectMove(body: { moveName: string; inputs: Record<string, unknown>; cwd: string; userProfile?: string; modeOverride?: "inline" | "branch" | "background"; forceNewSession?: boolean }): Promise<ActivateMoveResult> {
    const r = await this.fetch("/api/moves/activate", { method: "POST", body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({ error: "move activation failed" })); if (!r.ok) throw new Error(d.error ?? "move activation failed"); return d;
  }
  /** Calls a named operation on an active move instance. */
  async callMoveOp(moveName: string, apiToken: string, op: string, data?: Record<string, unknown>): Promise<{ ok: boolean; message?: string; error?: string } & Record<string, unknown>> {
    return (await this.fetch(`/api/moves/${moveName}/op`, { method: "POST", body: JSON.stringify({ apiToken, op, ...data }) })).json();
  }
  /** Returns all active move widgets for a session. Returns empty array on error. */
  async getActiveWidgets(sessionId: string): Promise<Array<{ widget: MoveWidgetInfo; apiToken: string; instanceId: string }>> { const r = await this.fetch(`/api/sessions/${sessionId}/moves/widget`); if (!r.ok) return []; return r.json(); }
  /** Reassigns a move's session binding (used during session handoff). */
  async rekeyMoveSession(oldId: string, newId: string): Promise<void> { await this.fetch(`/api/sessions/${oldId}/moves/rekey`, { method: "POST", body: JSON.stringify({ newSessionId: newId }) }); }
  /** Reassigns a move's session by its API token. */
  async rekeyMoveByToken(apiToken: string, newId: string): Promise<void> { await this.fetch("/api/moves/rekey-by-token", { method: "POST", body: JSON.stringify({ apiToken, newSessionId: newId }) }); }
  /**
   * Attach a move's widget before any agent interaction (phase 1 of widget-first lifecycle).
   * Only works for moves with `mountOnAttach: true` in their widget config.
   * Returns an API token and instance ID for subsequent widget communication.
   * Use `activateAttached()` to start the agent after the widget is mounted.
   *
   * For moves without `mountOnAttach`, use `activateMove()` (existing session)
   * or `activateProjectMove()` (creates session automatically).
   */
  async attachMove(body: { moveName: string; inputs: Record<string, unknown>; cwd: string; sessionId?: string; userProfile?: string }): Promise<AttachMoveResult> {
    const r = await this.fetch(`/api/moves/${body.moveName}/attach`, { method: "POST", body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({ error: "attach failed" })); if (!r.ok) throw new Error(d.error ?? "attach failed"); return d;
  }
  /** Activates a previously attached move. */
  async activateAttached(moveName: string, apiToken: string, text?: string, userProfile?: string): Promise<{ ok: boolean; prompt?: string; moveRunId?: number; error?: string }> {
    return (await this.fetch(`/api/moves/${encodeURIComponent(moveName)}/activate-attached`, { method: "POST", body: JSON.stringify({ apiToken, text, userProfile }) })).json();
  }
  /** Detaches a move from its session. */
  async detachMove(moveName: string, apiToken: string): Promise<void> { await this.fetch(`/api/moves/${moveName}/detach`, { method: "POST", body: JSON.stringify({ apiToken }) }); }
  /**
   * Launch a move with the simplest possible API. Automatically chooses the
   * right activation path:
   * - If `sessionId` is provided: calls `activateMove()` on that session
   * - Otherwise: calls `activateProjectMove()` to create a new session
   *
   * Returns the complete activation result. For inline moves, activation only
   * gathers the prompt: `requiresDispatch` is true and the caller must send
   * `prompt` to its target session.
   */
  async launchMove(moveName: string, cwd: string, opts?: {
    sessionId?: string;
    inputs?: Record<string, unknown>;
    userProfile?: string;
    modeOverride?: "inline" | "branch" | "background";
    forceNewSession?: boolean;
  }): Promise<ActivateMoveResult> {
    const inputs = opts?.inputs ?? {};
    if (opts?.sessionId) {
      return this.activateMove(opts.sessionId, {
        moveName, inputs, cwd, userProfile: opts.userProfile,
        modeOverride: opts.modeOverride, forceNewSession: opts.forceNewSession,
      });
    }
    return this.activateProjectMove({
      moveName, inputs, cwd, userProfile: opts?.userProfile,
      modeOverride: opts?.modeOverride, forceNewSession: opts?.forceNewSession,
    });
  }

  /** Lists ambient (always-active, context-injecting) moves on a session. Returns empty array on error. */
  async listAmbientMoves(sessionId: string): Promise<AmbientMoveInfo[]> { const r = await this.fetch(`/api/sessions/${sessionId}/moves/ambient`); if (!r.ok) return []; return r.json(); }
  /** Deactivates an ambient move on a session. */
  async deactivateAmbient(sessionId: string, moveName: string): Promise<{ ok: boolean; moveName: string }> {
    return (await this.fetch(`/api/sessions/${sessionId}/moves/deactivate`, { method: "POST", body: JSON.stringify({ moveName }) })).json();
  }

  // ── Actions ──
  private actionScopeQuery(scope?: { userProfile?: string | null; cwd?: string | null } | string | null, limit?: number): string {
    const p = new URLSearchParams();
    if (typeof scope === "string") p.set("userProfile", scope);
    else if (scope) {
      if (scope.userProfile) p.set("userProfile", scope.userProfile);
      if (scope.cwd) p.set("cwd", scope.cwd);
    }
    if (limit != null) p.set("limit", String(limit));
    const q = p.toString();
    return q ? `?${q}` : "";
  }
  /** Lists configured actions, optionally filtered by user profile and cwd. */
  async listActions(scope?: { userProfile?: string | null; cwd?: string | null } | string | null): Promise<ActionInfo[]> { return (await this.fetch(`/api/actions${this.actionScopeQuery(scope)}`)).json(); }
  /** Returns context source and config source paths for an action. */
  async getActionInfo(name: string, scope?: { userProfile?: string | null; cwd?: string | null } | string | null): Promise<{ contextSource: string; configSource: string }> { return (await this.fetch(`/api/actions/${encodeURIComponent(name)}/info${this.actionScopeQuery(scope)}`)).json(); }
  /** Manually triggers an action. */
  async triggerAction(name: string, scope?: { userProfile?: string | null; cwd?: string | null } | string | null, inputs?: Record<string, unknown>): Promise<void> {
    const body = { ...(typeof scope === "string" ? { userProfile: scope } : { userProfile: scope?.userProfile ?? undefined, cwd: scope?.cwd ?? undefined }), inputs };
    const r = await this.fetch(`/api/actions/${encodeURIComponent(name)}/trigger`, { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "trigger failed");
  }
  /** Cancel an operation and its managed process tree. */
  async cancelActionExecution(name: string, executionId: number, scope?: { userProfile?: string | null; cwd?: string | null }): Promise<void> {
    const response = await this.fetch(`/api/actions/${encodeURIComponent(name)}/executions/${executionId}${this.actionScopeQuery(scope)}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Unable to cancel action execution");
  }
  /** Updates action config fields (partial patch). */
  async patchAction(name: string, patch: Record<string, unknown>, scope?: { userProfile?: string | null; cwd?: string | null } | string | null): Promise<void> { await this.fetch(`/api/actions/${encodeURIComponent(name)}${this.actionScopeQuery(scope)}`, { method: "PATCH", body: JSON.stringify(patch) }); }
  /** Returns execution history for an action. */
  async getActionRuns(name: string, limit?: number, scope?: { userProfile?: string | null; cwd?: string | null } | string | null): Promise<ActionRun[]> { return (await this.fetch(`/api/actions/${encodeURIComponent(name)}/runs${this.actionScopeQuery(scope, limit)}`)).json(); }
  /** Deletes all run history for an action. */
  async clearRuns(name: string, scope?: { userProfile?: string | null; cwd?: string | null } | string | null): Promise<void> { await this.fetch(`/api/actions/${encodeURIComponent(name)}/runs${this.actionScopeQuery(scope)}`, { method: "DELETE" }); }
  /** Resets an action's state (clears runs, resets schedule). */
  async resetAction(name: string, skipConfirm?: boolean, scope?: { userProfile?: string | null; cwd?: string | null } | string | null): Promise<void> { await this.fetch(`/api/actions/${encodeURIComponent(name)}/reset${this.actionScopeQuery(scope)}`, { method: "POST", body: JSON.stringify({ skipConfirm }) }); }
  /** Re-scans and reloads all action configs from disk. */
  async reloadActions(scope?: { userProfile?: string | null; cwd?: string | null } | string | null): Promise<{ ok: boolean; count: number; errors?: Array<{ name: string; error: string }> }> { return (await this.fetch(`/api/actions/reload${this.actionScopeQuery(scope)}`, { method: "POST" })).json(); }
  /** Returns user preferences for an action. */
  async getActionPreferences(name: string, scope?: { userProfile?: string | null; cwd?: string | null } | string | null): Promise<Record<string, boolean>> { return (await this.fetch(`/api/actions/${encodeURIComponent(name)}/preferences${this.actionScopeQuery(scope)}`)).json(); }
  /** Adds a tag to an action. */
  async addActionTag(name: string, tag: string, scope?: { userProfile?: string | null; cwd?: string | null } | string | null): Promise<void> { await this.fetch(`/api/actions/${encodeURIComponent(name)}/tags${this.actionScopeQuery(scope)}`, { method: "POST", body: JSON.stringify({ tag }) }); }
  /** Removes a tag from an action. */
  async removeActionTag(name: string, tag: string, scope?: { userProfile?: string | null; cwd?: string | null } | string | null): Promise<void> { await this.fetch(`/api/actions/${encodeURIComponent(name)}/tags/${encodeURIComponent(tag)}${this.actionScopeQuery(scope)}`, { method: "DELETE" }); }

  // ── Missions ──
  /** Lists available mission definitions for a project. Returns empty array on error. */
  async listMissions(cwd: string): Promise<MissionListItem[]> { const r = await this.fetch(`/api/missions?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) return []; return r.json(); }
  /** Lists mission execution runs, filterable by cwd, status, and limit. Returns empty array on error. */
  async listMissionRuns(opts?: { cwd?: string; status?: MissionRunStatus; limit?: number }): Promise<MissionRunSummary[]> {
    const p = new URLSearchParams(); if (opts?.cwd) p.set("cwd", opts.cwd); if (opts?.status) p.set("status", opts.status); if (opts?.limit) p.set("limit", String(opts.limit));
    const q = p.toString(); const r = await this.fetch(`/api/missions/runs${q ? `?${q}` : ""}`); if (!r.ok) return []; return r.json();
  }
  /** Returns details of a single mission run, or null if not found. */
  async getMissionRun(id: number): Promise<MissionRunSummary | null> { const r = await this.fetch(`/api/missions/runs/${id}`); if (!r.ok) return null; return r.json(); }
  /** Returns step execution details for a mission run. Returns empty array on error. */
  async getMissionSteps(runId: number): Promise<MissionStepRunSummary[]> { const r = await this.fetch(`/api/missions/runs/${runId}/steps`); if (!r.ok) return []; return r.json(); }
  /** Returns transfer events (step-to-step handoffs) for a mission run. Returns empty array on error. */
  async getMissionTransfers(runId: number): Promise<MissionTransferSummary[]> { const r = await this.fetch(`/api/missions/runs/${runId}/transfers`); if (!r.ok) return []; return r.json(); }
  /** Returns gate results (approval checkpoints) for a mission run. Returns empty array on error. */
  async getMissionGates(runId: number): Promise<MissionGateResultSummary[]> { const r = await this.fetch(`/api/missions/runs/${runId}/gates`); if (!r.ok) return []; return r.json(); }
  /** Returns session IDs spawned by a mission run. Returns empty array on error. */
  async getMissionSessions(runId: number): Promise<string[]> { const r = await this.fetch(`/api/missions/runs/${runId}/sessions`); if (!r.ok) return []; return r.json(); }
  /** Starts a new mission run. */
  async startMission(opts: { missionName: string; cwd: string; userProfile?: string }): Promise<{ runId: number }> {
    const r = await this.fetch("/api/missions/start", { method: "POST", body: JSON.stringify(opts) });
    const d = await r.json().catch(() => ({ error: "mission start failed" })); if (!r.ok) throw new Error(d.error ?? "mission start failed"); return d;
  }
  /** Pauses a running mission with a reason. */
  async pauseMission(id: number, reason: string): Promise<void> { const r = await this.fetch(`/api/missions/runs/${id}/pause`, { method: "POST", body: JSON.stringify({ reason }) }); if (!r.ok) { const d = await r.json().catch(() => ({ error: "pause failed" })); throw new Error(d.error ?? "pause failed"); } }
  /** Resumes a paused mission. */
  async resumeMission(id: number): Promise<void> { const r = await this.fetch(`/api/missions/runs/${id}/resume`, { method: "POST" }); if (!r.ok) { const d = await r.json().catch(() => ({ error: "resume failed" })); throw new Error(d.error ?? "resume failed"); } }

  // ── Git ──
  /** Returns git status (branch, clean/dirty, staged/unstaged files). */
  async gitStatus(cwd: string): Promise<GitStatus> { return (await this.fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)).json(); }
  /** Returns recent git commits. */
  async gitLog(cwd: string, limit?: number): Promise<GitCommit[]> { const p = new URLSearchParams({ cwd }); if (limit) p.set("limit", String(limit)); return (await this.fetch(`/api/git/log?${p}`)).json(); }
  /** Returns full commit details (message, diff, files). Throws on not found. */
  async gitShow(hash: string, cwd: string): Promise<GitCommitDetail> { return (await this.fetchOrThrow(`/api/git/show/${encodeURIComponent(hash)}?cwd=${encodeURIComponent(cwd)}`)).json(); }
  /** Returns diff for a specific file against HEAD. Throws on error. */
  async gitFileDiff(file: string, cwd: string): Promise<FileDiff[]> { return (await this.fetchOrThrow(`/api/git/file-diff?${new URLSearchParams({ cwd, file })}`)).json(); }
  /** Returns file content at a specific commit hash. Returns null on error. */
  async gitFileContent(path: string, cwd: string, hash: string): Promise<string | null> { const r = await this.fetch(`/api/git/file-content?${new URLSearchParams({ cwd, hash, path })}`); if (!r.ok) return null; const d = await r.json(); return d.content ?? null; }
  /** Returns the project README content. Returns null if not found. */
  async gitReadme(cwd: string): Promise<{ name: string; content: string } | null> { return (await this.fetch(`/api/git/readme?cwd=${encodeURIComponent(cwd)}`)).json(); }
  /** Opens a file in the user's editor (server-side). */
  async openInEditor(filePath: string, line?: number, editor?: string): Promise<void> { await this.fetch("/api/open-in-editor", { method: "POST", body: JSON.stringify({ filePath, line, editor }) }); }
  /** Opens a path in the OS native file explorer. If path is a file, reveals it in its parent folder. */
  async openInFolder(path: string): Promise<void> { await this.fetch("/api/open-in-folder", { method: "POST", body: JSON.stringify({ path }) }); }

  // ── Files ──
  /** Reads file content. Returns null on error. */
  async readFile(path: string): Promise<string | null> { const r = await this.fetch(`/api/file-read?path=${encodeURIComponent(path)}`); if (!r.ok) return null; const d = await r.json(); return d.content ?? null; }
  /** Writes content to a file, overwriting it. Inspect `.ok` — the result object
   *  is truthy either way, and `.code` says whether the path was denied,
   *  read-only, or something else. */
  async writeFile(path: string, content: string): Promise<FileMutationResult> {
    return toFileMutationResult(await this.fetch("/api/file-write", { method: "PUT", body: JSON.stringify({ path, content }) }));
  }
  /** Creates a new file with optional content. Fails with `code: "collision"`
   *  rather than overwriting an existing path. Inspect `.ok`. */
  async createFile(path: string, content?: string): Promise<FileMutationResult> {
    return toFileMutationResult(await this.fetch("/api/file-create", { method: "POST", body: JSON.stringify({ path, content }) }));
  }
  /** Creates a directory. Fails with `code: "collision"` when the path already
   *  exists. Inspect `.ok`. */
  async createDirectory(path: string): Promise<FileMutationResult> {
    return toFileMutationResult(await this.fetch("/api/dir-create", { method: "POST", body: JSON.stringify({ path }) }));
  }
  /** Lists directory contents with optional hidden files and file inclusion. */
  async browse(path?: string, opts?: { includeHidden?: boolean; includeFiles?: boolean }): Promise<BrowseResult> {
    const p = new URLSearchParams(); if (path) p.set("path", path); if (opts?.includeHidden) p.set("includeHidden", "1"); if (opts?.includeFiles) p.set("includeFiles", "1");
    const q = p.toString(); const r = await this.fetch(`/api/browse${q ? `?${q}` : ""}`); if (!r.ok) throw new Error("browse failed"); return r.json();
  }
  /** Searches for files within a workspace. Returns provider availability and matching hits. */
  async searchFiles(root: string, query: string, limit = 50): Promise<FileSearchResponse> {
    if (!query.trim()) return { available: true, provider: "none", results: [] };
    const p = new URLSearchParams({ root, q: query.trim(), limit: String(limit) });
    const r = await this.fetch(`/api/files/search?${p}`);
    if (!r.ok) throw new Error("file search failed");
    return r.json();
  }
  /** Returns safe preview metadata and a scoped raw URL for a local path. */
  async previewManifest(path: string, opts?: { cwd?: string; sessionId?: string; userProfile?: string }): Promise<PreviewManifest> {
    const p = new URLSearchParams({ path });
    if (opts?.cwd) p.set("cwd", opts.cwd);
    if (opts?.sessionId) p.set("sessionId", opts.sessionId);
    if (opts?.userProfile) p.set("userProfile", opts.userProfile);
    return (await this.fetchOrThrow(`/api/preview/manifest?${p}`)).json();
  }
  /** Builds a browser-loadable preview URL from a manifest raw URL, adding query-token auth when needed. */
  previewUrl(rawUrl: string): string {
    if (!rawUrl) return "";
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) return rawUrl;
    const resource = new URL(rawUrl, "http://modus.invalid");
    const token = this.browserSessionToken;
    if (token) resource.searchParams.set("token", token);
    return `${this.url}${resource.pathname}${resource.search}${resource.hash}`;
  }
  /** Lists recent previewable project/session outputs for the artifact shelf. */
  async artifactShelf(opts?: { cwd?: string; sessionId?: string; userProfile?: string; limit?: number }): Promise<ArtifactShelfResponse> {
    const p = new URLSearchParams();
    if (opts?.cwd) p.set("cwd", opts.cwd);
    if (opts?.sessionId) p.set("sessionId", opts.sessionId);
    if (opts?.userProfile) p.set("userProfile", opts.userProfile);
    if (opts?.limit) p.set("limit", String(opts.limit));
    return (await this.fetch(`/api/artifact-shelf?${p}`)).json();
  }

  // ── Memory ──
  /** Searches agent memory, scoped by user profile and project. */
  async queryMemories(opts?: { userProfile?: string; cwd?: string }): Promise<MemoryItem[]> {
    const p = new URLSearchParams(); if (opts?.userProfile) p.set("userProfile", opts.userProfile); if (opts?.cwd) p.set("cwd", opts.cwd);
    const q = p.toString(); return (await this.fetch(`/api/memories${q ? `?${q}` : ""}`)).json();
  }

  // ── Prompts ──
  /** Lists available prompt templates, optionally filtered by tags and project. */
  async listPrompts(opts?: { tags?: string[]; projectCwd?: string }): Promise<PromptListItem[]> {
    const p = new URLSearchParams(); if (opts?.tags?.length) p.set("tags", opts.tags.join(",")); if (opts?.projectCwd) p.set("projectCwd", opts.projectCwd);
    const q = p.toString(); return (await this.fetch(`/api/prompts${q ? `?${q}` : ""}`)).json();
  }
  /** Renders a prompt template with variables. Throws on render failure. */
  async renderPrompt(name: string, vars?: Record<string, unknown>): Promise<RenderResult> {
    const r = await this.fetch(`/api/prompts/${encodeURIComponent(name)}/render`, { method: "POST", body: JSON.stringify(vars ?? {}) });
    if (!r.ok) { const e = await r.json().catch(() => ({ error: "render failed" })); throw new Error(e.error ?? "render failed"); } return r.json();
  }
  /** Re-scans and reloads prompt templates from disk. */
  async reloadPrompts(): Promise<{ ok: boolean; count: number }> { return (await this.fetch("/api/prompts/reload", { method: "POST" })).json(); }

  // ── Stats / Analytics ──
  /** Returns session count and activity stats. */
  async getSessionStats(userProfile?: string): Promise<SessionStats> { const q = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : ""; return (await this.fetch(`/api/stats/sessions${q}`)).json(); }
  /** Returns account info (API key status, usage). */
  async getAccountInfo(userProfile?: string): Promise<AccountInfo> { const q = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : ""; return (await this.fetch(`/api/account${q}`)).json(); }
  /** Returns Claude subscription plan limits reported by the authenticated Claude Code CLI. */
  async getClaudePlanUsage(): Promise<ClaudePlanUsageSnapshot> { return (await this.fetch("/api/claude/usage")).json(); }
  /** Returns Gemini-specific usage info. */
  /** Returns provider usage breakdown over time. Defaults to 30 days. */
  async getProviderUsageAnalytics(userProfile?: string, days = 30): Promise<ProviderUsageAnalytics> {
    const p = new URLSearchParams(); if (userProfile) p.set("userProfile", userProfile); p.set("days", String(days));
    return (await this.fetch(`/api/analytics/provider-usage?${p}`)).json();
  }
  /** Returns detailed analytics with time bucketing and filters. */
  async getDeepAnalytics(opts: { start: number; end: number; bucketMs?: number; userProfile?: string; cwd?: string; provider?: string }): Promise<DeepAnalytics> {
    const p = new URLSearchParams(); p.set("start", String(opts.start)); p.set("end", String(opts.end));
    if (opts.bucketMs != null) p.set("bucketMs", String(opts.bucketMs)); if (opts.userProfile) p.set("userProfile", opts.userProfile); if (opts.cwd) p.set("cwd", opts.cwd); if (opts.provider) p.set("provider", opts.provider);
    return (await this.fetch(`/api/analytics/deep?${p}`)).json();
  }

  // ── Activity ──
  /** Returns activity log entries (audit trail), filterable by user profile, time, and event type. */
  async getActivity(opts?: { userProfile?: string; since?: number; limit?: number; eventType?: string }): Promise<ActivityEntry[]> {
    const p = new URLSearchParams(); if (opts?.userProfile) p.set("userProfile", opts.userProfile); if (opts?.since != null) p.set("since", String(opts.since)); if (opts?.limit != null) p.set("limit", String(opts.limit)); if (opts?.eventType) p.set("eventType", opts.eventType);
    const q = p.toString(); return (await this.fetchOrThrow(`/api/activity${q ? `?${q}` : ""}`)).json();
  }
  /** Returns a summarized activity report. */
  async getActivitySummary(opts?: { userProfile?: string; hours?: number }): Promise<ActivitySummaryResult> {
    const p = new URLSearchParams(); if (opts?.userProfile) p.set("userProfile", opts.userProfile); if (opts?.hours != null) p.set("hours", String(opts.hours));
    const q = p.toString(); return (await this.fetchOrThrow(`/api/activity/summary${q ? `?${q}` : ""}`)).json();
  }

  // ── Notes ──
  /** Lists notes for a project. */
  async listNotes(cwd: string): Promise<NoteListItem[]> { return (await this.fetchOrThrow(`/api/notes?cwd=${encodeURIComponent(cwd)}`)).json(); }
  /** Returns a single note. */
  async getNote(id: string, cwd: string): Promise<NoteDetail> { return (await this.fetchOrThrow(`/api/notes/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}`)).json(); }
  /** Creates a new note. */
  async createNote(cwd: string, note: { title?: string; content: string; tags?: string[] }): Promise<NoteDetail> { return (await this.fetchOrThrow("/api/notes", { method: "POST", body: JSON.stringify({ cwd, ...note }) })).json(); }
  /** Updates an existing note. */
  async updateNote(id: string, cwd: string, note: { title?: string; content?: string; tags?: string[] }): Promise<NoteDetail> { return (await this.fetchOrThrow(`/api/notes/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ cwd, ...note }) })).json(); }
  /** Deletes a note. */
  async deleteNote(id: string, cwd: string): Promise<void> { await this.fetchOrThrow(`/api/notes/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" }); }

  // ── Modus Plugins ──
  /** Lists user-registered Modus plugin roots. */
  async listPlugins(): Promise<ModusPlugin[]> {
    return (await this.fetchOrThrow("/api/plugins")).json();
  }
  /** Registers an arbitrary local path as a Modus plugin root. */
  async registerPlugin(path: string, opts?: { id?: string; name?: string; enabled?: boolean }): Promise<ModusPlugin> {
    return (await this.fetchOrThrow("/api/plugins", {
      method: "POST",
      body: JSON.stringify({ path, ...(opts ?? {}) }),
    })).json();
  }
  /** Enables/disables or edits a registered Modus plugin. */
  async patchPlugin(id: string, patch: { enabled?: boolean; path?: string; name?: string }): Promise<ModusPlugin> {
    return (await this.fetchOrThrow(`/api/plugins/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).json();
  }
  /** Unregisters a Modus plugin root without deleting files on disk. */
  async unregisterPlugin(id: string): Promise<void> {
    await this.fetchOrThrow(`/api/plugins/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  /** Resolves manifest defaults and user/project/global scoped values for a plugin. */
  async getPluginSettings(id: string, opts?: { cwd?: string; userProfile?: string | null }): Promise<PluginSettingsSnapshot> {
    const p = new URLSearchParams();
    if (opts?.cwd) p.set("cwd", opts.cwd);
    if (opts?.userProfile) p.set("userProfile", opts.userProfile);
    const q = p.toString();
    return (await this.fetchOrThrow(`/api/plugins/${encodeURIComponent(id)}/settings${q ? `?${q}` : ""}`)).json();
  }
  /** Writes each value to the scope declared for that manifest field. */
  async patchPluginSettings(
    id: string,
    values: Record<string, unknown>,
    opts?: { cwd?: string; userProfile?: string | null },
  ): Promise<PluginSettingsSnapshot> {
    const p = new URLSearchParams();
    if (opts?.cwd) p.set("cwd", opts.cwd);
    if (opts?.userProfile) p.set("userProfile", opts.userProfile);
    const q = p.toString();
    return (await this.fetchOrThrow(`/api/plugins/${encodeURIComponent(id)}/settings${q ? `?${q}` : ""}`, {
      method: "PATCH",
      body: JSON.stringify({ values }),
    })).json();
  }

  // ── Vaults ──
  /** Lists the implicit default Vault and every named Vault registered on this machine. */
  async listVaults(): Promise<VaultListResponse> {
    return (await this.fetchOrThrow("/api/vaults")).json();
  }
  /** Initializes an empty folder or registers an existing marked folder as a named Vault. */
  async createVault(
    slug: string,
    root: string,
    mode: "initialize" | "register",
    name?: string,
  ): Promise<NamedVault> {
    return (await this.fetchOrThrow("/api/vaults", {
      method: "POST",
      body: JSON.stringify({ slug, root, mode, ...(name !== undefined ? { name } : {}) }),
    })).json();
  }
  /** Repairs a legacy slug-only row by attaching a compliant outside-Main folder. */
  async repairVault(
    slug: string,
    root: string,
    mode: "initialize" | "register",
    name?: string,
  ): Promise<NamedVault> {
    return (await this.fetchOrThrow(`/api/vaults/${encodeURIComponent(slug)}/repair`, {
      method: "POST",
      body: JSON.stringify({ root, mode, ...(name !== undefined ? { name } : {}) }),
    })).json();
  }
  /** Updates presentation or autostart metadata for a named Vault. */
  async updateVault(slug: string, patch: { name?: string; autostart?: boolean }): Promise<NamedVault> {
    return (await this.fetchOrThrow(`/api/vaults/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).json();
  }
  /** Reads policy for a named Vault, or the implicit default when slug is null. */
  async getVaultPolicy(slug: string | null): Promise<VaultPolicy> {
    const target = encodeURIComponent(slug ?? "default");
    return (await this.fetchOrThrow(`/api/vaults/${target}/policy`)).json();
  }
  /** Replaces the complete policy for a named or implicit default Vault. */
  async setVaultPolicy(slug: string | null, policy: VaultPolicy): Promise<VaultPolicy> {
    const target = encodeURIComponent(slug ?? "default");
    return (await this.fetchOrThrow(`/api/vaults/${target}/policy`, {
      method: "PUT",
      body: JSON.stringify(policy),
    })).json();
  }

  // ── Client Extensions ──
  /** Lists client-side extensions with their enabled status. */
  async listClientExtensions(cwd?: string, userProfile?: string | null): Promise<ClientExtensionManifestItem[]> {
    // No query token: `this.fetch` already sends the credential as an
    // Authorization header, and this route never accepted a query credential —
    // so adding one only leaked it into logs and history.
    const p = new URLSearchParams(); if (cwd) p.set("cwd", cwd); if (userProfile) p.set("userProfile", userProfile);
    const q = p.toString(); return (await this.fetch(`/api/client-extensions${q ? `?${q}` : ""}`)).json();
  }
  /** Enables/disables or configures a client extension. */
  async patchClientExtension(id: string, userProfile: string, patch: { enabled?: boolean; settings?: Record<string, unknown> }): Promise<void> {
    await this.fetch(`/api/client-extensions/${encodeURIComponent(id)}?${new URLSearchParams({ userProfile })}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  // ── Project UI ──
  /** Returns active theme/font state for a project. */
  async getProjectUiState(cwd: string): Promise<ProjectUiState> { const r = await this.fetch(`/api/ui/state?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || "Failed to fetch project UI state"); } return r.json(); }
  /** Lists available themes for a project. */
  async getProjectThemes(cwd: string): Promise<ProjectUiAssetInfo[]> { const r = await this.fetch(`/api/ui/themes?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || "Failed to fetch project themes"); } return r.json(); }
  /** Lists available fonts for a project. */
  async getProjectFonts(cwd: string): Promise<ProjectUiAssetInfo[]> { const r = await this.fetch(`/api/ui/fonts?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || "Failed to fetch project fonts"); } return r.json(); }
  /** Activates a theme for a project. */
  async activateProjectTheme(cwd: string, themeId: string): Promise<ActiveProjectUiAsset> { const r = await this.fetch("/api/ui/themes/activate", { method: "POST", body: JSON.stringify({ cwd, themeId }) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to activate theme: ${themeId}`); } return r.json(); }
  /** Activates a font for a project. */
  async activateProjectFont(cwd: string, fontId: string): Promise<ActiveProjectUiAsset> { const r = await this.fetch("/api/ui/fonts/activate", { method: "POST", body: JSON.stringify({ cwd, fontId }) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to activate font: ${fontId}`); } return r.json(); }

  // ── Projects / Init ──
  /** Checks whether a directory is initialized as a MO project. */
  async getInitStatus(cwd: string): Promise<InitStatus> { return (await this.fetch(`/api/init/status?cwd=${encodeURIComponent(cwd)}`)).json(); }
  /** Initializes a directory as a MO project (creates .modus/ scaffold). */
  async initProject(cwd: string, name?: string): Promise<InitResult> { return (await this.fetch("/api/init", { method: "POST", body: JSON.stringify({ cwd, name }) })).json(); }
  /** Lists all registered projects. */
  async listProjects(): Promise<ProjectInfo[]> { return (await this.fetch("/api/projects")).json(); }

  // ── Trace ──
  /** Queries the file-touch trace log (what files agents touched, when, with what confidence).
   *
   *  **`limit` bounds the response, not the work.** The scan is a leading-wildcard
   *  `LIKE` over the events table with a JSON parse per match, so an unfiltered
   *  call costs the whole event history. Pass `sessionId`, `from`/`to`,
   *  `userProfile`, or `cwd` to narrow it. See the Trace queries note in
   *  `docs/primitives.md`. */
  async fetchTouches(query: TouchQuery = {}): Promise<TouchesResponse> {
    const p = new URLSearchParams();
    if (query.limit != null) p.set("limit", String(query.limit)); if (query.userProfile) p.set("userProfile", query.userProfile);
    if (query.cwd) p.set("cwd", query.cwd); if (query.from != null) p.set("from", String(query.from));
    if (query.to != null) p.set("to", String(query.to)); if (query.ops?.length) p.set("ops", query.ops.join(","));
    if (query.confidence?.length) p.set("confidence", query.confidence.join(",")); if (query.sessionId) p.set("sessionId", query.sessionId);
    const r = await this.fetch(`/api/trace/touches?${p}`); if (!r.ok) throw new Error(`trace fetch failed: ${r.status}`); return r.json();
  }
  /** Sessions that wrote or edited one file, most recently touched first. Write/edit only — not reads.
   *
   *  Matches on basename with a leading-wildcard `LIKE`, which no index covers,
   *  so each call scans `file_observations` in full and costs more for a common
   *  filename than a rare one. `limit` is applied after dedup in JS and is
   *  capped at 25 server-side. Debounce it rather than calling it per keystroke
   *  or per tab render. */
  async fetchFileSessions(path: string, limit = 3): Promise<FileSessionRef[]> {
    const p = new URLSearchParams({ path, limit: String(limit) });
    const r = await this.fetch(`/api/trace/file-sessions?${p}`);
    if (!r.ok) throw new Error(`file sessions fetch failed: ${r.status}`);
    return ((await r.json()) as FileSessionsResponse).sessions;
  }

  // ── Process Registry ──
  /** Returns a snapshot of every managed process in the harness (sessions, mission workers, terminals). */
  async listProcesses(): Promise<ProcessSnapshot> { const r = await this.fetch("/api/processes"); if (!r.ok) throw new Error(`Failed to list processes: ${r.status}`); return r.json(); }

  /** Read the backend's current memory and session admission limits. */
  async getMemoryStatus(): Promise<MemoryStatus> {
    const r = await this.fetchOrThrow("/api/system/memory");
    return r.json();
  }

  /** Apply a concurrency limit until backend restart, without interrupting sessions. */
  async setMaxConcurrentSessions(maxConcurrentSessions: number): Promise<MemoryStatus> {
    const r = await this.fetchOrThrow("/api/system/memory", {
      method: "PUT", body: JSON.stringify({ maxConcurrentSessions }),
    });
    return r.json();
  }
  /** Kill a managed process by session ID. Aborts the provider and tears down SDK subprocess + MCP transports. */
  async killProcess(id: string): Promise<void> { const r = await this.fetch(`/api/processes/${id}`, { method: "DELETE" }); if (!r.ok) { const body = await r.json().catch(() => ({})); throw new Error((body as any).error ?? `Failed to kill process: ${r.status}`); } }

  // ── Terminals ──
  /** Creates a new terminal session. */
  async createTerminal(opts: CreateTerminalOpts = {}): Promise<TerminalInfo> { const r = await this.fetch("/api/terminals", { method: "POST", body: JSON.stringify(opts) }); if (!r.ok) throw new Error(`Failed to create terminal: ${r.status}`); return r.json(); }
  /** Lists terminals, optionally filtered by session, ownerType, or ownerName. */
  async listTerminals(sessionIdOrFilter?: string | { sessionId?: string; ownerType?: string; ownerName?: string }): Promise<TerminalInfo[]> {
    const params = new URLSearchParams();
    if (typeof sessionIdOrFilter === "string") {
      params.set("sessionId", sessionIdOrFilter);
    } else if (sessionIdOrFilter) {
      if (sessionIdOrFilter.sessionId) params.set("sessionId", sessionIdOrFilter.sessionId);
      if (sessionIdOrFilter.ownerType) params.set("ownerType", sessionIdOrFilter.ownerType);
      if (sessionIdOrFilter.ownerName) params.set("ownerName", sessionIdOrFilter.ownerName);
    }
    const q = params.toString() ? `?${params}` : "";
    const r = await this.fetch(`/api/terminals${q}`);
    if (!r.ok) throw new Error(`Failed to list terminals: ${r.status}`);
    return r.json();
  }
  /** Returns terminal info. */
  async getTerminal(id: string): Promise<TerminalInfo> { const r = await this.fetch(`/api/terminals/${id}`); if (!r.ok) throw new Error(`Failed to get terminal: ${r.status}`); return r.json(); }
  /** Destroys a terminal. */
  async deleteTerminal(id: string): Promise<void> { const r = await this.fetch(`/api/terminals/${id}`, { method: "DELETE" }); if (!r.ok) throw new Error(`Failed to delete terminal: ${r.status}`); }
  /** Resizes a terminal. */
  async resizeTerminal(id: string, cols: number, rows: number): Promise<void> { const r = await this.fetch(`/api/terminals/${id}/resize`, { method: "POST", body: JSON.stringify({ cols, rows }) }); if (!r.ok) throw new Error(`Failed to resize terminal: ${r.status}`); }
  /** Reassigns all terminals from one session ID to another. */
  async rekeyTerminalSession(oldSessionId: string, newSessionId: string): Promise<number> {
    const r = await this.fetch("/api/terminals/rekey-session", { method: "POST", body: JSON.stringify({ oldSessionId, newSessionId }) });
    if (!r.ok) throw new Error(`Failed to rekey terminal session: ${r.status}`);
    const body = await r.json();
    return typeof body.count === "number" ? body.count : 0;
  }
  /** Opens a WebSocket to a terminal in binary arraybuffer mode. */
  connectTerminalWS(terminalId: string): WebSocket {
    const target = this.url
      ? new URL(this.url)
      : new URL(typeof location !== "undefined" ? location.origin : "http://localhost");
    const protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const host = target.host;
    const token = this.token ?? "";
    const protocols = ["modus-v1"];
    if (token) protocols.push(`modus-auth.${base64UrlEncode(token)}`);
    const ws = new WebSocket(`${protocol}//${host}/ws/terminal/${terminalId}`, protocols);
    ws.binaryType = "arraybuffer"; return ws;
  }

  // ── Web Positions ──
  /** Returns saved node positions for the session web view. Returns empty array on error. */
  async getWebPositions(scope: string): Promise<WebPosition[]> { const r = await this.fetch(`/api/web/positions?scope=${encodeURIComponent(scope)}`); if (!r.ok) return []; return r.json(); }
  /** Saves/updates node positions for the session web view. */
  async patchWebPositions(scope: string, positions: { nodeId: string; x: number; y: number; pinned?: boolean }[]): Promise<void> { await this.fetch("/api/web/positions", { method: "PATCH", body: JSON.stringify({ scope, positions }) }); }

  // ── Filesystem Events ──
  /** Creates an EventSource for filesystem change notifications under the given root. */
  connectFsEvents(root: string): EventSource {
    const p = new URLSearchParams(); p.set("root", root);
    const token = this.browserSessionToken;
    if (token) p.set("token", token);
    return new EventSource(`${this.url}/api/events/fs?${p}`);
  }

  // ── Convenience ──
  /** Sends a prompt with streaming, collects all events, and returns them with the session ID. */
  async run(opts: InteractOptions): Promise<{ sessionId: string; events: TypedSSEEvent[] }> {
    const handle = await this.interact({ ...opts, subscribe: true }); const collected: TypedSSEEvent[] = []; let sessionId = opts.sessionId ?? "";
    for await (const evt of handle.events) {
      collected.push(evt);
      if (!sessionId && evt.event === "system" && evt.data.session_id) sessionId = evt.data.session_id;
    }
    return { sessionId, events: collected };
  }
  /** Like `run()` but extracts just the text response (concatenates stream deltas or uses the result field). */
  async prompt(opts: InteractOptions): Promise<{ sessionId: string; text: string }> {
    const { sessionId, events } = await this.run(opts); let text = "";
    for (const evt of events) {
      if (evt.event === "stream_event") {
        const inner = evt.data.event as Record<string, any>;
        if (inner?.type === "content_block_delta") {
          const delta = inner.delta;
          if (typeof (evt.data as Record<string, any>).fullText === "string") {
            text = (evt.data as Record<string, any>).fullText;
          } else if (delta?.type === "text_delta" && delta.text) {
            text += delta.text;
          }
        }
      }
      else if (evt.event === "result" && evt.data.result) { text = evt.data.result as string; }
    }
    return { sessionId, text };
  }

  // ── Internal ──
  /** Internal fetch wrapper that auto-adds auth headers and ensures authentication before each request. */
  async fetch(path: string, init?: RequestInit): Promise<Response> {
    await this.ensureAuth();
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(init?.headers as Record<string, string> ?? {}) };
    const t = this.token; if (t) headers["Authorization"] = `Bearer ${t}`;
    return globalThis.fetch(`${this.url}${path}`, { ...init, headers });
  }

  /** Like fetch() but throws ModusError on non-OK responses. Use for endpoints where errors should propagate. */
  private async fetchOrThrow(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.fetch(path, init);
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new ModusError(res.status, detail || res.statusText, path);
    }
    return res;
  }
}

/** Read a filesystem-mutation response. A body that is not JSON at all (a proxy
 *  error page, a truncated response) still yields a usable failure rather than
 *  throwing out of the SDK method. */
async function toFileMutationResult(response: Response): Promise<FileMutationResult> {
  const body = await response.json().catch(() => null);
  return readFileMutationResponse(response.status, body);
}

// ── SSE Parser ──
/** Parses SSE-formatted data from a ReadableStream into typed events. Terminates on "done" events and skips "ping" events. */
function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk?: () => void,
): AsyncGenerator<TypedSSEEvent> {
  const decoder = new TextDecoder(); let buffer = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    onChunk?.();
    buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
    let currentEvent = "", currentId = "0";
    for (const line of lines) {
      if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
      else if (line.startsWith("id: ")) currentId = line.slice(4).trim();
      else if (line.startsWith("data: ")) {
        if (currentEvent === "done") return; if (currentEvent === "ping") continue;
        try { yield { event: currentEvent, data: JSON.parse(line.slice(6)), seq: Number(currentId) || 0 } as TypedSSEEvent; } catch {}
      }
    }
  }
}
