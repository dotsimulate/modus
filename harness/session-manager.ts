/**
 * Session Manager — decouples agent lifecycle from HTTP connections.
 *
 * Orchestrates session creation, persistence, SSE broadcasting, and message routing.
 * Provider-specific execution logic lives in providers/ — session-manager delegates
 * to whichever provider the profile specifies.
 *
 * Session-manager owns:
 * - DB row creation (always upfront, before provider starts)
 * - Event persistence + SSE broadcasting
 * - Session ID lifecycle (generate temp, optional rekey by provider)
 * - Subscriber management
 *
 * Session-manager does NOT:
 * - Emit init events (user/prompt, system/init) — that's the provider's job
 * - Know which provider is running — all paths are provider-agnostic
 */

import {
  upsertSession, updateSessionStatus, addEvent, renameSession, getSession,
  copyEventsToSession, findAssistantUuid, clearBranchFields,
  addSessionTag, parseTags,
} from "./db";
import { logActivity } from "./activity";

// Lazy import to avoid circular dep (action-runner → session-manager → action-runner)
let _onSessionEvent: typeof import("./action-runner").onSessionEvent | null = null;
function getOnSessionEvent() {
  if (!_onSessionEvent) {
    _onSessionEvent = require("./action-runner").onSessionEvent;
  }
  return _onSessionEvent!;
}
import { getProfile, getUserData, getUserProfile } from "./profiles";
import { getProvider } from "./providers/registry";
import type { SessionProvider, TurnContext } from "./providers/types";

// ── Types ──

export type SessionStatus = "starting" | "running" | "idle" | "paused" | "done" | "error";

export type SSEWriter = {
  write(event: string, data: string, id: string): Promise<void>;
  close(): void;
};

export type ImageAttachment = {
  type: "image";
  mediaType: string;
  data: string;
  name?: string;
};

/** Content can be a plain string or structured content blocks (for images) */
export type MessageContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
>;

export type ActiveSession = {
  sessionId: string;
  tempId: string;
  status: SessionStatus;
  profile: string | undefined;
  model: string | undefined;
  seq: number;
  startedAt: number;
  lastEventAt: number;
  costUsd: number;
  numTurns: number;
  /** Count of complete user↔assistant exchanges (1 per result event). Used for session trigger round matching. */
  exchangeCount: number;
  error: string | null;
  preview: string;
  lastAssistantText: string;
  initialPrompt: string;
  initialContent: MessageContent;
  subscribers: Set<SSEWriter>;
  abortController: AbortController;
  pendingMessages: MessageContent[];
  turnStartedAt: number;
  cwd?: string;
  actionName?: string;
  userProfile?: string;
  pauseRequested: boolean;
  pauseResolver: (() => void) | null;
  pendingPermissions: Map<string, {
    resolve: (result: { behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }) => void;
    toolName: string;
    input: Record<string, unknown>;
    requestedAt: number;
  }>;
  sessionApprovals: Set<string>;
  /** Provider implementation for this session */
  _provider: SessionProvider;
  /** Provider-specific state (opaque to session-manager) */
  _providerState: unknown;
};

// ── Helpers ──

export function buildContent(prompt: string, attachments?: ImageAttachment[]): MessageContent {
  if (!attachments?.length) return prompt;
  const blocks: MessageContent = [];
  for (const att of attachments) {
    (blocks as any[]).push({
      type: "image",
      source: { type: "base64", media_type: att.mediaType, data: att.data },
    });
  }
  if (prompt) (blocks as any[]).push({ type: "text", text: prompt });
  return blocks;
}

export function contentPreview(content: MessageContent, maxLen = 80): string {
  if (typeof content === "string") return content.slice(0, maxLen);
  const textBlock = (content as any[]).find((b: any) => b.type === "text");
  const text = textBlock?.text ?? "";
  const imgCount = (content as any[]).filter((b: any) => b.type === "image").length;
  const prefix = imgCount > 0 ? `[${imgCount} image${imgCount > 1 ? "s" : ""}] ` : "";
  return (prefix + text).slice(0, maxLen);
}

// ── Active Sessions Map ──

const activeSessions = new Map<string, ActiveSession>();

export function getActiveSession(id: string): ActiveSession | undefined {
  return activeSessions.get(id);
}

