/**
 * Session Manager — decouples agent lifecycle from HTTP connections.
 *
 * Each active session holds a Query object (SDK subprocess) in memory.
 * Clients subscribe/unsubscribe via SSE without affecting the agent.
 * Events are persisted to DB as they arrive, enabling catch-up on reconnect.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
  upsertSession, updateSessionStatus, addEvent, getMaxSeq, getSession,
} from "./db";
import { getProfile, getGlobalConfig, getUserData, type McpServerConfig } from "./profiles";
import { resolveSecret } from "./secrets";

const CLAUDE_PATH =
  process.env.CLAUDE_PATH || `${process.env.HOME}/.local/bin/claude`;

// ── MCP Env Var Resolution ──

/** Replace $VAR_NAME references in MCP server env objects using the secrets loader */
function resolveEnvVars(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const resolved: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if ("env" in config && config.env) {
      const resolvedEnv: Record<string, string> = {};
      for (const [key, val] of Object.entries(config.env)) {
        if (typeof val === "string" && val.startsWith("$")) {
          const envVal = resolveSecret(val.slice(1));
          if (envVal !== undefined) {
            resolvedEnv[key] = envVal;
          } else {
            console.warn(`[mcp] Missing secret: ${val} for MCP server "${name}"`);
            console.warn(`[mcp] Add ${val.slice(1)} to ~/.config/harness/secrets.env`);
          }
        } else {
          resolvedEnv[key] = val;
        }
      }
      resolved[name] = { ...config, env: resolvedEnv } as McpServerConfig;
    } else {
      resolved[name] = config;
    }
  }
  return resolved;
}

// ── Types ──

export type SessionStatus = "starting" | "running" | "idle" | "done" | "error";

export type SSEWriter = {
  write(event: string, data: string, id: string): Promise<void>;
  close(): void;
};

/** An attachment sent from the frontend (base64 image) */
export type ImageAttachment = {
  type: "image";
  mediaType: string;
  data: string;
  name?: string;
};

/** Content can be a plain string or structured content blocks (for images) */
type MessageContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
>;

/** Build SDK-compatible content from a prompt string + optional attachments */
function buildContent(prompt: string, attachments?: ImageAttachment[]): MessageContent {
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

/** Extract plain text from content (for preview/logging) */
function contentPreview(content: MessageContent, maxLen = 80): string {
  if (typeof content === "string") return content.slice(0, maxLen);
  const textBlock = (content as any[]).find((b: any) => b.type === "text");
  const text = textBlock?.text ?? "";
  const imgCount = (content as any[]).filter((b: any) => b.type === "image").length;
  const prefix = imgCount > 0 ? `[${imgCount} image${imgCount > 1 ? "s" : ""}] ` : "";
  return (prefix + text).slice(0, maxLen);
}

type InputChannel = {
  push(content: MessageContent): void;
  close(): void;
};

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
  /** Full initial prompt content (may include image blocks) */
  initialPrompt: string;
  /** Initial content for SDK (string or content blocks) */
  initialContent: MessageContent;
  subscribers: Set<SSEWriter>;
  input: InputChannel;
  queryObj: ReturnType<typeof sdkQuery> | null;
  /** Timestamp when current turn started (for harness-side timing) */
  turnStartedAt: number;
  /** SDK options used to create the query (needed for abort+resume) */
  sdkOptions: any;
  /** AbortController for the current query — abort() cleanly breaks the for-await loop */
  abortController: AbortController;
  /** Messages queued while agent is running — flushed to input after result event */
  pendingMessages: MessageContent[];
  /** Skip user/prompt persistence on next resume (already persisted by queueMessage) */
  skipNextPromptPersist?: boolean;
};

// ── Active Sessions Map ──

const activeSessions = new Map<string, ActiveSession>();

export function getActiveSession(id: string): ActiveSession | undefined {
  return activeSessions.get(id);
}

export function getAllActiveSessions(): ActiveSession[] {
  return Array.from(activeSessions.values());
}

// ── Input Channel (async generator for streaming input mode) ──

function createInputChannel(): { generator: AsyncIterable<any>; channel: InputChannel } {
  const queue: any[] = [];
  let resolver: ((val: any) => void) | null = null;
  let closed = false;

  async function* gen() {
    while (!closed) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        const msg = await new Promise<any>((resolve) => { resolver = resolve; });
        if (msg === null) return; // channel closed
        yield msg;
      }
    }
  }

  return {
    generator: gen(),
    channel: {
      push(content: MessageContent) {
        const msg = {
          type: "user" as const,
          message: { role: "user" as const, content },
          parent_tool_use_id: null,
          session_id: "",
        };
        if (resolver) {
          const r = resolver;
          resolver = null;
          r(msg);
        } else {
          queue.push(msg);
        }
      },
      close() {
        closed = true;
        if (resolver) {
          resolver(null);
          resolver = null;
        }
      },
    },
  };
}

