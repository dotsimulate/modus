import type {
  ModusClientOptions,
  InteractOptions,
  InteractResult,
  SessionInfo,
  ActiveSessionInfo,
  SessionStatusInfo,
  CreateSessionOpts,
  SendMessageOpts,
  TurnContent,
  SSEEvent,
  EventStreamHandle,
  Profile,
  MoveListItem,
  ActivateMoveResult,
  MoveBinding,
  PermissionResponseOpts,
  SessionTagsResult,
  BranchResult,
  ActionSummary,
  ActionDetail,
  ActionRun,
  ActionExecution,
  ActionInfo,
  MoveDetail,
  AttachMoveResult,
  AmbientMoveInfo,
  MoveRun,
  MissionSummary,
  MissionDetail,
  MissionRunSummary,
  MissionStepSummary,
  MissionTransferSummary,
  MissionGateResultSummary,
  UserProfile,
  ProviderInfo,
  ProviderCapability,
  ProviderHealth,
  GitStatusResult,
  GitLogEntry,
  GitShowResult,
  BrowseResult,
  NoteListItem,
  NoteDetail,
  PromptListItem,
  ActivityEntry,
  ActivitySummaryResult,
} from "./types";

export class ModusError extends Error {
  constructor(public status: number, public detail: string, public path: string) {
    super(`${status} ${detail} (${path})`);
    this.name = "ModusError";
  }
}

export class ModusClient {
  private url: string;
  private token: string | undefined;
  private pin: string | undefined;
  private authPromise: Promise<void> | null = null;

  constructor(opts: ModusClientOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.pin = opts.pin;
  }