export function getAllActiveSessions(): ActiveSession[] {
  return Array.from(activeSessions.values());
}

// ── TurnContext Factory ──
// Creates the context object that providers use to interact with session-manager.

function createTurnContext(session: ActiveSession, opts: StartSessionOpts): TurnContext {
  const profile = opts.profile ? getProfile(opts.profile) : undefined;

  return {
    session,
    opts,
    profile,

    emitEvent(event: any) {
      session.seq++;
      addEvent(
        session.sessionId,
        session.seq,
        event.type,
        event.subtype ?? null,
        JSON.stringify(event),
      );
      const data = JSON.stringify(event);
      const seqStr = String(session.seq);
      for (const sub of session.subscribers) {
        try { sub.write(event.type, data, seqStr); } catch { session.subscribers.delete(sub); }
      }
    },

    broadcastEvent(event: any) {
      const data = JSON.stringify(event);
      const seqStr = String(session.seq);
      for (const sub of session.subscribers) {
        try { sub.write(event.type, data, seqStr); } catch { session.subscribers.delete(sub); }
      }
    },

    rekeySession(newId: string) {
      const oldId = session.sessionId;
      activeSessions.delete(oldId);
      session.sessionId = newId;
      activeSessions.set(newId, session);
      if (oldId !== newId) {
        renameSession(oldId, newId);
      }
    },

    updateSessionDb(updates) {
      upsertSession({
        id: session.sessionId,
        preview: session.preview,
        profile: session.profile,
        model: session.model,
        status: updates.status ?? session.status,
        messageCount: updates.messageCount ?? 0,
        costUsd: updates.costUsd ?? session.costUsd,
        lastPrompt: updates.lastPrompt ?? session.preview,
        lastResponse: updates.lastResponse,
        cwd: session.cwd,
        actionName: session.actionName,
      });

      // Emit session trigger: assistant round end (on successful turn completion)
      if (updates.status === "idle" || updates.status === "done") {
        // exchangeCount tracks user↔assistant rounds (1 per result), not SDK agentic turns
        session.exchangeCount++;
        const dbRow = getSession(session.sessionId);
        const tags = dbRow ? parseTags(dbRow.tags) : [];
        console.log(`[session-trigger] emission: status=${updates.status} exchange=${session.exchangeCount} session=${session.sessionId.slice(0, 12)}…`);
        try {
          getOnSessionEvent()(
            { role: "assistant", round: session.exchangeCount, at: "end" },
            {
              id: session.sessionId, userProfile: session.userProfile, tags,
              preview: session.preview, title: dbRow?.title,
              messageCount: updates.messageCount ?? 0,
              lastResponse: updates.lastResponse,
            },
          );
        } catch (err) {
          console.error(`[session-trigger] onSessionEvent failed:`, err);
        }
      }
    },
  };
}

// ── Start Session ──

export type StartSessionOpts = {
  prompt: string | MessageContent;
  attachments?: ImageAttachment[];
  profile?: string;
  userProfile?: string;
  provider?: string;
  model?: string;
  toolStates?: Record<string, string>;
  maxTurns?: number;
  effort?: string;
  cwd?: string;
  tools?: string[];
  disallowedTools?: string[];
  loadProjectSettings?: boolean;
  sessionId?: string;
  actionName?: string;
  /** For branched sessions: parent session ID to fork from (SDK resume source) */
  branchParentId?: string;
  /** For branched sessions: SDK message UUID to resume at */
  branchMessageUUID?: string;
};

function configEventPayload(config: {
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  toolStates?: Record<string, string>;
  cwd?: string;
  loadProjectSettings?: boolean;
}) {
  return {
    provider: config.provider ?? "",
    model: config.model ?? "",
    effort: config.effort ?? "",
    maxTurns: config.maxTurns,
    toolStates: config.toolStates ?? {},
  };
}

