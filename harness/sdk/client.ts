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
} from "./types";

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

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`interact failed (${res.status}): ${text}`);
    }

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

  async getProfile(name: string): Promise<Profile> {
    const res = await this.fetch(`/api/profiles/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Profile not found: ${name}`);
    return res.json();
  }

  // ── Moves ──

  async listMoves(cwd: string): Promise<MoveListItem[]> {
    const res = await this.fetch(`/api/moves?cwd=${encodeURIComponent(cwd)}`);
    if (!res.ok) return [];
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
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Move activation failed");
    return data;
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
    return globalThis.fetch(`${this.url}${path}`, { ...init, headers });
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
