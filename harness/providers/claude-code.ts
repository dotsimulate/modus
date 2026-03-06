/**
 * Claude Code Provider — Claude Agent SDK execution backend.
 *
 * Handles: SDK subprocess management, streaming input channels, permission hooks,
 * MCP server resolution, thinking tracking, multi-turn drain loop.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SessionProvider, TurnContext } from "./types";
import type { ActiveSession, MessageContent } from "../session-manager";
import { getGlobalConfig, getUserData, getUserProfile, type McpServerConfig, type PermissionPolicy } from "../profiles";
import { getMaxSeq, getSession, updateSessionStatus } from "../db";
import { dirname, join, parse as parsePath } from "path";
import { resolveSecret } from "../secrets";
import type { ClaudeMdExcludes } from "../profiles";

// On Windows, Bun's subprocess needs the .cmd wrapper to resolve correctly via PATH.
const CLAUDE_PATH = process.env.CLAUDE_PATH
  || (process.platform === "win32" ? "claude.cmd" : "claude");

const ALL_BUILTIN = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash",
  "WebSearch", "WebFetch", "Agent", "TodoWrite", "Skill", "NotebookEdit", "AskUserQuestion"];

// ── Provider-specific state stored on session._providerState ──

type ClaudeCodeState = {
  queryObj: ReturnType<typeof sdkQuery> | null;
  sdkOptions: any;
  input: InputChannel;
  skipNextPromptPersist?: boolean;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  stderrBuf: string;
};

type InputChannel = {
  push(content: MessageContent): void;
  close(): void;
};

function getState(session: ActiveSession): ClaudeCodeState {
  return session._providerState as ClaudeCodeState;
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
        if (msg === null) return;
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

// ── MCP Env Var Resolution ──

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

// ── CLAUDE.md Exclude Resolution ──

function resolveClaudeMdExcludes(
  config: ClaudeMdExcludes | undefined,
  cwd: string,
): string[] | undefined {
  if (!config) return undefined;
  if (Array.isArray(config)) return config.length > 0 ? config : undefined;

  const patterns: string[] = [...(config.custom ?? [])];
  for (const rule of config.rules ?? []) {
    switch (rule) {
      case "no-parent-walk": {
        const normalized = cwd.replace(/\\/g, "/");
        let dir = dirname(normalized);
        const { root } = parsePath(normalized);
        const rootNorm = root.replace(/\\/g, "/");
        while (dir !== rootNorm && dir !== dirname(dir)) {
          patterns.push(join(dir, "CLAUDE.md"));
          patterns.push(join(dir, ".claude", "CLAUDE.md"));
          dir = dirname(dir);
        }
        break;
      }
      case "no-node-modules":
        patterns.push("**/node_modules/**/CLAUDE.md");
        break;
    }
  }
  return patterns.length > 0 ? patterns : undefined;
}

// ── Provider Implementation ──