export function startSession(opts: StartSessionOpts): ActiveSession {
  const profileDef = opts.profile ? getProfile(opts.profile) : undefined;
  const userProf = opts.userProfile ? getUserProfile(opts.userProfile) : undefined;
  // Cascade: session override > agent profile > user profile > default
  const providerName = opts.provider ?? profileDef?.provider ?? userProf?.provider ?? "claude-code";
  const provider = getProvider(providerName);

  // Resolve system prompt template vars
  let systemPrompt = profileDef?.prompt;
  if (systemPrompt) {
    const userData = getUserData();
    systemPrompt = systemPrompt.replace(/\{\{(\w+)\}\}/g, (_, key) => userData[key] ?? `{{${key}}}`);
  }

  const initialContent = typeof opts.prompt === "string"
    ? buildContent(opts.prompt, opts.attachments)
    : opts.prompt; // already MessageContent (content blocks from actions)

  // Session ID: use provided ID (for resume), otherwise generate one.
  // Provider can rekey later if its backend provides a different ID.
  const tempId = opts.sessionId ?? `ses-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const isResume = !!opts.sessionId && !!getSession(opts.sessionId);

  // Branch detection: if resuming a session that has parent_session_id,
  // pass fork opts to the provider and clear the fields so it only forks once.
  if (isResume && !opts.branchParentId) {
    const dbRow = getSession(opts.sessionId!);
    if (dbRow?.parent_session_id && dbRow.branch_message_uuid) {
      opts.branchParentId = dbRow.parent_session_id;
      opts.branchMessageUUID = dbRow.branch_message_uuid;
      // Clear branch fields so next resume is a normal resume, not another fork
      clearBranchFields(opts.sessionId!);
      console.log(`[branch-detect] Will fork ${opts.sessionId} from parent=${opts.branchParentId} at message=${opts.branchMessageUUID}`);
    }
  }

  const session: ActiveSession = {
    sessionId: tempId,
    tempId,
    status: "starting",
    profile: opts.profile,
    model: opts.model ?? profileDef?.model,
    seq: 0,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    costUsd: 0,
    numTurns: 0,
    exchangeCount: 0,
    error: null,
    preview: contentPreview(initialContent),
    lastAssistantText: "",
    initialPrompt: typeof opts.prompt === "string" ? opts.prompt : contentPreview(opts.prompt),
    initialContent,
    subscribers: new Set(),
    abortController: new AbortController(),
    pendingMessages: [],
    turnStartedAt: Date.now(),
    cwd: opts.cwd ?? process.env.AGENT_CWD ?? process.cwd(),
    actionName: opts.actionName,
    userProfile: opts.userProfile,
    pauseRequested: false,
    pauseResolver: null,
    pendingPermissions: new Map(),
    sessionApprovals: new Set(),
    _provider: provider,
    _providerState: null,
  };

  activeSessions.set(tempId, session);

  // DB row: always exists before provider starts.
  // Resume: update status on existing row (preserves cost, message count, etc.)
  // New: create fresh row.
  if (isResume) {
    updateSessionStatus(tempId, "starting");
    // Seed exchangeCount from persisted message_count so session triggers
    // don't re-fire (e.g. round:1 won't match an established session after restart)
    const resumeRow = getSession(tempId);
    if (resumeRow?.message_count) {
      session.exchangeCount = Math.ceil(resumeRow.message_count / 2);
    }
  } else {
    upsertSession({
      id: tempId,
      preview: session.preview,
      profile: session.profile,
      model: session.model,
      status: "starting",
      messageCount: 0,
      costUsd: 0,
      lastPrompt: session.preview,
      cwd: session.cwd,
      actionName: session.actionName,
      userProfile: session.userProfile,
    });
    // Auto-tag action-spawned sessions as internal (prevents cascade triggers)
    if (session.actionName) {
      addSessionTag(tempId, "internal");
    }
  }

  // Delegate to provider — provider handles init events (user/prompt, system/init)
  const ctx = createTurnContext(session, opts);
  provider.startTurn(ctx);

  logActivity({
    userProfile: session.userProfile,
    eventType: "session_start",
    sessionId: session.sessionId,
    agentProfile: session.profile,
    summary: `Session started: ${session.preview.slice(0, 100)}`,
    metadata: { provider: providerName, model: session.model, cwd: session.cwd, isResume },
  });

  // Emit session trigger: user round 1 start (for new sessions only)
  if (!isResume) {
    const dbRow = getSession(tempId);
    const tags = dbRow ? parseTags(dbRow.tags) : [];
    getOnSessionEvent()(
      { role: "user", round: 1, at: "start" },
      { id: tempId, userProfile: session.userProfile, tags, preview: session.preview, title: null, messageCount: 0 },
    );
  }

  return session;
}

// ── Session Control ──

export function queueMessage(sessionId: string, prompt: string, attachments?: ImageAttachment[]): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  const content = buildContent(prompt, attachments);

  // Persist user event for catch-up replay
  session.seq++;
  addEvent(sessionId, session.seq, "user", "prompt", JSON.stringify({
    type: "user",
    subtype: "prompt",
    message: { role: "user", content },
  }));

  // If paused, queue the message — it will be flushed on resume
  if (session.status === "paused") {
    session.pendingMessages.push(content);
    return true;
  }

  // Emit session trigger: user round start (exchangeCount is 0-based before this exchange completes)
  const userRound = session.exchangeCount + 1;
  const dbRow = getSession(sessionId);
  const tags = dbRow ? parseTags(dbRow.tags) : [];
  getOnSessionEvent()(
    { role: "user", round: userRound, at: "start" },
    { id: sessionId, userProfile: session.userProfile, tags, preview: session.preview, title: dbRow?.title, messageCount: session.exchangeCount * 2 },
  );

  // Delegate to provider (provider sets status to "running" internally)
  const ctx = createTurnContext(session, {
    prompt,
    attachments,
    profile: session.profile,
    sessionId,
  });
  session._provider.sendMessage(ctx, content);

  return true;
}

export function stopSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  // Resolve pending pause before aborting
  if (session.pauseResolver) {
    session.pauseResolver();
    session.pauseResolver = null;
  }
  session.pauseRequested = false;

  // Resolve any pending permission promises before aborting
  for (const [id, pending] of session.pendingPermissions) {
    pending.resolve({ behavior: "deny", message: "Session interrupted" });
    session.pendingPermissions.delete(id);
  }

  // Force idle IMMEDIATELY — don't wait for the provider to propagate
  session.status = "idle";
  updateSessionStatus(session.sessionId, "idle");
  const interruptData = JSON.stringify({ type: "system", subtype: "interrupted" });
  session.seq++;
  addEvent(session.sessionId, session.seq, "system", "interrupted", interruptData);
  for (const sub of session.subscribers) {
    try { sub.write("system", interruptData, String(session.seq)); } catch { session.subscribers.delete(sub); }
  }

  // Delegate to provider for cleanup
  session._provider.abort(session);

  logActivity({
    userProfile: session.userProfile,
    eventType: "agent_interrupted",
    sessionId: session.sessionId,
    agentProfile: session.profile,
    summary: "Session interrupted by user",
  });

  return true;
}

export function stopTask(sessionId: string, taskId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  return session._provider.stopTask?.(session, taskId) ?? false;
}

// ── Pause / Resume ──

export function pauseSession(sessionId: string): { ok: boolean; status?: SessionStatus } {
  const session = activeSessions.get(sessionId);
  if (!session) return { ok: false };
  if (session.status === "paused") return { ok: true, status: "paused" };

  if (session.status === "running" || session.status === "starting") {
    // Agent is mid-turn — flag it so the provider pauses at next tool boundary
    session.pauseRequested = true;
    const eventData = JSON.stringify({ type: "system", subtype: "pause_requested" });
    session.seq++;
    addEvent(session.sessionId, session.seq, "system", "pause_requested", eventData);
    for (const sub of session.subscribers) {
      try { sub.write("system", eventData, String(session.seq)); } catch { session.subscribers.delete(sub); }
    }
    return { ok: true, status: session.status };
  }

  if (session.status === "idle") {
    // Not running — pause immediately
    session.status = "paused";
    updateSessionStatus(session.sessionId, "paused");
    const eventData = JSON.stringify({ type: "system", subtype: "paused" });
    session.seq++;
    addEvent(session.sessionId, session.seq, "system", "paused", eventData);
    for (const sub of session.subscribers) {
      try { sub.write("system", eventData, String(session.seq)); } catch { session.subscribers.delete(sub); }
    }
    return { ok: true, status: "paused" };
  }

  return { ok: false };
}

export function resumeSession(sessionId: string): { ok: boolean; status?: SessionStatus } {
  const session = activeSessions.get(sessionId);
  if (!session) return { ok: false };

  // Clear pending pause flag if it hasn't been consumed yet
  if (session.pauseRequested) {
    session.pauseRequested = false;
  }

  if (session.status !== "paused") return { ok: true, status: session.status };

  // Emit resumed event
  const eventData = JSON.stringify({ type: "system", subtype: "resumed" });
  session.seq++;
  addEvent(session.sessionId, session.seq, "system", "resumed", eventData);
  for (const sub of session.subscribers) {
    try { sub.write("system", eventData, String(session.seq)); } catch { session.subscribers.delete(sub); }
  }

  if (session.pauseResolver) {
    // Was paused at a tool boundary — resolve the held promise to continue
    session.status = "running";
    updateSessionStatus(session.sessionId, "running");
    session.pauseResolver();
    session.pauseResolver = null;
  } else if (session.pendingMessages.length > 0) {
    // Was paused while idle with queued messages — flush them
    const next = session.pendingMessages.shift()!;
    const ctx = createTurnContext(session, {
      prompt: typeof next === "string" ? next : "",
      profile: session.profile,
      sessionId,
    });
    session.status = "starting";
    updateSessionStatus(session.sessionId, "starting");
    session._provider.sendMessage(ctx, next);
  } else {
    // Was paused while idle, no pending messages
    session.status = "idle";
    updateSessionStatus(session.sessionId, "idle");
  }

  return { ok: true, status: session.status };
}

export function updateSessionConfig(
  sessionId: string,
  config: {
    provider?: string;
    model?: string;
    effort?: string;
    maxTurns?: number;
    tools?: string[];
    disallowedTools?: string[];
    toolStates?: Record<string, string>;
    cwd?: string;
    loadProjectSettings?: boolean;
  },
): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  if (config.model !== undefined) {
    session.model = config.model || getProfile(session.profile ?? "")?.model;
  }
  if (config.cwd !== undefined) {
    session.cwd = config.cwd;
  }
  session._provider.updateConfig?.(session, config);
  session.seq++;
  addEvent(session.sessionId, session.seq, "system", "config_updated", JSON.stringify({
    type: "system",
    subtype: "config_updated",
    model: session.model,
    config: configEventPayload(config),
    cwd: session.cwd,
    loadProjectSettings: config.loadProjectSettings,
  }));
  return true;
}

// ── Profile Switch ──

export type SwitchProfileOpts = {
  contextMode?: "full" | "summary" | "lastResponse";
};

export async function switchProfile(
  sessionId: string,
  newProfileName: string,
  opts?: SwitchProfileOpts,
): Promise<boolean> {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  const newProfile = getProfile(newProfileName);
  if (!newProfile) return false;

  const contextMode = opts?.contextMode ?? "full";
  const oldProfileName = session.profile;
  const oldProvider = session._provider;
  const newProviderName = newProfile.provider ?? "claude-code";
  const oldProviderName = oldProfileName ? (getProfile(oldProfileName)?.provider ?? "claude-code") : "claude-code";
  const sameProvider = newProviderName === oldProviderName;

  // Step 1: Abort current turn if running/paused — wait for settle
  if (session.pauseResolver) {
    session.pauseResolver();
    session.pauseResolver = null;
  }
  session.pauseRequested = false;

  if (session.status === "running" || session.status === "starting" || session.status === "paused") {
    // Resolve any pending permission promises
    for (const [id, pending] of session.pendingPermissions) {
      pending.resolve({ behavior: "deny", message: "Profile switch" });
      session.pendingPermissions.delete(id);
    }
    session.status = "idle";
    updateSessionStatus(session.sessionId, "idle");
    oldProvider.abort(session);
    // Brief settle timeout for provider drain to complete
    await new Promise((r) => setTimeout(r, 200));
  }

  // Step 2: Resolve system prompt template vars
  let systemPrompt = newProfile.prompt;
  if (systemPrompt) {
    const userData = getUserData();
    systemPrompt = systemPrompt.replace(/\{\{(\w+)\}\}/g, (_, key) => userData[key] ?? `{{${key}}}`);
  }

  // Step 3–5: Provider swap
  const ctx = createTurnContext(session, {
    prompt: "",
    profile: newProfileName,
    provider: newProviderName,
    model: newProfile.model,
    effort: newProfile.effort,
    maxTurns: newProfile.maxTurns,
    tools: newProfile.tools,
    disallowedTools: newProfile.disallowedTools,
    cwd: session.cwd,
    loadProjectSettings: newProfile.loadProjectSettings,
  });

  if (sameProvider && oldProvider.switchProfile) {
    // In-place swap: let provider handle internals
    oldProvider.switchProfile(session, ctx, contextMode);
  } else if (!sameProvider) {
    // Cross-provider switch: tear down old, dispose resources (MCP, AgentSession)
    oldProvider.abort(session);
    await oldProvider.dispose?.(session);
    const newProvider = getProvider(newProviderName);
    session._provider = newProvider;
    session._providerState = null;
    // New provider will be started on next message send
  } else {
    // Same provider, no switchProfile method — update config directly
    oldProvider.updateConfig?.(session, {
      model: newProfile.model,
      effort: newProfile.effort,
      maxTurns: newProfile.maxTurns,
      tools: newProfile.tools,
      disallowedTools: newProfile.disallowedTools,
    });
  }

  // Step 6: Update ActiveSession fields
  session.profile = newProfileName;
  session.model = newProfile.model ?? session.model;
  session.abortController = new AbortController();
  session.pendingMessages = [];

  // Step 7: Emit system/switch event + update DB
  session.seq++;
  const switchEvent = {
    type: "system",
    subtype: "switch",
    fromProfile: oldProfileName ?? null,
    toProfile: newProfileName,
    contextMode,
    model: session.model,
    provider: newProviderName,
  };
  addEvent(session.sessionId, session.seq, "system", "switch", JSON.stringify(switchEvent));
  for (const sub of session.subscribers) {
    try { sub.write("system", JSON.stringify(switchEvent), String(session.seq)); } catch { session.subscribers.delete(sub); }
  }

  // Update DB row with new profile
  upsertSession({
    id: session.sessionId,
    preview: session.preview,
    profile: newProfileName,
    model: session.model,
    status: session.status,
    messageCount: session.numTurns * 2,
    costUsd: session.costUsd,
    lastPrompt: session.preview,
    cwd: session.cwd,
    actionName: session.actionName,
  });

  return true;
}

// ── Permission Response ──

export function resolvePermission(
  sessionId: string,
  requestId: string,
  response: { behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string; scope?: "once" | "session" },
): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  const pending = session.pendingPermissions.get(requestId);
  if (!pending) return false;
  if (response.behavior === "allow" && response.scope === "session") {
    session.sessionApprovals.add(pending.toolName);
  }
  pending.resolve(response);
  return true;
}

// ── Subscriber Management ──

export function subscribe(sessionId: string, writer: SSEWriter): () => void {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.subscribers.add(writer);
    return () => { session.subscribers.delete(writer); };
  }
  return () => {};
}

// ── Cleanup ──

export function shutdownAll() {
  for (const [id, session] of activeSessions) {
    try {
      if (session.pauseResolver) {
        session.pauseResolver();
        session.pauseResolver = null;
      }
      session._provider.abort(session);
      session._provider.dispose?.(session).catch(() => {});
    } catch { /* best effort */ }
    activeSessions.delete(id);
  }
}

// ── Branching ──

export function branchSession(
  sourceId: string,
  branchSeq: number,
): { sessionId: string } | { error: string } {
  const source = getSession(sourceId);
  if (!source) return { error: "source session not found" };

  // Find the SDK assistant message UUID for resumeSessionAt
  const messageUuid = findAssistantUuid(sourceId, branchSeq);

  // Create new session — just a copy with a fresh ID
  const newId = crypto.randomUUID();

  // Create DB row first (events FK references sessions)
  upsertSession({
    id: newId,
    preview: source.preview,
    profile: source.profile ?? undefined,
    model: source.model ?? undefined,
    status: "idle",
    messageCount: 0,
    costUsd: 0,
    lastPrompt: source.last_prompt ?? undefined,
    cwd: source.cwd ?? undefined,
    parentSessionId: sourceId,
    branchMessageUuid: messageUuid ?? undefined,
  });

  // Copy events from source up to branchSeq
  const copied = copyEventsToSession(sourceId, newId, branchSeq);
  if (copied === 0) return { error: "no events to copy at that seq" };

  return { sessionId: newId };
}