// ── Start Session ──

export type StartSessionOpts = {
  prompt: string;
  attachments?: ImageAttachment[];
  profile?: string;
  model?: string;
  maxTurns?: number;
  effort?: string;
  cwd?: string;
  tools?: string[];
  disallowedTools?: string[];
  loadProjectSettings?: boolean;
  sessionId?: string; // for resume
};

export function startSession(opts: StartSessionOpts): ActiveSession {
  const tempId = opts.sessionId ?? `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { generator, channel } = createInputChannel();

  const profileDef = opts.profile ? getProfile(opts.profile) : undefined;

  // Build system prompt — resolve {{key}} template vars from _users.json
  let systemPrompt: string | { type: "preset"; preset: "claude_code"; append?: string } | undefined;
  let rawPrompt = profileDef?.prompt;
  if (rawPrompt) {
    const userData = getUserData();
    rawPrompt = rawPrompt.replace(/\{\{(\w+)\}\}/g, (_, key) => userData[key] ?? `{{${key}}}`);
    if (profileDef?.promptMode === "custom") {
      systemPrompt = rawPrompt;
    } else {
      systemPrompt = { type: "preset", preset: "claude_code", append: rawPrompt };
    }
  }

  // Merge MCP servers: global + profile (profile overrides global by key)
  const globalConfig = getGlobalConfig();
  const mergedMcp = {
    ...(globalConfig.mcpServers ?? {}),
    ...(profileDef?.mcpServers ?? {}),
  };

  // Inject AGENT_PROFILE into agent-memory so saved memories know their origin
  if (mergedMcp["agent-memory"] && opts.profile) {
    const am = mergedMcp["agent-memory"] as any;
    am.env = { ...(am.env ?? {}), AGENT_PROFILE: opts.profile };
  }

  const hasMcp = Object.keys(mergedMcp).length > 0;

  const sdkOptions: any = {
    pathToClaudeCodeExecutable: CLAUDE_PATH,
    cwd: opts.cwd ?? process.env.AGENT_CWD ?? process.cwd(),
    includePartialMessages: true,
    resume: opts.sessionId ?? undefined,
    model: opts.model ?? profileDef?.model ?? undefined,
    effort: opts.effort ?? profileDef?.effort ?? undefined,
    maxTurns: opts.maxTurns ?? profileDef?.maxTurns ?? undefined,
    allowedTools: undefined,
    disallowedTools: opts.disallowedTools ?? profileDef?.disallowedTools ?? undefined,
    tools: opts.tools ?? profileDef?.tools ?? undefined,
    systemPrompt,
    settingSources: (opts.loadProjectSettings ?? profileDef?.loadProjectSettings ?? true) ? ["project"] : [],
    permissionMode: "bypassPermissions" as const,
    mcpServers: hasMcp ? resolveEnvVars(mergedMcp) : undefined,
  };

  const abortController = new AbortController();

  const initialContent = buildContent(opts.prompt, opts.attachments);

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
    initialPrompt: opts.prompt,
    initialContent,
    subscribers: new Set(),
    input: channel,
    queryObj: null,
    turnStartedAt: Date.now(),
    sdkOptions,
    abortController,
    pendingMessages: [],
  };

  activeSessions.set(tempId, session);

  // Push the initial content into the input channel (may include image blocks)
  channel.push(initialContent);

  // Start the SDK query with streaming input
  const q = sdkQuery({ prompt: generator, options: { ...sdkOptions, abortController } });
  session.queryObj = q;

  // Background drain loop — runs until query completes
  drainEvents(session, q).catch((err) => {
    console.error(`[session-manager] drain error for ${session.sessionId}:`, err);
    session.status = "error";
    session.error = String(err);
    updateSessionStatus(session.sessionId, "error");
  });

  return session;
}

// ── Event Drain Loop ──

async function drainEvents(session: ActiveSession, q: AsyncIterable<any>) {
  let initSeen = false;

  try {
    for await (const msg of q) {
      const m = msg as any;
      session.lastEventAt = Date.now();

      // ── Handle system init: capture session ID (first time only)
      if (m.type === "system" && m.subtype === "init" && m.session_id && !initSeen) {
        initSeen = true;
        const realId = m.session_id;
        const isResume = session.tempId === realId && !!getSession(realId);

        // Re-key in the map
        activeSessions.delete(session.tempId);
        session.sessionId = realId;
        activeSessions.set(realId, session);
        session.model = m.model ?? session.model;
        session.status = "running";

        if (isResume) {
          // Resume: pick up existing seq, update status
          session.seq = getMaxSeq(realId);
          updateSessionStatus(realId, "running");
          // Save user message unless already persisted (e.g. restart after abort race)
          if (session.skipNextPromptPersist) {
            session.skipNextPromptPersist = false;
          } else {
            session.seq++;
            addEvent(realId, session.seq, "user", "prompt", JSON.stringify({
              type: "user",
              subtype: "prompt",
              message: { role: "user", content: session.initialContent },
            }));
          }
        } else {
          // Fresh session: create DB row + save first user message
          upsertSession({
            id: realId,
            preview: session.preview,
            profile: session.profile,
            model: session.model,
            status: "running",
            messageCount: 0,
            costUsd: 0,
            lastPrompt: session.preview,
          });
          session.seq++;
          addEvent(realId, session.seq, "user", "prompt", JSON.stringify({
            type: "user",
            subtype: "prompt",
            message: { role: "user", content: session.initialContent },
          }));
        }
      }

      // ── Track running status from assistant messages
      if (m.type === "assistant" && m.message?.content) {
        session.status = "running";
      }

      // ── Handle result: inject harness timing + token count, save assistant message
      if (m.type === "result") {
        // Harness-measured turn duration
        m.harness_duration_ms = Date.now() - session.turnStartedAt;

        // Extract total tokens from modelUsage (SDK-provided)
        if (m.modelUsage && typeof m.modelUsage === "object") {
          let totalIn = 0, totalOut = 0;
          for (const model of Object.values(m.modelUsage) as any[]) {
            totalIn += model.inputTokens ?? 0;
            totalOut += model.outputTokens ?? 0;
          }
          m.total_tokens = totalIn + totalOut;
          m.input_tokens = totalIn;
          m.output_tokens = totalOut;
        }

        const resultText = m.result ?? "";
        session.costUsd += m.total_cost_usd ?? 0;
        session.numTurns += m.num_turns ?? 0;

        if (session.sessionId && !session.sessionId.startsWith("pending-")) {
          upsertSession({
            id: session.sessionId,
            preview: session.preview,
            profile: session.profile,
            model: session.model,
            status: m.subtype === "success" ? "idle" : "error",
            messageCount: session.numTurns * 2,
            costUsd: m.total_cost_usd ?? 0,
            lastPrompt: session.preview,
            lastResponse: resultText.slice(0, 200),
          });
        }

        // After result, the agent is idle (waiting for next input) or done
        // If the input channel is closed, the query will end naturally
        session.status = "idle";

        // Flush any messages that were queued while the agent was running
        if (session.pendingMessages.length > 0) {
          const next = session.pendingMessages.shift()!;
          session.input.push(next);
          session.status = "running";
          session.turnStartedAt = Date.now();
          session.preview = contentPreview(next);
          console.log(`[session-manager] flushing queued message for ${session.sessionId}: "${contentPreview(next, 60)}"`);
        }
      }

      // ── Persist event to DB (selective for stream_event)
      if (session.sessionId && !session.sessionId.startsWith("pending-")) {
        session.seq++;
        addEvent(
          session.sessionId,
          session.seq,
          m.type,
          m.subtype ?? null,
          JSON.stringify(m),
        );
      }

      // ── Broadcast to all live SSE subscribers
      const eventData = JSON.stringify(m);
      const seqStr = String(session.seq);
      for (const sub of session.subscribers) {
        try {
          await sub.write(m.type, eventData, seqStr);
        } catch {
          // Subscriber disconnected — remove silently
          session.subscribers.delete(sub);
        }
      }
    }
    console.log(`[session-manager] drain loop exited normally for ${session.sessionId}, status=${session.status}`);
  } catch (err: any) {
    console.log(`[session-manager] drain caught for ${session.sessionId}: name=${err?.name}, type=${err?.type}, code=${err?.code}, message=${String(err).slice(0, 200)}`);
    const isAbort = err?.name === "AbortError" || err?.type === "abort"
      || String(err).includes("aborted by user");
    if (isAbort) {
      // ESC/stop: user aborted the current turn. Set idle so session can be
      // resumed later via startSession({ sessionId }). Don't treat as error.
      console.log(`[session-manager] aborted ${session.sessionId}`);
      session.status = "idle";
      if (session.sessionId && !session.sessionId.startsWith("pending-")) {
        updateSessionStatus(session.sessionId, "idle");
        // Persist + broadcast a synthetic "interrupted" event so the UI can show it inline
        const interruptData = JSON.stringify({ type: "system", subtype: "interrupted" });
        session.seq++;
        addEvent(session.sessionId, session.seq, "system", "interrupted", interruptData);
        const seqStr = String(session.seq);
        for (const sub of session.subscribers) {
          try { await sub.write("system", interruptData, seqStr); } catch { session.subscribers.delete(sub); }
        }
      }
    } else {
      session.error = String(err);
      session.status = "error";
      if (session.sessionId && !session.sessionId.startsWith("pending-")) {
        updateSessionStatus(session.sessionId, "error");
      }
      // Broadcast error to subscribers
      const errData = JSON.stringify({ type: "error", error: String(err) });
      for (const sub of session.subscribers) {
        try { await sub.write("error", errData, String(session.seq)); } catch { /* ignore */ }
      }
    }
  }

  // If aborted (idle), check for pending messages from the STOP+SEND race.
  // If messages arrived while the abort was in flight, restart with resume.
  if (session.status === "idle") {
    if (session.pendingMessages.length > 0) {
      console.log(`[session-manager] ${session.pendingMessages.length} pending after abort, restarting ${session.sessionId}`);
      session.abortController = new AbortController();
      const { generator, channel } = createInputChannel();
      session.input = channel;
      const next = session.pendingMessages.shift()!;
      session.initialContent = next;
      session.initialPrompt = contentPreview(next, 200);
      session.preview = contentPreview(next);
      channel.push(next);
      const sdkOpts = { ...session.sdkOptions, resume: session.sessionId, abortController: session.abortController };
      const newQ = sdkQuery({ prompt: generator, options: sdkOpts });
      session.queryObj = newQ;
      session.status = "running";
      session.turnStartedAt = Date.now();
      session.skipNextPromptPersist = true; // queueMessage already persisted it
      // Fire new drain loop — don't remove from activeSessions
      drainEvents(session, newQ).catch((err) => {
        console.error(`[session-manager] restart drain error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
      });
      return;
    }
    // Don't delete and don't send "done" — keep session + SSE alive.
    // The interrupted event already told the frontend to go idle.
    // Next resume will push events through the same SSE connection.
    return;
  }

  // Query finished normally or with error — mark done
  if (session.status !== "error") {
    session.status = "done";
    if (session.sessionId && !session.sessionId.startsWith("pending-")) {
      updateSessionStatus(session.sessionId, "done");
    }
  }

  // Broadcast done
  for (const sub of session.subscribers) {
    try { await sub.write("done", "{}", String(session.seq)); } catch { /* ignore */ }
  }

  // Schedule cleanup
  scheduleCleanup(session.sessionId);
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

  if (session.status === "running" || session.status === "starting") {
    // Agent is mid-turn — hold the message. The drain loop flushes it
    // into the input channel after the current turn's result event.
    session.pendingMessages.push(content);
    console.log(`[session-manager] queued message for ${sessionId} (${session.pendingMessages.length} pending): "${contentPreview(content, 60)}"`);
    return true;
  }

  // Agent is idle (post-abort or waiting) — need a fresh SDK query to resume.
  // The old input channel/generator died when the for-await loop ended.
  session.abortController = new AbortController();
  const { generator, channel } = createInputChannel();
  session.input = channel;
  session.initialPrompt = prompt;
  session.initialContent = content;
  session.preview = contentPreview(content);
  channel.push(content);

  const sdkOpts = {
    ...session.sdkOptions,
    resume: session.sessionId,
    abortController: session.abortController,
  };
  const newQ = sdkQuery({ prompt: generator, options: sdkOpts });
  session.queryObj = newQ;
  session.status = "running";
  session.turnStartedAt = Date.now();
  session.skipNextPromptPersist = true; // already persisted above

  if (!sessionId.startsWith("pending-")) {
    updateSessionStatus(sessionId, "running");
  }

  drainEvents(session, newQ).catch((err) => {
    console.error(`[session-manager] resume drain error for ${session.sessionId}:`, err);
    session.status = "error";
    session.error = String(err);
    updateSessionStatus(session.sessionId, "error");
  });

  return true;
}

export function stopSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  // Only abort — don't close input or set status.
  // The drain loop's AbortError handler sets idle + checks pendingMessages.
  session.abortController.abort();
  return true;
}

export function stopTask(sessionId: string, taskId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session?.queryObj) return false;
  session.queryObj.stopTask(taskId);
  return true;
}

// ── Subscriber Management ──

export function subscribe(sessionId: string, writer: SSEWriter): () => void {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.subscribers.add(writer);
    return () => { session.subscribers.delete(writer); };
  }
  // Session not active — writer will just get catch-up from DB via the endpoint
  return () => {};
}

// ── Cleanup ──

function scheduleCleanup(sessionId: string) {
  setTimeout(() => {
    const session = activeSessions.get(sessionId);
    if (session && (session.status === "done" || session.status === "error") && session.subscribers.size === 0) {
      activeSessions.delete(sessionId);
    }
  }, 5 * 60 * 1000); // 5 minutes
}

/** Shut down all active sessions gracefully */
export function shutdownAll() {
  for (const [id, session] of activeSessions) {
    try {
      session.input.close();
      session.abortController.abort();
    } catch { /* best effort */ }
    activeSessions.delete(id);
  }
}
