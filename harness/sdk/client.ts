import type {
  ModusClientOptions,
  InteractOptions,
  InteractResult,
  SessionInfo,
  ActiveSessionInfo,
  SearchHit,
  SessionStatusInfo,
  CreateSessionOpts,
  SendMessageOpts,
  TurnContent,
  SSEEvent,
  EventStreamHandle,
  EventStreamCallbacks,
  Profile,
  ProfileUi,
  GlobalConfig,
  MoveListItem,
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
  GitStatus,
  GitCommit,
  GitCommitDetail,
  FileDiff,
  BrowseResult,
  PromptListItem,
  RenderResult,
  SessionStats,
  AccountInfo,
  GeminiUsageInfo,
  ProviderUsageAnalytics,
  DeepAnalytics,
  MemoryItem,
  ClientExtensionManifestItem,
  ProjectUiState,
  ProjectUiAssetInfo,
  ActiveProjectUiAsset,
  InitStatus,
  InitResult,
  ProjectInfo,
  TouchesResponse,
  TouchQuery,
  TerminalInfo,
  CreateTerminalOpts,
  WebPosition,
  MissionRunStatus,
  ApiAttachment,
  ActivityEntry,
  ActivitySummaryResult,
  NoteListItem,
  NoteDetail,
} from "./types";

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

export class ModusClient {
  private url: string;
  private _token: string | undefined;
  private pin: string | undefined;
  private getTokenFn: (() => string | undefined) | undefined;
  private authPromise: Promise<void> | null = null;

  constructor(opts: ModusClientOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this._token = opts.token;
    this.pin = opts.pin;
    this.getTokenFn = opts.getToken;
  }

  get token(): string | undefined {
    return this.getTokenFn?.() ?? this._token;
  }

  setToken(token: string) { this._token = token; }
  clearToken() { this._token = undefined; }
  get baseUrl(): string { return this.url; }

  authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const t = this.token;
    if (t) h["Authorization"] = `Bearer ${t}`;
    return h;
  }

  tokenParam(): string {
    const t = this.token;
    return t ? `token=${t}` : "";
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
    })();
    return this.authPromise;
  }

  // ── Interact ──
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
  async authStatus(): Promise<{ required: boolean; setup: boolean; name: string | null }> {
    const res = await globalThis.fetch(`${this.url}/api/auth/status`);
    return res.json();
  }
  async setupNewPin(pin: string, name?: string): Promise<string> {
    const res = await globalThis.fetch(`${this.url}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin, name }) });
    if (!res.ok) throw new Error("Setup failed");
    return (await res.json()).token;
  }
  async verifyPin(pin: string, name?: string): Promise<string> {
    const res = await globalThis.fetch(`${this.url}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin, name }) });
    if (!res.ok) throw new Error("Wrong PIN");
    return (await res.json()).token;
  }
  async fetchMe(): Promise<{ name: string | null }> { return (await this.fetch("/api/auth/me")).json(); }
  async lockAll(): Promise<void> { await this.fetch("/api/auth/lock", { method: "POST" }); }
  async checkToken(): Promise<void> { const r = await this.fetch("/api/sessions?limit=1"); if (!r.ok) throw new Error("unauthorized"); }
  async changePin(oldPin: string, newPin: string): Promise<void> {
    const res = await this.fetch("/api/auth/change-pin", { method: "POST", body: JSON.stringify({ oldPin, newPin }) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as any).error || "Failed to change PIN"); }
  }
  async healthCheck(): Promise<{ status: string; uptime: number }> { return (await globalThis.fetch(`${this.url}/health`)).json(); }

  // ── Sessions ──
  async listSessions(opts?: { limit?: number; userProfile?: string; action?: string; profile?: string }): Promise<SessionInfo[]> {
    const p = new URLSearchParams();
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.userProfile) p.set("userProfile", opts.userProfile);
    if (opts?.action) p.set("action", opts.action);
    if (opts?.profile) p.set("profile", opts.profile);
    const q = p.toString();
    return (await this.fetch(`/api/sessions${q ? `?${q}` : ""}`)).json();
  }
  async getActiveSessions(userProfile?: string): Promise<ActiveSessionInfo[]> {
    const q = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : "";
    return (await this.fetch(`/api/sessions/active${q}`)).json();
  }
  async getSessionStatus(id: string): Promise<SessionStatusInfo> { return (await this.fetch(`/api/sessions/${id}/status`)).json(); }
  async createSession(opts: CreateSessionOpts): Promise<{ sessionId: string; status: string }> {
    return (await this.fetch("/api/sessions", { method: "POST", body: JSON.stringify(opts) })).json();
  }
  async createEmptySession(opts?: { profile?: string; model?: string; provider?: string; cwd?: string; userProfile?: string }): Promise<string> {
    const data = await (await this.fetch("/api/sessions/empty", { method: "POST", body: JSON.stringify(opts ?? {}) })).json();
    return data.sessionId;
  }
  async sendMessage(sessionId: string, opts: SendMessageOpts | string, attachments?: ApiAttachment[], config?: Record<string, unknown>): Promise<{ queued: boolean; status: string }> {
    const body = typeof opts === "string" ? { prompt: opts, attachments, ...config } : opts;
    return (await this.fetch(`/api/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify(body) })).json();
  }
  async stopSession(id: string): Promise<void> { await this.fetch(`/api/sessions/${id}/stop`, { method: "POST" }); }
  async stopTask(id: string, taskId: string): Promise<{ ok: boolean }> {
    return (await this.fetch(`/api/sessions/${id}/stop-task`, { method: "POST", body: JSON.stringify({ taskId }) })).json();
  }
  async steerSession(id: string, prompt: string, attachments?: unknown[]): Promise<{ ok: boolean }> {
    return (await this.fetchOrThrow(`/api/sessions/${id}/steer`, { method: "POST", body: JSON.stringify({ prompt, attachments }) })).json();
  }
  async getMessages(id: string, seq?: number): Promise<TurnContent | TurnContent[]> {
    const q = seq != null ? `?seq=${seq}` : "";
    return (await this.fetch(`/api/sessions/${id}/messages-content${q}`)).json();
  }
  async archiveSession(id: string): Promise<void> { await this.fetch(`/api/sessions/${id}`, { method: "DELETE" }); }
  async unarchiveSession(id: string): Promise<void> { await this.fetch(`/api/sessions/${id}/unarchive`, { method: "POST" }); }
  async listArchivedSessions(limit?: number): Promise<SessionInfo[]> {
    const q = limit ? `?limit=${limit}` : "";
    return (await this.fetch(`/api/sessions/archived${q}`)).json();
  }
  async updateTitle(id: string, title: string | null): Promise<void> {
    await this.fetch(`/api/sessions/${id}/title`, { method: "PATCH", body: JSON.stringify({ title }) });
  }
  async searchSessions(query: string, opts?: { limit?: number; userProfile?: string }): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    const p = new URLSearchParams({ q: query });
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.userProfile) p.set("userProfile", opts.userProfile);
    return (await this.fetch(`/api/sessions/search?${p}`)).json();
  }

  // ── Tags ──
  async getTags(id: string): Promise<string[]> { const d: SessionTagsResult = await (await this.fetch(`/api/sessions/${id}/tags`)).json(); return d.tags; }
  async addTag(id: string, tag: string): Promise<SessionTagsResult> {
    const res = await this.fetch(`/api/sessions/${id}/tags`, { method: "PATCH", body: JSON.stringify({ add: tag }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new ModusError(res.status, typeof d?.error === "string" ? d.error : "Failed to update session tags", `/api/sessions/${id}/tags`);
    return { tags: Array.isArray(d?.tags) ? d.tags : [] };
  }
  async removeTag(id: string, tag: string): Promise<SessionTagsResult> {
    const res = await this.fetch(`/api/sessions/${id}/tags`, { method: "PATCH", body: JSON.stringify({ remove: tag }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new ModusError(res.status, typeof d?.error === "string" ? d.error : "Failed to update session tags", `/api/sessions/${id}/tags`);
    return { tags: Array.isArray(d?.tags) ? d.tags : [] };
  }
  async getSessionByTag(tag: string): Promise<{ id: string; status: string; profile: string; tags: string[]; createdAt: string; updatedAt: string }> {
    return (await this.fetchOrThrow(`/api/sessions/by-tag/${encodeURIComponent(tag)}`)).json();
  }

  // ── Session Config ──
  async updateConfig(id: string, config: Record<string, unknown>): Promise<{ ok: boolean }> {
    return (await this.fetch(`/api/sessions/${id}/config`, { method: "PATCH", body: JSON.stringify(config) })).json();
  }
  async switchProfile(id: string, profile: string, contextMode?: string): Promise<{ ok: boolean; profile: string }> {
    const res = await this.fetch(`/api/sessions/${id}/profile`, { method: "PATCH", body: JSON.stringify({ profile, contextMode }) });
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return { error: text }; } })() : {};
    if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : `Profile switch failed (${res.status})`);
    return data;
  }
  async respondToPermission(id: string, opts: PermissionResponseOpts | PermissionResponse): Promise<{ ok: boolean }> {
    return (await this.fetch(`/api/sessions/${id}/permission-response`, { method: "POST", body: JSON.stringify(opts) })).json();
  }
  async branchSession(id: string, seq: number): Promise<string> {
    const d = await (await this.fetch(`/api/sessions/${id}/branch`, { method: "POST", body: JSON.stringify({ seq }) })).json();
    if (d.error) throw new Error(d.error);
    return d.sessionId;
  }

  // ── Draft / UI State ──
  async getDraft(id: string): Promise<string> { const d = await (await this.fetch(`/api/ui/sessions/${id}/draft`)).json(); return d.draft ?? ""; }
  async saveDraft(id: string, draft: string): Promise<void> { await this.fetch(`/api/ui/sessions/${id}/draft`, { method: "PUT", body: JSON.stringify({ draft }) }); }
  async getSessionUiState(id: string): Promise<Record<string, unknown>> { return (await this.fetch(`/api/ui/sessions/${id}/state`)).json(); }
  async saveSessionUiState(id: string, patch: Record<string, unknown>): Promise<void> { await this.fetch(`/api/ui/sessions/${id}/state`, { method: "PATCH", body: JSON.stringify(patch) }); }

  // ── Events (SSE) ──
  subscribeEvents(sessionId: string, afterSeq: number, callbacks: EventStreamCallbacks): () => void {
    const abort = new AbortController();
    const tp = this.tokenParam();
    const params = [`after=${afterSeq}`, tp].filter(Boolean).join("&");
    const url = `${this.url}/api/sessions/${sessionId}/events?${params}`;
    let doneFired = false, gotServerDone = false;
    const fireDone = () => { if (doneFired) return; doneFired = true; gotServerDone ? callbacks.onDone() : (callbacks.onDisconnect ?? callbacks.onDone)(); };
    globalThis.fetch(url, { signal: abort.signal }).then(async (res) => {
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
  subscribeGlobalEvents(): EventStreamHandle {
    const controller = new AbortController(); const self = this;
    const events = (async function* () {
      const tokenQ = self.token ? `?token=${self.token}` : "";
      const res = await globalThis.fetch(`${self.url}/api/events/sessions${tokenQ}`, { signal: controller.signal });
      if (!res.ok) throw new ModusError(res.status, res.statusText, "/api/events/sessions");
      const reader = res.body?.getReader(); if (!reader) throw new Error("No response body");
      yield* parseSSEStream(reader);
    })();
    return { events, abort: () => controller.abort() };
  }

  // ── Profiles ──
  async listProfiles(cwd?: string): Promise<Profile[]> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; return (await this.fetch(`/api/profiles${q}`)).json(); }
  async getProfile(name: string, cwd?: string): Promise<Profile> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; return (await this.fetchOrThrow(`/api/profiles/${encodeURIComponent(name)}${q}`)).json(); }
  async getProfileUiConfig(name: string, cwd?: string): Promise<ProfileUi> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; const r = await this.fetch(`/api/profiles/${encodeURIComponent(name)}/ui-config${q}`); if (!r.ok) throw new Error(`Profile UI config not found: ${name}`); return r.json(); }
  async saveProfile(name: string, profile: Record<string, unknown>, cwd?: string): Promise<void> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; const r = await this.fetch(`/api/profiles/${encodeURIComponent(name)}${q}`, { method: "PUT", body: JSON.stringify(profile) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to save profile: ${name}`); } }
  async patchProfileUiConfig(name: string, patch: Partial<ProfileUi>, cwd?: string): Promise<void> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; const r = await this.fetch(`/api/profiles/${encodeURIComponent(name)}/ui-config${q}`, { method: "PATCH", body: JSON.stringify(patch) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to update profile UI config: ${name}`); } }
  async deleteProfile(name: string, cwd?: string): Promise<void> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; await this.fetch(`/api/profiles/${encodeURIComponent(name)}${q}`, { method: "DELETE" }); }
  async getGlobalConfig(cwd?: string): Promise<GlobalConfig> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; return (await this.fetch(`/api/profiles/_global${q}`)).json(); }
  async saveGlobalConfig(config: GlobalConfig, cwd?: string): Promise<void> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; const r = await this.fetch(`/api/profiles/_global${q}`, { method: "PUT", body: JSON.stringify(config) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || "Failed to save global config"); } }
  async checkSecrets(vars: string[]): Promise<{ status: Record<string, boolean>; secretsFile: string }> { return (await this.fetch("/api/secrets/check", { method: "POST", body: JSON.stringify({ vars }) })).json(); }

  // ── Providers ──
  async listProviders(): Promise<string[]> { return (await this.fetch("/api/providers")).json(); }
  async getProviderCapabilities(): Promise<ProviderCapabilities[]> { return (await this.fetch("/api/provider-capabilities")).json(); }
  async getProviderHealth(): Promise<ProviderHealthInfo[]> { return (await this.fetch("/api/provider-health")).json(); }
  async getProviderModels(provider: string): Promise<ProviderModel[]> { const r = await this.fetch(`/api/providers/${encodeURIComponent(provider)}/models`); if (!r.ok) return []; return r.json(); }

  // ── User Profiles ──
  async listUserProfiles(): Promise<UserProfile[]> { return (await this.fetch("/api/user-profiles")).json(); }
  async getUserProfile(name: string): Promise<UserProfile> { const r = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}`); if (!r.ok) throw new Error(`User profile not found: ${name}`); return r.json(); }
  async getUserProfileUiConfig(name: string): Promise<UserProfileUiConfig> { const r = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}/ui-config`); if (!r.ok) throw new Error(`User profile UI config not found: ${name}`); return r.json(); }
  async saveUserProfile(name: string, profile: Record<string, unknown>): Promise<void> { const r = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(profile) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to save user profile: ${name}`); } }
  async patchUserProfile(name: string, patch: Partial<UserProfile>): Promise<void> { const r = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify(patch) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to update user profile: ${name}`); } }
  async patchUserProfileUiConfig(name: string, patch: Partial<UserProfileUiConfig>): Promise<void> { const r = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}/ui-config`, { method: "PATCH", body: JSON.stringify(patch) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to update user profile UI config: ${name}`); } }
  async getUserProfileState(name: string): Promise<UserProfileState> { return (await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}/state`)).json(); }
  async patchUserProfileState(name: string, patch: Partial<UserProfileState>): Promise<void> { await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}/state`, { method: "PATCH", body: JSON.stringify(patch) }); }

  // ── Moves ──
  async listMoves(cwd: string): Promise<MoveListItem[]> { const r = await this.fetch(`/api/moves?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) return []; return r.json(); }
  getWidgetUrl(moveName: string, cwd: string): string { const tp = this.tokenParam(); const q = new URLSearchParams({ cwd }); if (tp) q.set("token", tp.replace(/^token=/, "")); return `${this.url}/api/moves/${encodeURIComponent(moveName)}/widget?${q}`; }
  getWidgetCssUrl(moveName: string, cwd: string): string { const tp = this.tokenParam(); const q = new URLSearchParams({ cwd }); if (tp) q.set("token", tp.replace(/^token=/, "")); return `${this.url}/api/moves/${encodeURIComponent(moveName)}/widget.css?${q}`; }
  async activateMove(sessionId: string, body: { moveName: string; inputs: Record<string, unknown>; cwd: string; userProfile?: string; modeOverride?: "inline" | "branch" | "background"; forceNewSession?: boolean }): Promise<ActivateMoveResult> {
    const r = await this.fetch(`/api/sessions/${sessionId}/moves/activate`, { method: "POST", body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({ error: "move activation failed" })); if (!r.ok) throw new Error(d.error ?? "move activation failed"); return d;
  }
  async activateProjectMove(body: { moveName: string; inputs: Record<string, unknown>; cwd: string; userProfile?: string; modeOverride?: "inline" | "branch" | "background"; forceNewSession?: boolean }): Promise<ActivateMoveResult> {
    const r = await this.fetch("/api/moves/activate", { method: "POST", body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({ error: "move activation failed" })); if (!r.ok) throw new Error(d.error ?? "move activation failed"); return d;
  }
  async callMoveOp(moveName: string, apiToken: string, op: string, data?: Record<string, unknown>): Promise<{ ok: boolean; message?: string; error?: string }> {
    return (await this.fetch(`/api/moves/${moveName}/op`, { method: "POST", body: JSON.stringify({ apiToken, op, ...data }) })).json();
  }
  async getActiveWidgets(sessionId: string): Promise<Array<{ widget: MoveWidgetInfo; apiToken: string; instanceId: string }>> { const r = await this.fetch(`/api/sessions/${sessionId}/moves/widget`); if (!r.ok) return []; return r.json(); }
  async rekeyMoveSession(oldId: string, newId: string): Promise<void> { await this.fetch(`/api/sessions/${oldId}/moves/rekey`, { method: "POST", body: JSON.stringify({ newSessionId: newId }) }); }
  async rekeyMoveByToken(apiToken: string, newId: string): Promise<void> { await this.fetch("/api/moves/rekey-by-token", { method: "POST", body: JSON.stringify({ apiToken, newSessionId: newId }) }); }
  async attachMove(body: { moveName: string; inputs: Record<string, unknown>; cwd: string; sessionId?: string; userProfile?: string }): Promise<AttachMoveResult> {
    const r = await this.fetch(`/api/moves/${body.moveName}/attach`, { method: "POST", body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({ error: "attach failed" })); if (!r.ok) throw new Error(d.error ?? "attach failed"); return d;
  }
  async activateAttached(moveName: string, apiToken: string, text?: string, userProfile?: string): Promise<{ ok: boolean; prompt?: string; moveRunId?: number; error?: string }> {
    return (await this.fetch(`/api/moves/${encodeURIComponent(moveName)}/activate-attached`, { method: "POST", body: JSON.stringify({ apiToken, text, userProfile }) })).json();
  }
  async detachMove(moveName: string, apiToken: string): Promise<void> { await this.fetch(`/api/moves/${moveName}/detach`, { method: "POST", body: JSON.stringify({ apiToken }) }); }
  async listAmbientMoves(sessionId: string): Promise<AmbientMoveInfo[]> { const r = await this.fetch(`/api/sessions/${sessionId}/moves/ambient`); if (!r.ok) return []; return r.json(); }
  async deactivateAmbient(sessionId: string, moveName: string): Promise<{ ok: boolean; moveName: string }> {
    return (await this.fetch(`/api/sessions/${sessionId}/moves/deactivate`, { method: "POST", body: JSON.stringify({ moveName }) })).json();
  }

  // ── Actions ──
  async listActions(userProfile?: string | null): Promise<ActionInfo[]> { const q = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : ""; return (await this.fetch(`/api/actions${q}`)).json(); }
  async getActionInfo(name: string): Promise<{ contextSource: string; configSource: string }> { return (await this.fetch(`/api/actions/${encodeURIComponent(name)}/info`)).json(); }
  async triggerAction(name: string, userProfile?: string | null): Promise<void> { const r = await this.fetch(`/api/actions/${encodeURIComponent(name)}/trigger`, { method: "POST", body: JSON.stringify({ userProfile: userProfile ?? undefined }) }); if (!r.ok) throw new Error("trigger failed"); }
  async patchAction(name: string, patch: Record<string, unknown>): Promise<void> { await this.fetch(`/api/actions/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify(patch) }); }
  async getActionRuns(name: string, limit?: number): Promise<ActionRun[]> { const q = limit ? `?limit=${limit}` : ""; return (await this.fetch(`/api/actions/${encodeURIComponent(name)}/runs${q}`)).json(); }
  async clearRuns(name: string): Promise<void> { await this.fetch(`/api/actions/${encodeURIComponent(name)}/runs`, { method: "DELETE" }); }
  async resetAction(name: string, skipConfirm?: boolean): Promise<void> { await this.fetch(`/api/actions/${encodeURIComponent(name)}/reset`, { method: "POST", body: JSON.stringify({ skipConfirm }) }); }
  async reloadActions(): Promise<{ ok: boolean; count: number }> { return (await this.fetch("/api/actions/reload", { method: "POST" })).json(); }
  async getActionPreferences(name: string): Promise<Record<string, boolean>> { return (await this.fetch(`/api/actions/${encodeURIComponent(name)}/preferences`)).json(); }
  async addActionTag(name: string, tag: string): Promise<void> { await this.fetch(`/api/actions/${encodeURIComponent(name)}/tags`, { method: "POST", body: JSON.stringify({ tag }) }); }
  async removeActionTag(name: string, tag: string): Promise<void> { await this.fetch(`/api/actions/${encodeURIComponent(name)}/tags/${encodeURIComponent(tag)}`, { method: "DELETE" }); }

  // ── Missions ──
  async listMissions(cwd: string): Promise<MissionListItem[]> { const r = await this.fetch(`/api/missions?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) return []; return r.json(); }
  async listMissionRuns(opts?: { cwd?: string; status?: MissionRunStatus; limit?: number }): Promise<MissionRunSummary[]> {
    const p = new URLSearchParams(); if (opts?.cwd) p.set("cwd", opts.cwd); if (opts?.status) p.set("status", opts.status); if (opts?.limit) p.set("limit", String(opts.limit));
    const q = p.toString(); const r = await this.fetch(`/api/missions/runs${q ? `?${q}` : ""}`); if (!r.ok) return []; return r.json();
  }
  async getMissionRun(id: number): Promise<MissionRunSummary | null> { const r = await this.fetch(`/api/missions/runs/${id}`); if (!r.ok) return null; return r.json(); }
  async getMissionSteps(runId: number): Promise<MissionStepRunSummary[]> { const r = await this.fetch(`/api/missions/runs/${runId}/steps`); if (!r.ok) return []; return r.json(); }
  async getMissionTransfers(runId: number): Promise<MissionTransferSummary[]> { const r = await this.fetch(`/api/missions/runs/${runId}/transfers`); if (!r.ok) return []; return r.json(); }
  async getMissionGates(runId: number): Promise<MissionGateResultSummary[]> { const r = await this.fetch(`/api/missions/runs/${runId}/gates`); if (!r.ok) return []; return r.json(); }
  async getMissionSessions(runId: number): Promise<string[]> { const r = await this.fetch(`/api/missions/runs/${runId}/sessions`); if (!r.ok) return []; return r.json(); }
  async startMission(opts: { missionName: string; cwd: string; userProfile?: string }): Promise<{ runId: number }> {
    const r = await this.fetch("/api/missions/start", { method: "POST", body: JSON.stringify(opts) });
    const d = await r.json().catch(() => ({ error: "mission start failed" })); if (!r.ok) throw new Error(d.error ?? "mission start failed"); return d;
  }
  async pauseMission(id: number, reason: string): Promise<void> { const r = await this.fetch(`/api/missions/runs/${id}/pause`, { method: "POST", body: JSON.stringify({ reason }) }); if (!r.ok) { const d = await r.json().catch(() => ({ error: "pause failed" })); throw new Error(d.error ?? "pause failed"); } }
  async resumeMission(id: number): Promise<void> { const r = await this.fetch(`/api/missions/runs/${id}/resume`, { method: "POST" }); if (!r.ok) { const d = await r.json().catch(() => ({ error: "resume failed" })); throw new Error(d.error ?? "resume failed"); } }

  // ── Git ──
  async gitStatus(cwd: string): Promise<GitStatus> { return (await this.fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)).json(); }
  async gitLog(cwd: string, limit?: number): Promise<GitCommit[]> { const p = new URLSearchParams({ cwd }); if (limit) p.set("limit", String(limit)); return (await this.fetch(`/api/git/log?${p}`)).json(); }
  async gitShow(hash: string, cwd: string): Promise<GitCommitDetail> { return (await this.fetchOrThrow(`/api/git/show/${encodeURIComponent(hash)}?cwd=${encodeURIComponent(cwd)}`)).json(); }
  async gitFileDiff(file: string, cwd: string): Promise<FileDiff[]> { return (await this.fetchOrThrow(`/api/git/file-diff?${new URLSearchParams({ cwd, file })}`)).json(); }
  async gitFileContent(path: string, cwd: string, hash: string): Promise<string | null> { const r = await this.fetch(`/api/git/file-content?${new URLSearchParams({ cwd, hash, path })}`); if (!r.ok) return null; const d = await r.json(); return d.content ?? null; }
  async gitReadme(cwd: string): Promise<{ name: string; content: string } | null> { return (await this.fetch(`/api/git/readme?cwd=${encodeURIComponent(cwd)}`)).json(); }
  async openInEditor(filePath: string, line?: number, editor?: string): Promise<void> { await this.fetch("/api/open-in-editor", { method: "POST", body: JSON.stringify({ filePath, line, editor }) }); }

  // ── Files ──
  async readFile(path: string): Promise<string | null> { const r = await this.fetch(`/api/file-read?path=${encodeURIComponent(path)}`); if (!r.ok) return null; const d = await r.json(); return d.content ?? null; }
  async writeFile(path: string, content: string): Promise<boolean> { return (await this.fetch("/api/file-write", { method: "PUT", body: JSON.stringify({ path, content }) })).ok; }
  async createFile(path: string, content?: string): Promise<boolean> { return (await this.fetch("/api/file-create", { method: "POST", body: JSON.stringify({ path, content }) })).ok; }
  async createDirectory(path: string): Promise<boolean> { return (await this.fetch("/api/dir-create", { method: "POST", body: JSON.stringify({ path }) })).ok; }
  async browse(path?: string, opts?: { includeHidden?: boolean; includeFiles?: boolean }): Promise<BrowseResult> {
    const p = new URLSearchParams(); if (path) p.set("path", path); if (opts?.includeHidden) p.set("includeHidden", "1"); if (opts?.includeFiles) p.set("includeFiles", "1");
    const q = p.toString(); const r = await this.fetch(`/api/browse${q ? `?${q}` : ""}`); if (!r.ok) throw new Error("browse failed"); return r.json();
  }

  // ── Memory ──
  async queryMemories(opts?: { userProfile?: string; cwd?: string }): Promise<MemoryItem[]> {
    const p = new URLSearchParams(); if (opts?.userProfile) p.set("userProfile", opts.userProfile); if (opts?.cwd) p.set("cwd", opts.cwd);
    const q = p.toString(); return (await this.fetch(`/api/memories${q ? `?${q}` : ""}`)).json();
  }

  // ── Prompts ──
  async listPrompts(opts?: { tags?: string[]; projectCwd?: string }): Promise<PromptListItem[]> {
    const p = new URLSearchParams(); if (opts?.tags?.length) p.set("tags", opts.tags.join(",")); if (opts?.projectCwd) p.set("projectCwd", opts.projectCwd);
    const q = p.toString(); return (await this.fetch(`/api/prompts${q ? `?${q}` : ""}`)).json();
  }
  async renderPrompt(name: string, vars?: Record<string, unknown>): Promise<RenderResult> {
    const r = await this.fetch(`/api/prompts/${encodeURIComponent(name)}/render`, { method: "POST", body: JSON.stringify(vars ?? {}) });
    if (!r.ok) { const e = await r.json().catch(() => ({ error: "render failed" })); throw new Error(e.error ?? "render failed"); } return r.json();
  }
  async reloadPrompts(): Promise<{ ok: boolean; count: number }> { return (await this.fetch("/api/prompts/reload", { method: "POST" })).json(); }

  // ── Stats / Analytics ──
  async getSessionStats(userProfile?: string): Promise<SessionStats> { const q = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : ""; return (await this.fetch(`/api/stats/sessions${q}`)).json(); }
  async getAccountInfo(userProfile?: string): Promise<AccountInfo> { const q = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : ""; return (await this.fetch(`/api/account${q}`)).json(); }
  async getGeminiUsage(cwd?: string): Promise<GeminiUsageInfo> { const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""; return (await this.fetch(`/api/gemini/usage${q}`)).json(); }
  async getProviderUsageAnalytics(userProfile?: string, days = 30): Promise<ProviderUsageAnalytics> {
    const p = new URLSearchParams(); if (userProfile) p.set("userProfile", userProfile); p.set("days", String(days));
    return (await this.fetch(`/api/analytics/provider-usage?${p}`)).json();
  }
  async getDeepAnalytics(opts: { start: number; end: number; bucketMs?: number; userProfile?: string; cwd?: string; provider?: string }): Promise<DeepAnalytics> {
    const p = new URLSearchParams(); p.set("start", String(opts.start)); p.set("end", String(opts.end));
    if (opts.bucketMs != null) p.set("bucketMs", String(opts.bucketMs)); if (opts.userProfile) p.set("userProfile", opts.userProfile); if (opts.cwd) p.set("cwd", opts.cwd); if (opts.provider) p.set("provider", opts.provider);
    return (await this.fetch(`/api/analytics/deep?${p}`)).json();
  }

  // ── Activity ──
  async getActivity(opts?: { userProfile?: string; since?: number; limit?: number; eventType?: string }): Promise<ActivityEntry[]> {
    const p = new URLSearchParams(); if (opts?.userProfile) p.set("userProfile", opts.userProfile); if (opts?.since != null) p.set("since", String(opts.since)); if (opts?.limit != null) p.set("limit", String(opts.limit)); if (opts?.eventType) p.set("eventType", opts.eventType);
    const q = p.toString(); return (await this.fetchOrThrow(`/api/activity${q ? `?${q}` : ""}`)).json();
  }
  async getActivitySummary(opts?: { userProfile?: string; hours?: number }): Promise<ActivitySummaryResult> {
    const p = new URLSearchParams(); if (opts?.userProfile) p.set("userProfile", opts.userProfile); if (opts?.hours != null) p.set("hours", String(opts.hours));
    const q = p.toString(); return (await this.fetchOrThrow(`/api/activity/summary${q ? `?${q}` : ""}`)).json();
  }

  // ── Notes ──
  async listNotes(cwd: string): Promise<NoteListItem[]> { return (await this.fetchOrThrow(`/api/notes?cwd=${encodeURIComponent(cwd)}`)).json(); }
  async getNote(id: string, cwd: string): Promise<NoteDetail> { return (await this.fetchOrThrow(`/api/notes/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}`)).json(); }
  async createNote(cwd: string, note: { title?: string; content: string; tags?: string[] }): Promise<NoteDetail> { return (await this.fetchOrThrow("/api/notes", { method: "POST", body: JSON.stringify({ cwd, ...note }) })).json(); }
  async updateNote(id: string, cwd: string, note: { title?: string; content?: string; tags?: string[] }): Promise<NoteDetail> { return (await this.fetchOrThrow(`/api/notes/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ cwd, ...note }) })).json(); }
  async deleteNote(id: string, cwd: string): Promise<void> { await this.fetchOrThrow(`/api/notes/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" }); }

  // ── Client Extensions ──
  async listClientExtensions(cwd?: string, userProfile?: string | null): Promise<ClientExtensionManifestItem[]> {
    const p = new URLSearchParams(); if (cwd) p.set("cwd", cwd); if (userProfile) p.set("userProfile", userProfile);
    const tp = this.tokenParam(); if (tp) p.set("token", tp.replace(/^token=/, ""));
    const q = p.toString(); return (await this.fetch(`/api/client-extensions${q ? `?${q}` : ""}`)).json();
  }
  async patchClientExtension(id: string, userProfile: string, patch: { enabled?: boolean; settings?: Record<string, unknown> }): Promise<void> {
    await this.fetch(`/api/client-extensions/${encodeURIComponent(id)}?${new URLSearchParams({ userProfile })}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  // ── Project UI ──
  async getProjectUiState(cwd: string): Promise<ProjectUiState> { const r = await this.fetch(`/api/ui/state?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || "Failed to fetch project UI state"); } return r.json(); }
  async getProjectThemes(cwd: string): Promise<ProjectUiAssetInfo[]> { const r = await this.fetch(`/api/ui/themes?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || "Failed to fetch project themes"); } return r.json(); }
  async getProjectFonts(cwd: string): Promise<ProjectUiAssetInfo[]> { const r = await this.fetch(`/api/ui/fonts?cwd=${encodeURIComponent(cwd)}`); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || "Failed to fetch project fonts"); } return r.json(); }
  async activateProjectTheme(cwd: string, themeId: string): Promise<ActiveProjectUiAsset> { const r = await this.fetch("/api/ui/themes/activate", { method: "POST", body: JSON.stringify({ cwd, themeId }) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to activate theme: ${themeId}`); } return r.json(); }
  async activateProjectFont(cwd: string, fontId: string): Promise<ActiveProjectUiAsset> { const r = await this.fetch("/api/ui/fonts/activate", { method: "POST", body: JSON.stringify({ cwd, fontId }) }); if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(b || `Failed to activate font: ${fontId}`); } return r.json(); }

  // ── Projects / Init ──
  async getInitStatus(cwd: string): Promise<InitStatus> { return (await this.fetch(`/api/init/status?cwd=${encodeURIComponent(cwd)}`)).json(); }
  async initProject(cwd: string, name?: string): Promise<InitResult> { return (await this.fetch("/api/init", { method: "POST", body: JSON.stringify({ cwd, name }) })).json(); }
  async listProjects(): Promise<ProjectInfo[]> { return (await this.fetch("/api/projects")).json(); }

  // ── Trace ──
  async fetchTouches(query: TouchQuery = {}): Promise<TouchesResponse> {
    const p = new URLSearchParams();
    if (query.limit != null) p.set("limit", String(query.limit)); if (query.userProfile) p.set("userProfile", query.userProfile);
    if (query.cwd) p.set("cwd", query.cwd); if (query.from != null) p.set("from", String(query.from));
    if (query.to != null) p.set("to", String(query.to)); if (query.ops?.length) p.set("ops", query.ops.join(","));
    if (query.confidence?.length) p.set("confidence", query.confidence.join(",")); if (query.sessionId) p.set("sessionId", query.sessionId);
    const r = await this.fetch(`/api/trace/touches?${p}`); if (!r.ok) throw new Error(`trace fetch failed: ${r.status}`); return r.json();
  }

  // ── Terminals ──
  async createTerminal(opts: CreateTerminalOpts = {}): Promise<TerminalInfo> { const r = await this.fetch("/api/terminals", { method: "POST", body: JSON.stringify(opts) }); if (!r.ok) throw new Error(`Failed to create terminal: ${r.status}`); return r.json(); }
  async listTerminals(sessionId?: string): Promise<TerminalInfo[]> { const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""; const r = await this.fetch(`/api/terminals${q}`); if (!r.ok) throw new Error(`Failed to list terminals: ${r.status}`); return r.json(); }
  async getTerminal(id: string): Promise<TerminalInfo> { const r = await this.fetch(`/api/terminals/${id}`); if (!r.ok) throw new Error(`Failed to get terminal: ${r.status}`); return r.json(); }
  async deleteTerminal(id: string): Promise<void> { const r = await this.fetch(`/api/terminals/${id}`, { method: "DELETE" }); if (!r.ok) throw new Error(`Failed to delete terminal: ${r.status}`); }
  async resizeTerminal(id: string, cols: number, rows: number): Promise<void> { const r = await this.fetch(`/api/terminals/${id}/resize`, { method: "POST", body: JSON.stringify({ cols, rows }) }); if (!r.ok) throw new Error(`Failed to resize terminal: ${r.status}`); }
  connectTerminalWS(terminalId: string): WebSocket {
    const protocol = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
    const host = this.url ? new URL(this.url).host : (typeof location !== "undefined" ? location.host : "localhost");
    const ws = new WebSocket(`${protocol}//${host}/ws/terminal/${terminalId}?token=${encodeURIComponent(this.token ?? "")}`);
    ws.binaryType = "arraybuffer"; return ws;
  }

  // ── Web Positions ──
  async getWebPositions(scope: string): Promise<WebPosition[]> { const r = await this.fetch(`/api/web/positions?scope=${encodeURIComponent(scope)}`); if (!r.ok) return []; return r.json(); }
  async patchWebPositions(scope: string, positions: { nodeId: string; x: number; y: number; pinned?: boolean }[]): Promise<void> { await this.fetch("/api/web/positions", { method: "PATCH", body: JSON.stringify({ scope, positions }) }); }

  // ── Filesystem Events ──
  connectFsEvents(root: string): EventSource {
    const p = new URLSearchParams(); p.set("root", root);
    const tp = this.tokenParam(); if (tp) p.set("token", tp.split("=")[1]);
    return new EventSource(`${this.url}/api/events/fs?${p}`);
  }

  // ── Convenience ──
  async run(opts: InteractOptions): Promise<{ sessionId: string; events: SSEEvent[] }> {
    const handle = await this.interact({ ...opts, subscribe: true }); const collected: SSEEvent[] = []; let sessionId = opts.sessionId ?? "";
    for await (const evt of handle.events) { collected.push(evt); if (!sessionId && evt.data?.sessionId) sessionId = evt.data.sessionId as string; }
    return { sessionId, events: collected };
  }
  async prompt(opts: InteractOptions): Promise<{ sessionId: string; text: string }> {
    const { sessionId, events } = await this.run(opts); let text = "";
    for (const evt of events) { const d = evt.data as any; if (evt.event === "stream_event") { const inner = d?.event; if (inner?.type === "content_block_delta") { const delta = inner.delta; if (delta?.type === "text_delta" && delta.text) text += delta.text; } } else if (evt.event === "result" && d?.result) { text = d.result as string; } }
    return { sessionId, text };
  }

  // ── Internal ──
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

// ── SSE Parser ──
async function* parseSSEStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder(); let buffer = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
    let currentEvent = "", currentId = "0";
    for (const line of lines) {
      if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
      else if (line.startsWith("id: ")) currentId = line.slice(4).trim();
      else if (line.startsWith("data: ")) {
        if (currentEvent === "done") return; if (currentEvent === "ping") continue;
        try { yield { event: currentEvent, data: JSON.parse(line.slice(6)), seq: Number(currentId) || 0 }; } catch {}
      }
    }
  }
}
