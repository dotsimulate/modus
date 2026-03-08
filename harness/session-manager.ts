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
} from "./db";
import { getProfile, getUserData, getUserProfile } from "./profiles";
import { getProvider } from "./providers/registry";
import type { SessionProvider, TurnContext } from "./providers/types";

// ── Types ──

export type SessionStatus = "starting" | "running" | "idle" | "done" | "error";

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
    });
  }

  // Delegate to provider — provider handles init events (user/prompt, system/init)
  const ctx = createTurnContext(session, opts);
  provider.startTurn(ctx);

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

  // Delegate to provider
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

  return true;
}

export function stopTask(sessionId: string, taskId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  return session._provider.stopTask?.(session, taskId) ?? false;
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

  // Step 1: Abort current turn if running — wait for settle
  if (session.status === "running" || session.status === "starting") {
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
    // Cross-provider switch: tear down old, create new
    oldProvider.abort(session);
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
      session._provider.abort(session);
    } catch { /* best effort */ }
    activeSessions.delete(id);
  }
}
