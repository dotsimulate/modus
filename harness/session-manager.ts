/**
 * Session Manager — decouples agent lifecycle from HTTP connections.
 *
 * Each active session holds a Query object (SDK subprocess) in memory.
 * Clients subscribe/unsubscribe via SSE without affecting the agent.
 * Events are persisted to DB as they arrive, enabling catch-up on reconnect.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
  upsertSession, updateSessionStatus, addMessage, addEvent,
} from "./db";
import { getProfile } from "./profiles";
import type { Profile } from "./profiles";

const CLAUDE_PATH =
  process.env.CLAUDE_PATH || `${process.env.HOME}/.local/bin/claude`;

// ── Types ──

export type SessionStatus = "starting" | "running" | "idle" | "done" | "error";

export type SSEWriter = {
  write(event: string, data: string, id: string): Promise<void>;
  close(): void;
};

type InputChannel = {
  push(content: string): void;
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
  subscribers: Set<SSEWriter>;
  input: InputChannel;
  queryObj: ReturnType<typeof sdkQuery> | null;
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
      push(content: string) {
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

// ── Event Classification ──

function getSubtype(msg: any): string | null {
  return msg.subtype ?? null;
}

/** Should we persist this event? Skip high-volume streaming deltas. */
function shouldPersist(msg: any): boolean {
  if (msg.type !== "stream_event") return true;
  const evt = msg.event;
  if (!evt) return false;
  // Keep structural events, skip raw text/thinking deltas
  const keep = ["message_start", "message_stop", "message_delta", "content_block_start", "content_block_stop"];
  if (keep.includes(evt.type)) return true;
  // Keep tool input deltas (input_json_delta)
  if (evt.type === "content_block_delta" && evt.delta?.type === "input_json_delta") return true;
  // Skip text_delta and thinking_delta (high volume, reconstructed from assistant message)
  return false;
}

// ── Start Session ──

export type StartSessionOpts = {
  prompt: string;
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

  // Build system prompt
  let systemPrompt: string | { type: "preset"; preset: "claude_code"; append?: string } | undefined;
  const rawPrompt = profileDef?.prompt;
  if (rawPrompt) {
    if (profileDef?.promptMode === "custom") {
      systemPrompt = rawPrompt;
    } else {
      systemPrompt = { type: "preset", preset: "claude_code", append: rawPrompt };
    }
  }

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
  };

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
    preview: opts.prompt.slice(0, 80),
    subscribers: new Set(),
    input: channel,
    queryObj: null,
  };

  activeSessions.set(tempId, session);

  // Push the initial prompt into the input channel
  channel.push(opts.prompt);

  // Start the SDK query with streaming input
  const q = sdkQuery({ prompt: generator, options: sdkOptions });
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
  let thinkingText = "";
  let initSeen = false;

  try {
    for await (const msg of q) {
      const m = msg as any;
      session.lastEventAt = Date.now();

      // ── Handle system init: capture session ID (first time only)
      if (m.type === "system" && m.subtype === "init" && m.session_id && !initSeen) {
        initSeen = true;
        const realId = m.session_id;
        // Re-key in the map
        activeSessions.delete(session.tempId);
        session.sessionId = realId;
        activeSessions.set(realId, session);
        session.model = m.model ?? session.model;
        session.status = "running";

        // Create DB session row + save first user message
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
        addMessage({ sessionId: realId, role: "user", content: session.preview });
      }

      // ── Capture thinking from assistant messages
      if (m.type === "assistant" && m.message?.content) {
        session.status = "running";
        for (const block of m.message.content) {
          if (block.type === "thinking" && block.thinking) {
            thinkingText = block.thinking;
          }
        }
      }

      // ── Handle result: save assistant message, update session
      if (m.type === "result") {
        const resultText = m.result ?? "";
        session.costUsd += m.total_cost_usd ?? 0;
        session.numTurns += m.num_turns ?? 0;

        if (session.sessionId && !session.sessionId.startsWith("pending-")) {
          addMessage({
            sessionId: session.sessionId,
            role: "assistant",
            content: resultText,
            thinking: thinkingText || undefined,
            costUsd: m.total_cost_usd,
            durationMs: m.duration_ms,
            model: session.model ?? undefined,
            turns: m.num_turns,
          });
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

        thinkingText = "";

        // After result, the agent is idle (waiting for next input) or done
        // If the input channel is closed, the query will end naturally
        session.status = "idle";
      }

      // ── Persist event to DB (selective for stream_event)
      if (shouldPersist(m) && session.sessionId && !session.sessionId.startsWith("pending-")) {
        session.seq++;
        addEvent(
          session.sessionId,
          session.seq,
          m.type,
          getSubtype(m),
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
  } catch (err) {
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

  // Query finished — mark done
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

export function queueMessage(sessionId: string, prompt: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.preview = prompt.slice(0, 80); // update preview to latest prompt

  // Save user message to DB
  if (!sessionId.startsWith("pending-")) {
    addMessage({ sessionId, role: "user", content: prompt });
  }

  session.input.push(prompt);
  session.status = "running";
  if (!sessionId.startsWith("pending-")) {
    updateSessionStatus(sessionId, "running");
  }
  return true;
}

export function interruptSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session?.queryObj) return false;
  (session.queryObj as any).interrupt?.();
  return true;
}

export function stopSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session?.queryObj) return false;
  session.input.close();
  (session.queryObj as any).close?.();
  session.status = "done";
  if (!sessionId.startsWith("pending-")) {
    updateSessionStatus(sessionId, "done");
  }
  return true;
}

export function stopTask(sessionId: string, taskId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session?.queryObj) return false;
  (session.queryObj as any).stopTask?.(taskId);
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
      (session.queryObj as any)?.close?.();
    } catch { /* best effort */ }
    activeSessions.delete(id);
  }
}
