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
import { getProfile, getGlobalConfig, getUserData, getUserProfile, type McpServerConfig, type PermissionPolicy } from "./profiles";
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
  /** Timestamp when thinking started (for thinking duration tracking) */
  thinkingStartedAt?: number;
  /** Computed thinking duration in ms (persisted into result event) */
  thinkingDurationMs?: number;
  /** Skip user/prompt persistence on next resume (already persisted by queueMessage) */
  skipNextPromptPersist?: boolean;
  /** Set when this session was spawned by the scheduler */
  scheduleName?: string;
  /** Pending permission requests awaiting UI response */
  pendingPermissions: Map<string, {
    resolve: (result: { behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }) => void;
    toolName: string;
    input: Record<string, unknown>;
    requestedAt: number;
  }>;
  /** Tools approved for the entire session (auto-approve on subsequent calls) */
  sessionApprovals: Set<string>;
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
  userProfile?: string; // user profile name — for memory scoping
  model?: string;
  maxTurns?: number;
  effort?: string;
  cwd?: string;
  tools?: string[];
  disallowedTools?: string[];
  loadProjectSettings?: boolean;
  sessionId?: string; // for resume
  scheduleName?: string; // set when spawned by scheduler
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

  // Inject AGENT_PROFILE + memory scoping env vars into agent-memory MCP server
  if (mergedMcp["agent-memory"]) {
    const am = mergedMcp["agent-memory"] as any;
    const env: Record<string, string> = { ...(am.env ?? {}) };

    // Tag memories with agent profile origin
    if (opts.profile) env.AGENT_PROFILE = opts.profile;

    // Memory scoping: resolve user profile config → set AGENT_MEMORY_DIR + AGENT_MEMORY_READ_DIRS
    if (opts.userProfile) {
      const userProf = getUserProfile(opts.userProfile);
      if (userProf?.memory?.scope === "profile") {
        // Derive base memory dir from --directory arg (the agent_memory package root)
        const dirIdx = (am.args as string[] | undefined)?.indexOf("--directory");
        const agentMemoryRoot = dirIdx !== undefined && dirIdx >= 0 ? (am.args as string[])[dirIdx + 1] : undefined;
        if (agentMemoryRoot) {
          const globalDir = `${agentMemoryRoot}/memory`;
          const profileDir = `${agentMemoryRoot}/memory/profiles/${opts.userProfile}`;
          env.AGENT_MEMORY_DIR = profileDir;
          if (userProf.memory.inheritGlobal !== false) {
            env.AGENT_MEMORY_READ_DIRS = globalDir;
          }
        }
      }
    }

    am.env = env;
  }

  const hasMcp = Object.keys(mergedMcp).length > 0;

  // Convert tools allowlist → disallowedTools blocklist when MCP servers are present.
  // The SDK's `tools` option filters ALL tools including MCP, which hides MCP tools
  // from the init event. Using disallowedTools instead only blocks what's listed,
  // leaving MCP tools visible and available.
  const ALL_BUILTIN = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash",
    "WebSearch", "WebFetch", "Agent", "TodoWrite", "Skill", "NotebookEdit", "AskUserQuestion"];
  const rawTools = opts.tools ?? profileDef?.tools ?? undefined;
  const rawDisallowed = opts.disallowedTools ?? profileDef?.disallowedTools ?? undefined;

  let sdkTools: any = rawTools;
  let sdkDisallowed: string[] | undefined = rawDisallowed;
  if (hasMcp && Array.isArray(rawTools)) {
    // Convert allowlist to blocklist so MCP tools aren't filtered out
    const blocked = ALL_BUILTIN.filter(t => !rawTools.includes(t));
    sdkDisallowed = [...(rawDisallowed ?? []), ...blocked];
    sdkTools = undefined;
  }

  // ── Permission Policy ──
  const policy: PermissionPolicy = profileDef?.permissionPolicy ?? "bypass";
  const isBypass = policy === "bypass";

  // Helper: broadcast + persist an event via SSE (used by permission hooks)
  async function broadcastPermEvent(s: ActiveSession, evt: any) {
    if (s.sessionId && !s.sessionId.startsWith("pending-")) {
      s.seq++;
      addEvent(s.sessionId, s.seq, evt.type, evt.subtype, JSON.stringify(evt));
      const seqStr = String(s.seq);
      for (const sub of s.subscribers) {
        try { await sub.write(evt.type, JSON.stringify(evt), seqStr); } catch { s.subscribers.delete(sub); }
      }
    }
  }

  // ── PreToolUse Hook (ALL profiles) ──
  // Handles regular tool permissions. AskUserQuestion is NOT handled here —
  // it returns {} (no decision) so it falls through the pipeline to canUseTool.
  const preToolUseHook = async (hookInput: any, toolUseID: string | undefined) => {
    const toolName: string = hookInput.tool_name;
    const input: Record<string, unknown> = hookInput.tool_input ?? {};

    // AskUserQuestion → no decision here, fall through to canUseTool
    if (toolName === "AskUserQuestion") {
      return {};
    }

    // Bypass profiles: auto-approve everything (replaces bypassPermissions mode)
    if (isBypass) {
      return {
        continue: true,
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      };
    }

    // Non-bypass: check policy
    let needsApproval = false;
    if (policy === "ask") {
      needsApproval = true;
    } else if (typeof policy === "object") {
      if (policy.requireApproval?.includes(toolName)) {
        needsApproval = true;
      } else if (policy.autoApprove?.includes(toolName)) {
        needsApproval = false;
      } else {
        needsApproval = policy.default === "ask";
      }
    }

    // Session-level approval: skip prompt if already approved for this session
    if (needsApproval && session.sessionApprovals.has(toolName)) {
      needsApproval = false;
    }

    if (!needsApproval) {
      return {
        continue: true,
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      };
    }

    // Create a pending permission request and broadcast it
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await broadcastPermEvent(session, {
      type: "system",
      subtype: "permission_request",
      requestId,
      toolName,
      toolInput: input,
      toolUseID: toolUseID ?? hookInput.tool_use_id,
      interactive: false,
      decisionReason: `${toolName} requires approval`,
    });

    // Wait for UI response
    const result = await new Promise<{ behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }>((resolve) => {
      session.pendingPermissions.set(requestId, { resolve, toolName, input, requestedAt: Date.now() });
    });

    // Broadcast resolution
    await broadcastPermEvent(session, {
      type: "system",
      subtype: "permission_resolved",
      requestId,
      behavior: result.behavior,
    });
    session.pendingPermissions.delete(requestId);

    if (result.behavior === "deny") {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.message ?? "Denied by user",
        },
      };
    }
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
      },
    };
  };

  // ── canUseTool Callback (ALL profiles) ──
  // Handles AskUserQuestion interactively via the UI.
  // This fires AFTER hooks in the permission pipeline, so AskUserQuestion
  // (which the hook skips) arrives here for interactive handling.
  const canUseTool = async (toolName: string, toolInput: Record<string, unknown>) => {
    if (toolName === "AskUserQuestion") {
      const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await broadcastPermEvent(session, {
        type: "system",
        subtype: "permission_request",
        requestId,
        toolName,
        toolInput,
        interactive: true,
        decisionReason: "Clarifying question",
      });

      const result = await new Promise<{ behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }>((resolve) => {
        session.pendingPermissions.set(requestId, { resolve, toolName, input: toolInput, requestedAt: Date.now() });
      });

      await broadcastPermEvent(session, {
        type: "system",
        subtype: "permission_resolved",
        requestId,
        behavior: result.behavior,
      });
      session.pendingPermissions.delete(requestId);

      if (result.behavior === "deny") {
        return { behavior: "deny" as const, message: result.message ?? "Skipped by user" };
      }
      return { behavior: "allow" as const, updatedInput: result.updatedInput ?? toolInput };
    }

    // Safety net: any other tool that reaches here — auto-approve
    return { behavior: "allow" as const, updatedInput: toolInput };
  };

  const sdkOptions: any = {
    pathToClaudeCodeExecutable: CLAUDE_PATH,
    cwd: opts.cwd ?? process.env.AGENT_CWD ?? process.cwd(),
    includePartialMessages: true,
    resume: opts.sessionId ?? undefined,
    model: opts.model ?? profileDef?.model ?? undefined,
    effort: opts.effort ?? profileDef?.effort ?? undefined,
    maxTurns: opts.maxTurns ?? profileDef?.maxTurns ?? undefined,
    allowedTools: undefined,
    disallowedTools: sdkDisallowed,
    tools: sdkTools,
    systemPrompt,
    settingSources: (opts.loadProjectSettings ?? profileDef?.loadProjectSettings ?? true) ? ["project"] : [],
    permissionMode: "default" as const,
    canUseTool,
    hooks: {
      PreToolUse: [{
        hooks: [preToolUseHook],
        timeout: 300, // 5 min timeout for user to respond
      }],
    },
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
    scheduleName: opts.scheduleName,
    pendingPermissions: new Map(),
    sessionApprovals: new Set(),
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

      // ── Track thinking duration (first thinking_delta → first non-thinking event)
      if (m.type === "stream_event" && m.event?.type === "content_block_delta") {
        const delta = m.event.delta;
        if (delta?.type === "thinking_delta" && !session.thinkingStartedAt) {
          session.thinkingStartedAt = Date.now();
        } else if (delta?.type === "text_delta" && session.thinkingStartedAt) {
          session.thinkingDurationMs = Date.now() - session.thinkingStartedAt;
          session.thinkingStartedAt = undefined;
        }
      }
      // Also finalize on assistant message (tool_use arrives without text_delta)
      if (m.type === "assistant" && session.thinkingStartedAt) {
        session.thinkingDurationMs = Date.now() - session.thinkingStartedAt;
        session.thinkingStartedAt = undefined;
      }

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
            cwd: session.sdkOptions.cwd,
            scheduleName: session.scheduleName,
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
        // Thinking duration (if thinking occurred this turn)
        if (session.thinkingDurationMs) {
          m.thinking_duration_ms = session.thinkingDurationMs;
        }
        session.thinkingStartedAt = undefined;
        session.thinkingDurationMs = undefined;

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

/** Update mutable SDK options on an active session.
 * Changes take effect on next resume (next turn).
 */
export function updateSessionConfig(
  sessionId: string,
  config: { disallowedTools?: string[]; tools?: string[] },
): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  if (config.disallowedTools !== undefined) {
    session.sdkOptions.disallowedTools = config.disallowedTools.length > 0
      ? config.disallowedTools : undefined;
  }
  if (config.tools !== undefined) {
    session.sdkOptions.tools = config.tools.length > 0 ? config.tools : undefined;
  }
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
  // Track session-level approvals
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
