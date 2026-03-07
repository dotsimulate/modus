/**
 * Session Manager — decouples agent lifecycle from HTTP connections.
 *
 * Orchestrates session creation, persistence, SSE broadcasting, and message routing.
 * Provider-specific execution logic lives in providers/ — session-manager delegates
 * to whichever provider the profile specifies.
 */

import {
  upsertSession, updateSessionStatus, addEvent,
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
      if (session.sessionId && !session.sessionId.startsWith("pending-")) {
        session.seq++;
        addEvent(
          session.sessionId,
          session.seq,
          event.type,
          event.subtype ?? null,
          JSON.stringify(event),
        );
      }
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
      activeSessions.delete(session.tempId);
      session.sessionId = newId;
      activeSessions.set(newId, session);
    },

    updateSessionDb(updates) {
      if (!session.sessionId || session.sessionId.startsWith("pending-")) return;
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
  const isClaudeCode = providerName === "claude-code";
  const tempId = isClaudeCode
    ? (opts.sessionId ?? `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    : `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

  const ctx = createTurnContext(session, opts);

  // For non-SDK providers, set up DB row + init event immediately
  // (SDK providers handle this in the drain loop when init event arrives)
  if (!isClaudeCode) {
    upsertSession({
      id: tempId,
      preview: session.preview,
      profile: session.profile,
      model: session.model,
      status: "running",
      messageCount: 0,
      costUsd: 0,
      lastPrompt: session.preview,
      cwd: opts.cwd ?? process.env.AGENT_CWD ?? process.cwd(),
      actionName: session.actionName,
    });

    // Persist initial user message
    ctx.emitEvent({
      type: "user",
      subtype: "prompt",
      message: { role: "user", content: initialContent },
    });

    // Emit init event
    const initEvent = {
      type: "system",
      subtype: "init",
      session_id: tempId,
      model: session.model,
      provider: providerName,
      config: configEventPayload(opts),
      cwd: session.cwd,
      loadProjectSettings: opts.loadProjectSettings ?? profileDef?.loadProjectSettings ?? true,
      tools: [],
    };
    ctx.emitEvent(initEvent);
    session.status = "running";
  }

  // Delegate to provider
  provider.startTurn(ctx);

  return session;
}

// ── Session Control ──

export function queueMessage(sessionId: string, prompt: string, attachments?: ImageAttachment[]): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  const content = buildContent(prompt, attachments);

  // Persist user event for catch-up replay
  if (!sessionId.startsWith("pending-")) {
    session.seq++;
    addEvent(sessionId, session.seq, "user", "prompt", JSON.stringify({
      type: "user",
      subtype: "prompt",
      message: { role: "user", content },
    }));
  }

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
  if (session.sessionId && !session.sessionId.startsWith("pending-")) {
    updateSessionStatus(session.sessionId, "idle");
    const interruptData = JSON.stringify({ type: "system", subtype: "interrupted" });
    session.seq++;
    addEvent(session.sessionId, session.seq, "system", "interrupted", interruptData);
    for (const sub of session.subscribers) {
      try { sub.write("system", interruptData, String(session.seq)); } catch { session.subscribers.delete(sub); }
    }
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