  /** Authenticate via PIN if no token is set. Called automatically on first request. */
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
      if (!res.ok || !data.token) {
        throw new Error(`PIN auth failed: ${data.error ?? res.statusText}`);
      }
      this.token = data.token;
    })();
    return this.authPromise;
  }

  // ── Core: Interact ──

  /**
   * Unified interaction endpoint. Creates or resumes a session, sends a message,
   * and optionally returns an async event stream.
   *
   * With subscribe: false (or omitted), returns { sessionId, status }.
   * With subscribe: true, returns an EventStreamHandle with an async iterable.
   */
  async interact(opts: InteractOptions & { subscribe: true }): Promise<EventStreamHandle>;
  async interact(opts: InteractOptions & { subscribe?: false }): Promise<InteractResult>;
  async interact(opts: InteractOptions): Promise<InteractResult | EventStreamHandle> {
    const shouldSubscribe = opts.subscribe ?? false;
    const body = { ...opts, subscribe: shouldSubscribe };

    if (shouldSubscribe) {
      return this.interactStream(body);
    }

    const res = await this.fetch("/api/sessions/interact", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return res.json() as Promise<InteractResult>;
  }

  private async interactStream(body: Record<string, unknown>): Promise<EventStreamHandle> {
    const controller = new AbortController();
    const res = await this.fetch("/api/sessions/interact", {
      method: "POST",
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body for SSE stream");

    const events = parseSSEStream(reader);

    // Extract sessionId from first event
    return { events, abort: () => controller.abort() };
  }

  // ── Sessions ──

  async listSessions(opts?: { limit?: number; userProfile?: string }): Promise<SessionInfo[]> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.userProfile) params.set("userProfile", opts.userProfile);
    const q = params.toString();
    const res = await this.fetch(`/api/sessions${q ? `?${q}` : ""}`);
    return res.json();
  }

  async getActiveSessions(userProfile?: string): Promise<ActiveSessionInfo[]> {
    const q = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : "";
    const res = await this.fetch(`/api/sessions/active${q}`);
    return res.json();
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatusInfo> {
    const res = await this.fetch(`/api/sessions/${sessionId}/status`);
    return res.json();
  }

  async createSession(opts: CreateSessionOpts): Promise<{ sessionId: string; status: string }> {
    const res = await this.fetch("/api/sessions", {
      method: "POST",
      body: JSON.stringify(opts),
    });
    return res.json();
  }

  async sendMessage(sessionId: string, opts: SendMessageOpts): Promise<{ queued: boolean; status: string }> {
    const res = await this.fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
    return res.json();
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}/stop`, { method: "POST" });
  }

  async getMessages(sessionId: string, seq?: number): Promise<TurnContent | TurnContent[]> {
    const q = seq != null ? `?seq=${seq}` : "";
    const res = await this.fetch(`/api/sessions/${sessionId}/messages-content${q}`);
    return res.json();
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  }

  async updateTitle(sessionId: string, title: string | null): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}/title`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
  }

  // ── Events (SSE) ──

  subscribeEvents(sessionId: string, afterSeq = 0): EventStreamHandle {
    const controller = new AbortController();
    const self = this;

    const events = (async function* () {
      await self.ensureAuth();
      const tokenQ = self.token ? `&token=${self.token}` : "";
      const url = `${self.url}/api/sessions/${sessionId}/events?after=${afterSeq}${tokenQ}`;
      const res = await globalThis.fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Event stream failed: ${res.statusText}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      yield* parseSSEStream(reader);
    })();

    return { events, abort: () => controller.abort() };
  }

  // ── Profiles ──

  async listProfiles(cwd?: string): Promise<Profile[]> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const res = await this.fetch(`/api/profiles${q}`);
    return res.json();
  }

  async getProfile(name: string, cwd?: string): Promise<Profile> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const res = await this.fetch(`/api/profiles/${encodeURIComponent(name)}${q}`);
    return res.json();
  }

  // ── Moves ──

  async listMoves(cwd: string): Promise<MoveListItem[]> {
    const res = await this.fetch(`/api/moves?cwd=${encodeURIComponent(cwd)}`);
    return res.json();
  }

  async activateMove(
    sessionId: string,
    moveName: string,
    inputs: Record<string, unknown>,
    cwd: string,
    opts?: { userProfile?: string; modeOverride?: "inline" | "branch" | "background" },
  ): Promise<ActivateMoveResult> {
    const res = await this.fetch(`/api/sessions/${sessionId}/moves/activate`, {
      method: "POST",
      body: JSON.stringify({ moveName, inputs, cwd, ...opts }),
    });
    return res.json();
  }

  async callMoveOp(
    moveName: string,
    apiToken: string,
    op: string,
    data?: Record<string, unknown>,
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    const res = await this.fetch(`/api/moves/${moveName}/op`, {
      method: "POST",
      body: JSON.stringify({ apiToken, op, ...data }),
    });
    return res.json();
  }

  // ── Phase A: Session Management ──

  async branchSession(sessionId: string, seq: number): Promise<BranchResult> {
    const res = await this.fetch(`/api/sessions/${sessionId}/branch`, {
      method: "POST",
      body: JSON.stringify({ seq }),
    });
    return res.json();
  }

  async searchSessions(query: string, opts?: { limit?: number; userProfile?: string }): Promise<SessionInfo[]> {
    const params = new URLSearchParams({ q: query });
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.userProfile) params.set("userProfile", opts.userProfile);
    const res = await this.fetch(`/api/sessions/search?${params}`);
    return res.json();
  }

  async getTags(sessionId: string): Promise<string[]> {
    const res = await this.fetch(`/api/sessions/${sessionId}/tags`);
    const data: SessionTagsResult = await res.json();
    return data.tags;
  }

  async addTag(sessionId: string, tag: string): Promise<SessionTagsResult> {
    const res = await this.fetch(`/api/sessions/${sessionId}/tags`, {
      method: "PATCH",
      body: JSON.stringify({ add: tag }),
    });
    return res.json();
  }

  async removeTag(sessionId: string, tag: string): Promise<SessionTagsResult> {
    const res = await this.fetch(`/api/sessions/${sessionId}/tags`, {
      method: "PATCH",
      body: JSON.stringify({ remove: tag }),
    });
    return res.json();
  }

  async updateConfig(sessionId: string, config: Record<string, unknown>): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/sessions/${sessionId}/config`, {
      method: "PATCH",
      body: JSON.stringify(config),
    });
    return res.json();
  }

  async switchProfile(sessionId: string, profile: string, contextMode?: string): Promise<{ ok: boolean; profile: string }> {
    const res = await this.fetch(`/api/sessions/${sessionId}/profile`, {
      method: "PATCH",
      body: JSON.stringify({ profile, contextMode }),
    });
    return res.json();
  }

  async pauseSession(sessionId: string): Promise<{ ok: boolean; status: string }> {
    const res = await this.fetch(`/api/sessions/${sessionId}/pause`, { method: "POST" });
    return res.json();
  }

  async resumeSession(sessionId: string): Promise<{ ok: boolean; status: string }> {
    const res = await this.fetch(`/api/sessions/${sessionId}/resume`, { method: "POST" });
    return res.json();
  }

  async respondToPermission(sessionId: string, opts: PermissionResponseOpts): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/sessions/${sessionId}/permission-response`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
    return res.json();
  }

  async stopTask(sessionId: string, taskId: string): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/sessions/${sessionId}/stop-task`, {
      method: "POST",
      body: JSON.stringify({ taskId }),
    });
    return res.json();
  }

  async steerSession(sessionId: string, prompt: string, attachments?: unknown[]): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/sessions/${sessionId}/steer`, {
      method: "POST",
      body: JSON.stringify({ prompt, attachments }),
    });
    return res.json();
  }

  async unarchiveSession(sessionId: string): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/sessions/${sessionId}/unarchive`, { method: "POST" });
    return res.json();
  }

  async listArchivedSessions(limit?: number): Promise<SessionInfo[]> {
    const q = limit ? `?limit=${limit}` : "";
    const res = await this.fetch(`/api/sessions/archived${q}`);
    return res.json();
  }

  async getSessionByTag(tag: string): Promise<{ id: string; status: string; profile: string | null; tags: string[]; createdAt: number; updatedAt: number }> {
    const res = await this.fetch(`/api/sessions/by-tag/${encodeURIComponent(tag)}`);
    return res.json();
  }

  subscribeGlobalEvents(): EventStreamHandle {
    const controller = new AbortController();
    const self = this;
    const events = (async function* () {
      await self.ensureAuth();
      const tokenQ = self.token ? `?token=${self.token}` : "";
      const url = `${self.url}/api/events/sessions${tokenQ}`;
      const res = await globalThis.fetch(url, { signal: controller.signal });
      if (!res.ok) throw new ModusError(res.status, res.statusText, "/api/events/sessions");
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      yield* parseSSEStream(reader);
    })();
    return { events, abort: () => controller.abort() };
  }

  // ── Phase B: Actions ──

  async listActions(userProfile?: string): Promise<ActionSummary[]> {
    const q = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : "";
    const res = await this.fetch(`/api/actions${q}`);
    return res.json();
  }

  async getAction(name: string): Promise<ActionDetail> {
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}`);
    return res.json();
  }

  async getActionInfo(name: string): Promise<ActionInfo> {
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}/info`);
    return res.json();
  }

  async triggerAction(name: string, userProfile?: string): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}/trigger`, {
      method: "POST",
      body: JSON.stringify({ userProfile }),
    });
    return res.json();
  }

  async patchAction(name: string, patch: Record<string, unknown>): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return res.json();
  }

  async getActionRuns(name: string, limit?: number): Promise<ActionRun[]> {
    const q = limit ? `?limit=${limit}` : "";
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}/runs${q}`);
    return res.json();
  }

  async getExecutions(name: string, limit?: number): Promise<ActionExecution[]> {
    const q = limit ? `?limit=${limit}` : "";
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}/executions${q}`);
    return res.json();
  }

  async getExecutionRuns(name: string, execId: number): Promise<ActionRun[]> {
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}/executions/${execId}/runs`);
    return res.json();
  }

  async addActionTag(name: string, tag: string): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag }),
    });
    return res.json();
  }

  async removeActionTag(name: string, tag: string): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}/tags/${encodeURIComponent(tag)}`, {
      method: "DELETE",
    });
    return res.json();
  }

  async resetAction(name: string, skipConfirm?: boolean): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}/reset`, {
      method: "POST",
      body: JSON.stringify({ skipConfirm }),
    });
    return res.json();
  }

  async clearRuns(name: string): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}/runs`, {
      method: "DELETE",
    });
    return res.json();
  }

  async reloadActions(): Promise<{ ok: boolean; count: number }> {
    const res = await this.fetch("/api/actions/reload", { method: "POST" });
    return res.json();
  }

  async getActionPreferences(name: string): Promise<Record<string, unknown>> {
    const res = await this.fetch(`/api/actions/${encodeURIComponent(name)}/preferences`);
    return res.json();
  }

  // ── Phase C: Moves (complete lifecycle) ──

  async getMove(name: string, cwd: string): Promise<MoveDetail> {
    const res = await this.fetch(`/api/moves/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`);
    return res.json();
  }

  async attachMove(name: string, opts: { inputs?: Record<string, unknown>; cwd: string; userProfile?: string; sessionId?: string }): Promise<AttachMoveResult> {
    const res = await this.fetch(`/api/moves/${encodeURIComponent(name)}/attach`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
    return res.json();
  }

  async activateAttached(name: string, apiToken: string, text?: string, userProfile?: string): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/moves/${encodeURIComponent(name)}/activate-attached`, {
      method: "POST",
      body: JSON.stringify({ apiToken, text, userProfile }),
    });
    return res.json();
  }

  async detachMove(name: string, apiToken: string): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/moves/${encodeURIComponent(name)}/detach`, {
      method: "POST",
      body: JSON.stringify({ apiToken }),
    });
    return res.json();
  }

  async listAmbientMoves(sessionId: string): Promise<AmbientMoveInfo[]> {
    const res = await this.fetch(`/api/sessions/${sessionId}/moves/ambient`);
    return res.json();
  }

  async deactivateAmbient(sessionId: string, moveName: string): Promise<{ ok: boolean; moveName: string }> {
    const res = await this.fetch(`/api/sessions/${sessionId}/moves/deactivate`, {
      method: "POST",
      body: JSON.stringify({ moveName }),
    });
    return res.json();
  }

  async getActiveWidgets(sessionId: string): Promise<unknown[]> {
    const res = await this.fetch(`/api/sessions/${sessionId}/moves/widget`);
    return res.json();
  }

  async getMoveRuns(name: string, limit?: number): Promise<MoveRun[]> {
    const q = limit ? `?limit=${limit}` : "";
    const res = await this.fetch(`/api/moves/${encodeURIComponent(name)}/runs${q}`);
    return res.json();
  }

  async getMoveRun(id: number): Promise<MoveRun> {
    const res = await this.fetch(`/api/move-runs/${id}`);
    return res.json();
  }

  getWidgetUrl(name: string, cwd: string): string {
    return `${this.url}/api/moves/${encodeURIComponent(name)}/widget?cwd=${encodeURIComponent(cwd)}`;
  }

  getWidgetCssUrl(name: string, cwd: string): string {
    return `${this.url}/api/moves/${encodeURIComponent(name)}/widget.css?cwd=${encodeURIComponent(cwd)}`;
  }

  // ── Phase D: Missions ──

  async listMissions(cwd: string): Promise<MissionSummary[]> {
    const res = await this.fetch(`/api/missions?cwd=${encodeURIComponent(cwd)}`);
    return res.json();
  }

  async getMission(name: string, cwd: string): Promise<MissionDetail> {
    const res = await this.fetch(`/api/missions/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`);
    return res.json();
  }

  async startMission(opts: { missionName: string; cwd?: string; userProfile?: string }): Promise<Record<string, unknown>> {
    const res = await this.fetch("/api/missions/start", {
      method: "POST",
      body: JSON.stringify(opts),
    });
    return res.json();
  }

  async listMissionRuns(opts?: { cwd?: string; status?: string; limit?: number }): Promise<MissionRunSummary[]> {
    const params = new URLSearchParams();
    if (opts?.cwd) params.set("cwd", opts.cwd);
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    const res = await this.fetch(`/api/missions/runs${q ? `?${q}` : ""}`);
    return res.json();
  }

  async getMissionRun(id: number): Promise<MissionRunSummary> {
    const res = await this.fetch(`/api/missions/runs/${id}`);
    return res.json();
  }

  async getMissionSteps(runId: number): Promise<MissionStepSummary[]> {
    const res = await this.fetch(`/api/missions/runs/${runId}/steps`);
    return res.json();
  }

  async getMissionTransfers(runId: number): Promise<MissionTransferSummary[]> {
    const res = await this.fetch(`/api/missions/runs/${runId}/transfers`);
    return res.json();
  }

  async getMissionGates(runId: number): Promise<MissionGateResultSummary[]> {
    const res = await this.fetch(`/api/missions/runs/${runId}/gates`);
    return res.json();
  }

  async getMissionSessions(runId: number): Promise<string[]> {
    const res = await this.fetch(`/api/missions/runs/${runId}/sessions`);
    return res.json();
  }

  async pauseMission(runId: number, reason?: string): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/missions/runs/${runId}/pause`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    return res.json();
  }

  async resumeMission(runId: number): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/missions/runs/${runId}/resume`, { method: "POST" });
    return res.json();
  }

  // ── Phase E: Profiles (full CRUD) ──

  async saveProfile(name: string, profile: Record<string, unknown>, cwd?: string): Promise<{ ok: boolean; name: string }> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const res = await this.fetch(`/api/profiles/${encodeURIComponent(name)}${q}`, {
      method: "PUT",
      body: JSON.stringify(profile),
    });
    return res.json();
  }

  async deleteProfile(name: string, cwd?: string): Promise<{ ok: boolean }> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const res = await this.fetch(`/api/profiles/${encodeURIComponent(name)}${q}`, {
      method: "DELETE",
    });
    return res.json();
  }

  async getGlobalConfig(cwd?: string): Promise<Record<string, unknown>> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const res = await this.fetch(`/api/profiles/_global${q}`);
    return res.json();
  }

  async saveGlobalConfig(config: Record<string, unknown>, cwd?: string): Promise<{ ok: boolean }> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const res = await this.fetch(`/api/profiles/_global${q}`, {
      method: "PUT",
      body: JSON.stringify(config),
    });
    return res.json();
  }

  async listUserProfiles(): Promise<UserProfile[]> {
    const res = await this.fetch("/api/user-profiles");
    return res.json();
  }

  async getUserProfile(name: string): Promise<UserProfile> {
    const res = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}`);
    return res.json();
  }

  async saveUserProfile(name: string, profile: Record<string, unknown>): Promise<{ ok: boolean; name: string }> {
    const res = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(profile),
    });
    return res.json();
  }

  async deleteUserProfile(name: string): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/user-profiles/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    return res.json();
  }

  async getProviderCapabilities(): Promise<ProviderCapability[]> {
    const res = await this.fetch("/api/provider-capabilities");
    return res.json();
  }

  async getProviderHealth(): Promise<ProviderHealth[]> {
    const res = await this.fetch("/api/provider-health");
    return res.json();
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const res = await this.fetch("/api/providers");
    return res.json();
  }

  async getProviderModels(name: string): Promise<string[]> {
    const res = await this.fetch(`/api/providers/${encodeURIComponent(name)}/models`);
    return res.json();
  }

  // ── Phase F: Infrastructure ──

  // Git
  async gitStatus(cwd: string): Promise<GitStatusResult> {
    const res = await this.fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`);
    return res.json();
  }

  async gitLog(cwd: string, limit?: number): Promise<GitLogEntry[]> {
    const params = new URLSearchParams({ cwd });
    if (limit) params.set("limit", String(limit));
    const res = await this.fetch(`/api/git/log?${params}`);
    return res.json();
  }

  async gitShow(hash: string, cwd: string): Promise<GitShowResult> {
    const res = await this.fetch(`/api/git/show/${encodeURIComponent(hash)}?cwd=${encodeURIComponent(cwd)}`);
    return res.json();
  }

  async gitFileDiff(file: string, cwd: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ cwd, file });
    const res = await this.fetch(`/api/git/file-diff?${params}`);
    return res.json();
  }

  async gitFileContent(path: string, cwd: string, hash: string): Promise<{ content: string }> {
    const params = new URLSearchParams({ cwd, path, hash });
    const res = await this.fetch(`/api/git/file-content?${params}`);
    return res.json();
  }

  // Files
  async readFile(path: string): Promise<{ path: string; content: string }> {
    const res = await this.fetch(`/api/file-read?path=${encodeURIComponent(path)}`);
    return res.json();
  }

  async writeFile(path: string, content: string): Promise<{ ok: boolean; path: string }> {
    const res = await this.fetch("/api/file-write", {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    });
    return res.json();
  }

  async createFile(path: string, content?: string): Promise<{ ok: boolean; path: string }> {
    const res = await this.fetch("/api/file-create", {
      method: "POST",
      body: JSON.stringify({ path, content }),
    });
    return res.json();
  }

  async createDirectory(path: string): Promise<{ ok: boolean; path: string }> {
    const res = await this.fetch("/api/dir-create", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    return res.json();
  }

  async browse(path?: string, opts?: { includeHidden?: boolean; includeFiles?: boolean }): Promise<BrowseResult> {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (opts?.includeHidden) params.set("includeHidden", "1");
    if (opts?.includeFiles) params.set("includeFiles", "1");
    const q = params.toString();
    const res = await this.fetch(`/api/browse${q ? `?${q}` : ""}`);
    return res.json();
  }

  // Memory
  async queryMemories(opts?: { userProfile?: string; cwd?: string }): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (opts?.userProfile) params.set("userProfile", opts.userProfile);
    if (opts?.cwd) params.set("cwd", opts.cwd);
    const q = params.toString();
    const res = await this.fetch(`/api/memories${q ? `?${q}` : ""}`);
    return res.json();
  }

  // Prompts
  async listPrompts(opts?: { tags?: string[]; projectCwd?: string }): Promise<PromptListItem[]> {
    const params = new URLSearchParams();
    if (opts?.tags?.length) params.set("tags", opts.tags.join(","));
    if (opts?.projectCwd) params.set("projectCwd", opts.projectCwd);
    const q = params.toString();
    const res = await this.fetch(`/api/prompts${q ? `?${q}` : ""}`);
    return res.json();
  }

  async renderPrompt(name: string, vars?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.fetch(`/api/prompts/${encodeURIComponent(name)}/render`, {
      method: "POST",
      body: JSON.stringify(vars ?? {}),
    });
    return res.json();
  }

  // Activity / Analytics
  async getActivity(opts?: { userProfile?: string; since?: number; limit?: number; eventType?: string }): Promise<ActivityEntry[]> {
    const params = new URLSearchParams();
    if (opts?.userProfile) params.set("userProfile", opts.userProfile);
    if (opts?.since) params.set("since", String(opts.since));
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.eventType) params.set("eventType", opts.eventType);
    const q = params.toString();
    const res = await this.fetch(`/api/activity${q ? `?${q}` : ""}`);
    return res.json();
  }

  async getActivitySummary(opts?: { userProfile?: string; hours?: number }): Promise<ActivitySummaryResult> {
    const params = new URLSearchParams();
    if (opts?.userProfile) params.set("userProfile", opts.userProfile);
    if (opts?.hours) params.set("hours", String(opts.hours));
    const q = params.toString();
    const res = await this.fetch(`/api/activity/summary${q ? `?${q}` : ""}`);
    return res.json();
  }

  async getSessionStats(userProfile?: string): Promise<Record<string, unknown>> {
    const q = userProfile ? `?userProfile=${encodeURIComponent(userProfile)}` : "";
    const res = await this.fetch(`/api/stats/sessions${q}`);
    return res.json();
  }

  async getDeepAnalytics(opts?: { userProfile?: string; cwd?: string; provider?: string; start?: number; end?: number; bucketMs?: number }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (opts?.userProfile) params.set("userProfile", opts.userProfile);
    if (opts?.cwd) params.set("cwd", opts.cwd);
    if (opts?.provider) params.set("provider", opts.provider);
    if (opts?.start) params.set("start", String(opts.start));
    if (opts?.end) params.set("end", String(opts.end));
    if (opts?.bucketMs) params.set("bucketMs", String(opts.bucketMs));
    const q = params.toString();
    const res = await this.fetch(`/api/analytics/deep${q ? `?${q}` : ""}`);
    return res.json();
  }

  // Notes
  async listNotes(cwd: string): Promise<NoteListItem[]> {
    const res = await this.fetch(`/api/notes?cwd=${encodeURIComponent(cwd)}`);
    return res.json();
  }

  async createNote(cwd: string, note: { title?: string; content?: string; tags?: string[] }): Promise<{ id: string; title: string; created: string; updated: string }> {
    const res = await this.fetch(`/api/notes?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: JSON.stringify(note),
    });
    return res.json();
  }

  async updateNote(id: string, cwd: string, note: { title?: string; content?: string; tags?: string[] }): Promise<NoteDetail> {
    const res = await this.fetch(`/api/notes/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "PUT",
      body: JSON.stringify(note),
    });
    return res.json();
  }

  async deleteNote(id: string, cwd: string): Promise<{ ok: boolean }> {
    const res = await this.fetch(`/api/notes/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "DELETE",
    });
    return res.json();
  }

  // ── Convenience: run-to-completion ──

  /**
   * Send a prompt and wait for the session to finish.
   * Returns all events collected during the run.
   */
  async run(opts: InteractOptions): Promise<{ sessionId: string; events: SSEEvent[] }> {
    const handle = await this.interact({ ...opts, subscribe: true });
    const collected: SSEEvent[] = [];
    let sessionId = opts.sessionId ?? "";

    for await (const evt of handle.events) {
      collected.push(evt);
      if (!sessionId && evt.data?.sessionId) {
        sessionId = evt.data.sessionId as string;
      }
    }

    return { sessionId, events: collected };
  }

  /**
   * Send a prompt and return just the final assistant text.
   */
  async prompt(opts: InteractOptions): Promise<{ sessionId: string; text: string }> {
    const { sessionId, events } = await this.run(opts);

    // Collect text from stream_event deltas and result
    let text = "";
    for (const evt of events) {
      const d = evt.data as any;
      if (evt.event === "stream_event") {
        const inner = d?.event;
        if (inner?.type === "content_block_delta") {
          const delta = inner.delta;
          if (delta?.type === "text_delta" && delta.text) text += delta.text;
        }
      } else if (evt.event === "result" && d?.result) {
        // result.result contains the final text for some providers
        text = d.result as string;
      }
    }

    return { sessionId, text };
  }

  // ── Internal ──

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    await this.ensureAuth();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> ?? {}),
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    const res = await globalThis.fetch(`${this.url}${path}`, { ...init, headers });
    if (!res.ok && !init?.signal) {
      // Don't throw for streaming requests (they handle errors themselves)
      const text = await res.text().catch(() => res.statusText);
      let detail = text;
      try { const j = JSON.parse(text); detail = j.error ?? j.message ?? text; } catch {}
      throw new ModusError(res.status, detail, path);
    }
    return res;
  }
}

// ── SSE Parser ──

async function* parseSSEStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SSEEvent> {
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
        if (currentEvent === "done") return;
        if (currentEvent === "ping") continue;
        try {
          const data = JSON.parse(line.slice(6));
          yield { event: currentEvent, data, seq: Number(currentId) || 0 };
        } catch { /* skip malformed */ }
      }
    }
  }
}