export function createClaudeCodeProvider(): SessionProvider {
  return {
    startTurn(ctx: TurnContext) {
      const { session, opts, profile: profileDef } = ctx;
      const { generator, channel } = createInputChannel();

      // Build system prompt — resolve {{key}} template vars
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

      // Merge MCP servers: global + profile
      const globalConfig = getGlobalConfig();
      const mergedMcp = {
        ...(globalConfig.mcpServers ?? {}),
        ...(profileDef?.mcpServers ?? {}),
      };

      // Inject AGENT_PROFILE + memory scoping env vars into agent-memory MCP server
      if (mergedMcp["agent-memory"]) {
        const am = mergedMcp["agent-memory"] as any;
        const env: Record<string, string> = { ...(am.env ?? {}) };
        if (opts.profile) env.AGENT_PROFILE = opts.profile;
        if (opts.userProfile) {
          const userProf = getUserProfile(opts.userProfile);
          if (userProf?.memory?.scope === "profile") {
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

      // Convert tools allowlist → disallowedTools blocklist when MCP servers are present
      const rawTools = opts.tools ?? profileDef?.tools ?? undefined;
      const rawDisallowed = opts.disallowedTools ?? profileDef?.disallowedTools ?? undefined;
      let sdkTools: any = rawTools;
      let sdkDisallowed: string[] | undefined = rawDisallowed;
      if (hasMcp && Array.isArray(rawTools)) {
        const blocked = ALL_BUILTIN.filter(t => !rawTools.includes(t));
        sdkDisallowed = [...(rawDisallowed ?? []), ...blocked];
        sdkTools = undefined;
      }

      // ── Permission Policy ──
      const policy: PermissionPolicy = profileDef?.permissionPolicy ?? "bypass";
      const isBypass = policy === "bypass";

      const preToolUseHook = async (hookInput: any, toolUseID: string | undefined) => {
        const toolName: string = hookInput.tool_name;
        const input: Record<string, unknown> = hookInput.tool_input ?? {};

        if (toolName === "AskUserQuestion") return {};
        if (isBypass) {
          return {
            continue: true,
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
          };
        }

        let needsApproval = false;
        if (policy === "ask") {
          needsApproval = true;
        } else if (typeof policy === "object") {
          if (policy.requireApproval?.includes(toolName)) needsApproval = true;
          else if (policy.autoApprove?.includes(toolName)) needsApproval = false;
          else needsApproval = policy.default === "ask";
        }

        if (needsApproval && session.sessionApprovals.has(toolName)) {
          needsApproval = false;
        }

        if (!needsApproval) {
          return {
            continue: true,
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
          };
        }

        const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        ctx.emitEvent({
          type: "system",
          subtype: "permission_request",
          requestId,
          toolName,
          toolInput: input,
          toolUseID: toolUseID ?? hookInput.tool_use_id,
          interactive: false,
          decisionReason: `${toolName} requires approval`,
        });

        const result = await new Promise<{ behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }>((resolve) => {
          session.pendingPermissions.set(requestId, { resolve, toolName, input, requestedAt: Date.now() });
        });

        ctx.emitEvent({
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

      const canUseTool = async (toolName: string, toolInput: Record<string, unknown>) => {
        if (toolName === "AskUserQuestion") {
          const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          ctx.emitEvent({
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

          ctx.emitEvent({
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
        return { behavior: "allow" as const, updatedInput: toolInput };
      };

      let stderrBuf = "";

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
        claudeMdExcludes: resolveClaudeMdExcludes(
          profileDef?.claudeMdExcludes,
          opts.cwd ?? process.env.AGENT_CWD ?? process.cwd(),
        ),
        permissionMode: "default" as const,
        canUseTool,
        hooks: {
          PreToolUse: [{
            hooks: [preToolUseHook],
            timeout: 300,
          }],
        },
        mcpServers: hasMcp ? resolveEnvVars(mergedMcp) : undefined,
        stderr: (data: string) => {
          const line = data.trim().slice(0, 2000);
          console.error(`[claude-code] stderr (${session.tempId}):`, line);
          stderrBuf += (stderrBuf ? "\n" : "") + line;
        },
      };

      const abortController = session.abortController;

      // Store provider state
      const state: ClaudeCodeState = {
        queryObj: null,
        sdkOptions,
        input: channel,
        stderrBuf: "",
      };
      session._providerState = state;

      // Push initial content into the input channel
      channel.push(session.initialContent);

      // Start the SDK query
      const q = sdkQuery({ prompt: generator, options: { ...sdkOptions, abortController } });
      state.queryObj = q;

      // Background drain loop
      drainEvents(ctx, state, q).catch((err) => {
        console.error(`[claude-code] drain error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
      });

      // Startup timeout
      setTimeout(() => {
        if (session.status === "starting") {
          const reason = stderrBuf
            ? `Session failed to start.\n\nstderr:\n${stderrBuf}`
            : "Session failed to start — no response from Claude Code within 30s.";
          console.error(`[claude-code] startup timeout for ${session.sessionId}: ${reason}`);
          session.status = "error";
          session.error = reason;
          abortController.abort();
          const errData = JSON.stringify({ type: "error", error: reason });
          for (const sub of session.subscribers) {
            try { sub.write("error", errData, String(session.seq)); } catch { /* ignore */ }
          }
        }
      }, 30_000);
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);

      if (session.status === "running" || session.status === "starting") {
        session.pendingMessages.push(content);
        return;
      }

      // Idle — resume with fresh SDK query
      session.abortController = new AbortController();
      const { generator, channel } = createInputChannel();
      state.input = channel;
      session.preview = typeof content === "string" ? content.slice(0, 80) : "[content]";
      channel.push(content);

      const sdkOpts = {
        ...state.sdkOptions,
        resume: session.sessionId,
        abortController: session.abortController,
      };
      const newQ = sdkQuery({ prompt: generator, options: sdkOpts });
      state.queryObj = newQ;
      session.status = "running";
      session.turnStartedAt = Date.now();
      state.skipNextPromptPersist = true;

      updateSessionStatus(session.sessionId, "running");

      drainEvents(ctx, state, newQ).catch((err) => {
        console.error(`[claude-code] resume drain error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
      });
    },

    abort(session: ActiveSession) {
      const state = getState(session);
      state.input.close();
      session.abortController.abort();
    },

    stopTask(session: ActiveSession, taskId: string): boolean {
      const state = getState(session);
      if (!state.queryObj) return false;
      state.queryObj.stopTask(taskId);
      return true;
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      const hasMcp = !!state.sdkOptions.mcpServers;

      if (config.tools !== undefined && config.tools.length > 0 && hasMcp) {
        const blocked = ALL_BUILTIN.filter((t: string) => !config.tools.includes(t));
        state.sdkOptions.disallowedTools = blocked.length > 0 ? blocked : undefined;
        state.sdkOptions.tools = undefined;
      } else {
        if (config.disallowedTools !== undefined) {
          state.sdkOptions.disallowedTools = config.disallowedTools.length > 0
            ? config.disallowedTools : undefined;
        }
        if (config.tools !== undefined) {
          state.sdkOptions.tools = config.tools.length > 0 ? config.tools : undefined;
        }
      }

      if (session.status === "running" || session.status === "starting") {
        session.abortController.abort();
      }
    },
  };
}

// ── Event Drain Loop ──

async function drainEvents(ctx: TurnContext, state: ClaudeCodeState, q: AsyncIterable<any>) {
  const { session } = ctx;
  let initSeen = false;

  try {
    for await (const msg of q) {
      if (session.abortController.signal.aborted) break;

      const m = msg as any;
      session.lastEventAt = Date.now();

      // Track thinking duration
      if (m.type === "stream_event" && m.event?.type === "content_block_delta") {
        const delta = m.event.delta;
        if (delta?.type === "thinking_delta" && !state.thinkingStartedAt) {
          state.thinkingStartedAt = Date.now();
        } else if (delta?.type === "text_delta") {
          if (state.thinkingStartedAt) {
            state.thinkingDurationMs = Date.now() - state.thinkingStartedAt;
            state.thinkingStartedAt = undefined;
          }
          session.lastAssistantText = (session.lastAssistantText + (delta.text ?? "")).slice(-200);
        }
      }
      if (m.type === "assistant" && state.thinkingStartedAt) {
        state.thinkingDurationMs = Date.now() - state.thinkingStartedAt;
        state.thinkingStartedAt = undefined;
      }

      // Handle system init: capture session ID
      if (m.type === "system" && m.subtype === "init" && m.session_id && !initSeen) {
        initSeen = true;
        const realId = m.session_id;
        const isResume = session.tempId === realId && !!getSession(realId);

        ctx.rekeySession(realId);
        session.model = m.model ?? session.model;
        session.status = "running";

        if (isResume) {
          session.seq = getMaxSeq(realId);
          updateSessionStatus(realId, "running");
          if (state.skipNextPromptPersist) {
            state.skipNextPromptPersist = false;
          } else {
            ctx.emitEvent({
              type: "user",
              subtype: "prompt",
              message: { role: "user", content: session.initialContent },
            });
          }
        } else {
          ctx.updateSessionDb({
            status: "running",
            messageCount: 0,
            costUsd: 0,
            lastPrompt: session.preview,
          });
          ctx.emitEvent({
            type: "user",
            subtype: "prompt",
            message: { role: "user", content: session.initialContent },
          });
        }
      }

      // Track running status
      if (m.type === "assistant" && m.message?.content) {
        session.status = "running";
      }

      // Handle result: inject harness timing + token count
      if (m.type === "result") {
        m.harness_duration_ms = Date.now() - session.turnStartedAt;
        if (state.thinkingDurationMs) {
          m.thinking_duration_ms = state.thinkingDurationMs;
        }
        state.thinkingStartedAt = undefined;
        state.thinkingDurationMs = undefined;

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

        session.costUsd += m.total_cost_usd ?? 0;
        session.numTurns += m.num_turns ?? 0;

        ctx.updateSessionDb({
          status: m.subtype === "success" ? "idle" : "error",
          messageCount: session.numTurns * 2,
          costUsd: m.total_cost_usd ?? 0,
          lastPrompt: session.preview,
          lastResponse: (m.result ?? "").slice(0, 200),
        });

        session.status = "idle";

        // Flush queued messages
        if (session.pendingMessages.length > 0) {
          const next = session.pendingMessages.shift()!;
          state.input.push(next);
          session.status = "running";
          session.turnStartedAt = Date.now();
          session.preview = typeof next === "string" ? next.slice(0, 80) : "[content]";
        }
      }

      // Persist + broadcast event
      ctx.emitEvent(m);
    }
    console.log(`[claude-code] drain loop exited normally for ${session.sessionId}, status=${session.status}`);
  } catch (err: any) {
    console.error(`[claude-code] drain caught for ${session.sessionId}:`, err);
    const isAbort = err?.name === "AbortError" || err?.type === "abort"
      || String(err).includes("aborted by user");
    if (isAbort) {
      console.log(`[claude-code] aborted ${session.sessionId}`);
      session.status = "idle";
      updateSessionStatus(session.sessionId, "idle");
      ctx.emitEvent({ type: "system", subtype: "interrupted" });
    } else {
      session.error = String(err);
      session.status = "error";
      updateSessionStatus(session.sessionId, "error");
      ctx.broadcastEvent({ type: "error", error: String(err) });
    }
  }

  // Post-drain: handle pending messages after abort
  if (session.status === "idle") {
    if (session.pendingMessages.length > 0) {
      console.log(`[claude-code] ${session.pendingMessages.length} pending after abort, restarting ${session.sessionId}`);
      session.abortController = new AbortController();
      const { generator, channel } = createInputChannel();
      state.input = channel;
      const next = session.pendingMessages.shift()!;
      session.initialContent = next;
      session.preview = typeof next === "string" ? next.slice(0, 80) : "[content]";
      channel.push(next);
      const sdkOpts = { ...state.sdkOptions, resume: session.sessionId, abortController: session.abortController };
      const newQ = sdkQuery({ prompt: generator, options: sdkOpts });
      state.queryObj = newQ;
      session.status = "running";
      session.turnStartedAt = Date.now();
      state.skipNextPromptPersist = true;
      drainEvents(ctx, state, newQ).catch((err) => {
        console.error(`[claude-code] restart drain error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
      });
      return;
    }
    return;
  }

  // Query finished normally or with error
  if (session.status !== "error") {
    session.status = "done";
    updateSessionStatus(session.sessionId, "done");
  }

  ctx.broadcastEvent({ type: "done" });
}
