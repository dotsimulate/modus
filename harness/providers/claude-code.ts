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
import { logActivity } from "../activity";
import { dirname, isAbsolute, join, parse as parsePath } from "path";
import { existsSync } from "fs";
import { resolveSecret } from "../secrets";
import type { ClaudeMdExcludes } from "../profiles";
import type { ProviderCapabilities } from "./types";

// On Windows, Bun's subprocess needs the .cmd wrapper to resolve correctly via PATH.
const CLAUDE_PATH = process.env.CLAUDE_PATH
  || (process.platform === "win32" ? "claude.cmd" : "claude");

const ALL_BUILTIN = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash",
  "WebSearch", "WebFetch", "Agent", "TodoWrite", "Skill", "NotebookEdit", "AskUserQuestion"];

const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  name: "claude-code",
  label: "Claude Code",
  family: "claude-code",
  builtInTools: ALL_BUILTIN,
  builtInToolGroups: [
    { label: "files", tools: ["Read", "Write", "Edit", "MultiEdit"] },
    { label: "search", tools: ["Glob", "Grep"] },
    { label: "exec", tools: ["Bash"] },
    { label: "web", tools: ["WebSearch", "WebFetch"] },
    { label: "agent", tools: ["Agent", "TodoWrite", "Skill"] },
    { label: "other", tools: ["NotebookEdit", "AskUserQuestion"] },
  ],
  builtInToolMode: "explicit",
  supportsMcp: true,
  mcpSupport: "full",
  nonToolSignals: ["thinking", "streaming"],
  permissionModel: {
    mode: "per-tool-ui",
    interactive: true,
    summary: "Per-tool approval requests are surfaced to the UI and can be allowed or denied live.",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};

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

function getState(session: ActiveSession): ClaudeCodeState | null {
  return (session._providerState as ClaudeCodeState | null) ?? null;
}

function normalizeClaudeEffort(effort?: string): string | undefined {
  if (!effort || effort === "off") return undefined;
  return effort;
}

const VALID_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "dontAsk"]);

function readClaudePermissionMode(providerControls: unknown): "default" | "acceptEdits" | "plan" | "dontAsk" {
  if (!providerControls || typeof providerControls !== "object") return "default";
  const claude = (providerControls as Record<string, unknown>).claude;
  if (!claude || typeof claude !== "object") return "default";
  const mode = (claude as Record<string, unknown>).permissionMode;
  if (typeof mode === "string" && VALID_PERMISSION_MODES.has(mode)) {
    return mode as "default" | "acceptEdits" | "plan" | "dontAsk";
  }
  return "default";
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

// ── Project CWD MCP Discovery ──

/**
 * Read MCP server configs from a project's .claude/mcp.json (same file
 * Claude Code CLI discovers when launched from that directory).
 */
function readProjectMcpServers(cwd: string | undefined): Record<string, McpServerConfig> {
  if (!cwd) return {};
  const mcpJsonPath = join(cwd, ".claude", "mcp.json");
  try {
    if (!existsSync(mcpJsonPath)) return {};
    const raw = JSON.parse(require("fs").readFileSync(mcpJsonPath, "utf-8"));
    const servers = raw?.mcpServers ?? {};
    if (typeof servers !== "object" || Array.isArray(servers)) return {};
    console.log(`[claude-code] Discovered project MCP servers at ${mcpJsonPath}: ${Object.keys(servers).join(", ")}`);
    return servers as Record<string, McpServerConfig>;
  } catch (err) {
    console.warn(`[claude-code] Failed to read ${mcpJsonPath}:`, err);
    return {};
  }
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
    capabilities: CLAUDE_CAPABILITIES,
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

      // Merge MCP servers: project CWD .claude/mcp.json + global + profile
      // Priority: profile > global > project CWD (project CWD is lowest, gets overridden)
      const globalConfig = getGlobalConfig(session.cwd);
      const sessionCwdMcp = readProjectMcpServers(opts.cwd ?? session.cwd);
      console.log(`[claude-code] MCP merge: cwd=${session.cwd} projectMcp=${JSON.stringify(Object.keys(sessionCwdMcp))} globalMcp=${JSON.stringify(Object.keys(globalConfig.mcpServers ?? {}))} profileMcp=${JSON.stringify(Object.keys(profileDef?.mcpServers ?? {}))}`);
      const mergedMcp = {
        ...sessionCwdMcp,
        ...(globalConfig.mcpServers ?? {}),
        ...(profileDef?.mcpServers ?? {}),
      };

      // Resolve relative --directory args to absolute
      // Project CWD servers: resolve relative to session CWD
      // Harness servers (global/profile): resolve relative to harness root
      const harnessRoot = dirname(import.meta.dir.endsWith("/") ? import.meta.dir.slice(0, -1) : import.meta.dir);
      const projectCwdNames = new Set(Object.keys(sessionCwdMcp));
      for (const [name, server] of Object.entries(mergedMcp) as [string, any][]) {
        const args = server.args as string[] | undefined;
        if (!args) continue;
        const dirIdx = args.indexOf("--directory");
        const dirVal = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
        if (dirVal && !isAbsolute(dirVal)) {
          const anchor = projectCwdNames.has(name) ? (opts.cwd ?? session.cwd) : harnessRoot;
          args[dirIdx + 1] = join(anchor, dirVal);
        }
      }

      // Inject AGENT_PROFILE + memory scoping env vars into agent-memory MCP server
      if (mergedMcp["agent-memory"]) {
        const am = mergedMcp["agent-memory"] as any;
        const env: Record<string, string> = { ...(am.env ?? {}) };
        if (opts.profile) env.AGENT_PROFILE = opts.profile;
        if (opts.userProfile) env.USER_PROFILE = opts.userProfile;

        // Project-local memory: use <cwd>/.modus/memory/ when it exists
        const sessionCwd = opts.cwd ?? process.env.AGENT_CWD;
        if (sessionCwd) {
          const projectMemoryDir = join(sessionCwd, ".modus", "memory");
          if (existsSync(projectMemoryDir)) {
            env.AGENT_MEMORY_DIR = projectMemoryDir;
            // Also allow reading from global memory as fallback
            const dirIdx = (am.args as string[] | undefined)?.indexOf("--directory");
            const agentMemoryRoot = dirIdx !== undefined && dirIdx >= 0 ? (am.args as string[])[dirIdx + 1] : undefined;
            if (agentMemoryRoot) {
              env.AGENT_MEMORY_READ_DIRS = `${agentMemoryRoot}/memory`;
            }
          }
        }

        if (opts.userProfile) {
          const userProf = getUserProfile(opts.userProfile);
          // Skills scoping: derive from user profile's project paths
          if (userProf?.projects?.length) {
            env.AGENT_MEMORY_SKILLS_DIRS = userProf.projects
              .map(p => join(p, ".claude", "skills"))
              .join(",");
          } else {
            env.AGENT_MEMORY_SKILLS_DIRS = "";
          }
          // Profile-level memory scoping (overrides project-local if both set)
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
          logActivity({
            userProfile: session.userProfile,
            eventType: "tool_denied",
            sessionId: session.sessionId,
            agentProfile: session.profile,
            summary: `Tool denied: ${toolName}`,
            metadata: { toolName, reason: result.message },
          });
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
        // ── Pause gate ──
        if (session.pauseRequested) {
          session.pauseRequested = false;
          session.status = "paused";
          updateSessionStatus(session.sessionId, "paused");
          ctx.emitEvent({
            type: "system",
            subtype: "paused",
            data: { toolName, input: toolInput },
          });
          await new Promise<void>((resolve) => {
            session.pauseResolver = resolve;
          });
          session.pauseResolver = null;
          session.status = "running";
          updateSessionStatus(session.sessionId, "running");
        }

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

      // Branch fork: resume from parent session, fork to new ID
      const isBranch = !!opts.branchParentId;
      const resumeTarget = isBranch ? opts.branchParentId : (opts.sessionId ?? undefined);
      console.log(`[claude-code] startTurn isBranch=${isBranch} resume=${resumeTarget} sessionId=${opts.sessionId} branchParent=${opts.branchParentId} branchMsgUUID=${opts.branchMessageUUID}`);

      // Fork options are one-shot — only used for the initial query(), never stored
      const forkOpts = isBranch ? {
        forkSession: true,
        sessionId: opts.sessionId,
        resumeSessionAt: opts.branchMessageUUID ?? undefined,
      } : {};

      const sdkOptions: any = {
        pathToClaudeCodeExecutable: CLAUDE_PATH,
        cwd: session.cwd ?? opts.cwd ?? process.env.AGENT_CWD ?? process.cwd(),
        additionalDirectories: session.additionalDirectories.length > 0 ? session.additionalDirectories : undefined,
        includePartialMessages: true,
        resume: resumeTarget,
        model: opts.model ?? profileDef?.model ?? undefined,
        effort: normalizeClaudeEffort(opts.effort ?? profileDef?.effort),
        maxTurns: opts.maxTurns ?? profileDef?.maxTurns ?? undefined,
        allowedTools: undefined,
        disallowedTools: sdkDisallowed,
        tools: sdkTools,
        systemPrompt,
        skills: profileDef?.skills,
        settingSources: (opts.loadProjectSettings ?? profileDef?.loadProjectSettings ?? true) ? ["project"] : [],
        claudeMdExcludes: resolveClaudeMdExcludes(
          profileDef?.claudeMdExcludes,
          opts.cwd ?? process.env.AGENT_CWD ?? process.cwd(),
        ),
        permissionMode: readClaudePermissionMode(opts.providerControls),
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
      const q = sdkQuery({ prompt: generator, options: { ...sdkOptions, ...forkOpts, abortController } });
      state.queryObj = q;

      // Background drain loop
      drainEvents(ctx, state, q).catch((err) => {
        console.error(`[claude-code] drain error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        ctx.updateSessionDb({
          status: "error",
          costUsd: session.costUsd,
          lastResponse: session.lastAssistantText?.slice(0, 2000),
        });
      });

      // Startup timeout — only fires if this specific turn is still starting.
      // Guard against false positives: if the abortController has changed (sendMessage
      // created a new turn), this timeout belongs to an already-completed turn.
      setTimeout(() => {
        if (session.status === "starting" && session.abortController === abortController) {
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
      if (!state) {
        throw new Error("claude-code provider state missing during sendMessage");
      }

      if (session.status === "running" || session.status === "starting") {
        session.pendingMessages.push(content);
        return;
      }

      // Idle — resume with fresh SDK query
      session.abortController = new AbortController();
      const { generator, channel } = createInputChannel();
      state.input = channel;
      session.initialContent = content;
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
        ctx.updateSessionDb({
          status: "error",
          costUsd: session.costUsd,
          lastResponse: session.lastAssistantText?.slice(0, 2000),
        });
      });
    },

    steerMessage(ctx: TurnContext, content: MessageContent): boolean {
      const { session } = ctx;
      const state = getState(session);
      if (!state) return false;

      if (session.status === "running" || session.status === "starting") {
        // Inject directly into the live input channel — delivered at next tool boundary
        state.input.push(content);
        return true;
      }

      // Not running — fall back to queue (caller will start a new turn)
      return false;
    },

    abort(session: ActiveSession) {
      const state = getState(session);
      try { state?.input.close(); } catch { /* ignore cleanup errors */ }
      try { session.abortController.abort(); } catch { /* AbortError from inflight operations */ }
    },

    stopTask(session: ActiveSession, taskId: string): boolean {
      const state = getState(session);
      if (!state?.queryObj) return false;
      state.queryObj.stopTask(taskId);
      return true;
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      if (!state) return;
      const hasMcp = !!state.sdkOptions.mcpServers;

      if (config.model !== undefined) {
        state.sdkOptions.model = config.model || undefined;
      }
      if (config.effort !== undefined) {
        state.sdkOptions.effort = normalizeClaudeEffort(config.effort);
      }
      if (config.maxTurns !== undefined) {
        state.sdkOptions.maxTurns = config.maxTurns || undefined;
      }
      if (config.systemPrompt !== undefined) {
        state.sdkOptions.systemPrompt = config.systemPrompt || undefined;
      }
      state.sdkOptions.cwd = session.cwd;
      state.sdkOptions.additionalDirectories = session.additionalDirectories.length > 0
        ? session.additionalDirectories
        : undefined;
      if (config.providerControls !== undefined) {
        state.sdkOptions.permissionMode = readClaudePermissionMode(config.providerControls);
      }

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
        try { session.abortController.abort(); } catch { /* AbortError from inflight operations */ }
      }
    },

    async dispose(session: ActiveSession) {
      const state = getState(session);
      if (!state) return;
      try { state.input.close(); } catch { /* ignore cleanup errors */ }
      try { session.abortController.abort(); } catch { /* AbortError from inflight operations */ }
      session._providerState = null;
    },

    switchProfile(session: ActiveSession, ctx: TurnContext, contextMode: string) {
      const state = getState(session);
      if (!state) return;
      const profileDef = ctx.profile;

      // Build new system prompt
      let systemPrompt: string | { type: "preset"; preset: "claude_code"; append?: string } | undefined;
      if (profileDef?.prompt) {
        if (profileDef.promptMode === "custom") {
          systemPrompt = profileDef.prompt;
        } else {
          systemPrompt = { type: "preset", preset: "claude_code", append: profileDef.prompt };
        }
      }

      // Update SDK options for next resume
      state.sdkOptions.systemPrompt = systemPrompt;
      state.sdkOptions.model = ctx.opts.model || undefined;
      state.sdkOptions.effort = normalizeClaudeEffort(ctx.opts.effort);
      state.sdkOptions.maxTurns = ctx.opts.maxTurns || undefined;
      state.sdkOptions.cwd = session.cwd;
      state.sdkOptions.additionalDirectories = ctx.opts.additionalDirectories?.length
        ? ctx.opts.additionalDirectories
        : undefined;

      // Update tools
      const hasMcp = !!state.sdkOptions.mcpServers;
      const providerLockedToDifferentProfile = !!ctx.opts.provider
        && !!profileDef?.provider
        && ctx.opts.provider !== profileDef.provider;
      if (providerLockedToDifferentProfile) {
        if (ctx.opts.tools !== undefined) {
          if (hasMcp && Array.isArray(ctx.opts.tools)) {
            const blocked = ALL_BUILTIN.filter(t => !ctx.opts.tools!.includes(t));
            state.sdkOptions.disallowedTools = blocked.length > 0 ? blocked : undefined;
            state.sdkOptions.tools = undefined;
          } else {
            state.sdkOptions.tools = Array.isArray(ctx.opts.tools) && ctx.opts.tools.length > 0
              ? ctx.opts.tools
              : undefined;
          }
        }
        if (ctx.opts.disallowedTools !== undefined) {
          state.sdkOptions.disallowedTools = Array.isArray(ctx.opts.disallowedTools) && ctx.opts.disallowedTools.length > 0
            ? ctx.opts.disallowedTools
            : undefined;
        }
      } else {
        const rawTools = ctx.opts.tools ?? profileDef?.tools ?? undefined;
        const rawDisallowed = ctx.opts.disallowedTools ?? profileDef?.disallowedTools ?? undefined;
        if (hasMcp && Array.isArray(rawTools)) {
          const blocked = ALL_BUILTIN.filter(t => !rawTools.includes(t));
          state.sdkOptions.disallowedTools = blocked.length > 0 ? blocked : undefined;
          state.sdkOptions.tools = undefined;
        } else {
          state.sdkOptions.tools = Array.isArray(rawTools) && rawTools.length > 0 ? rawTools : undefined;
          state.sdkOptions.disallowedTools = Array.isArray(rawDisallowed) && rawDisallowed.length > 0 ? rawDisallowed : undefined;
        }
      }

      // Close old input channel — next sendMessage will create a fresh resume
      state.input.close();
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
          session.lastAssistantText = (session.lastAssistantText + (delta.text ?? "")).slice(-2000);
        }
      }
      if (m.type === "assistant" && state.thinkingStartedAt) {
        state.thinkingDurationMs = Date.now() - state.thinkingStartedAt;
        state.thinkingStartedAt = undefined;
      }

      // Handle system init: capture session ID
      // DB row already exists (session-manager creates it upfront).
      // rekeySession renames the row if SDK provides a different ID.
      if (m.type === "system" && m.subtype === "init" && m.session_id && !initSeen) {
        initSeen = true;
        const realId = m.session_id;
        const isResume = session.sessionId === realId && !!getSession(realId);

        ctx.rekeySession(realId);
        session.model = m.model ?? session.model;
        session.status = "running";
        updateSessionStatus(realId, "running");

        if (isResume) {
          session.seq = getMaxSeq(realId);
        }

        // Emit user prompt (unless resuming a turn that already persisted it)
        if (!(isResume && state.skipNextPromptPersist)) {
          ctx.emitEvent({
            type: "user",
            subtype: "prompt",
            message: { role: "user", content: session.initialContent },
          });
        }
        state.skipNextPromptPersist = false;
      }

      // Track running status
      if (m.type === "assistant" && m.message?.content) {
        session.status = "running";
        // If agent called ExitPlanMode, clear permissionMode so next turn is normal
        const content = m.message.content;
        if (Array.isArray(content) && content.some((b: any) => b.type === "tool_use" && b.name === "ExitPlanMode")) {
          state.sdkOptions.permissionMode = "default";
          ctx.notifyConfigChange({ providerControls: { claude: { permissionMode: "default" } } });
        }
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
          let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0;
          for (const model of Object.values(m.modelUsage) as any[]) {
            totalIn += model.inputTokens ?? 0;
            totalOut += model.outputTokens ?? 0;
            totalCacheRead += model.cacheReadInputTokens ?? 0;
            totalCacheWrite += model.cacheCreationInputTokens ?? 0;
          }
          m.input_tokens = totalIn;
          m.output_tokens = totalOut;
          m.cache_read_tokens = totalCacheRead;
          m.cache_write_tokens = totalCacheWrite;
          m.total_tokens = totalIn + totalOut + totalCacheRead + totalCacheWrite;
        }

        session.costUsd += m.total_cost_usd ?? 0;
        session.numTurns += m.num_turns ?? 0;

        ctx.updateSessionDb({
          status: (m.subtype === "success" || m.subtype === "error_max_turns") ? "idle" : "error",
          messageCount: session.numTurns * 2,
          costUsd: m.total_cost_usd ?? 0,
          lastPrompt: session.preview,
          lastResponse: (m.result || session.lastAssistantText || "").slice(0, 2000),
        });

        logActivity({
          userProfile: session.userProfile,
          eventType: "session_end",
          sessionId: session.sessionId,
          agentProfile: session.profile,
          summary: `Turn completed: ${m.num_turns ?? 0} turns, $${(m.total_cost_usd ?? 0).toFixed(4)}`,
          metadata: { costUsd: m.total_cost_usd, numTurns: m.num_turns, status: m.subtype, durationMs: m.harness_duration_ms },
        });

        session.status = "idle";

        // Flush queued messages
        if (session.pendingMessages.length > 0) {
          const next = session.pendingMessages.shift()!;
          session.initialContent = next;
          state.input.push(next);
          session.status = "running";
          session.turnStartedAt = Date.now();
          session.preview = typeof next === "string" ? next.slice(0, 80) : "[content]";
        }
      }

      // Translate compaction events to unified format
      if (m.type === "system" && m.subtype === "status" && m.status === "compacting") {
        ctx.emitEvent({
          type: "system",
          subtype: "compacting",
          provider: "claude-code",
        });
        continue;
      }
      if (m.type === "system" && m.subtype === "compact_boundary") {
        ctx.emitEvent({
          type: "system",
          subtype: "compact_complete",
          provider: "claude-code",
          pre_tokens: m.compact_metadata?.pre_tokens,
          trigger: m.compact_metadata?.trigger ?? "auto",
        });
        continue;
      }
      // Status null = compaction finished status clear — skip raw event
      if (m.type === "system" && m.subtype === "status" && m.status === null) {
        continue;
      }

      // Persist + broadcast event
      if (m.type === "system" && m.subtype === "init") {
        m.config = {
          provider: ctx.opts.provider ?? "",
          model: ctx.opts.model ?? "",
          effort: ctx.opts.effort ?? "",
          maxTurns: ctx.opts.maxTurns,
          toolStates: ctx.opts.toolStates ?? {},
          providerControls: ctx.opts.providerControls ?? {},
        };
        m.cwd = session.cwd;
        m.additionalDirectories = session.additionalDirectories;
        m.loadProjectSettings = ctx.opts.loadProjectSettings ?? ctx.profile?.loadProjectSettings ?? true;
      }
      ctx.emitEvent(m);
    }
    console.log(`[claude-code] drain loop exited normally for ${session.sessionId}, status=${session.status}`);
  } catch (err: any) {
    // stopSession / switchProfile may have already set status — skip if handled
    if (session.status === "idle") return;

    console.error(`[claude-code] drain caught for ${session.sessionId}:`, err);
    const isAbort = err?.name === "AbortError" || err?.type === "abort"
      || String(err).includes("aborted by user");
    if (isAbort) {
      console.log(`[claude-code] aborted ${session.sessionId}`);
      session.status = "idle";
      ctx.updateSessionDb({
        status: "idle",
        costUsd: session.costUsd,
        lastResponse: session.lastAssistantText?.slice(0, 2000),
      });
    } else {
      session.error = String(err);
      session.status = "error";
      ctx.updateSessionDb({
        status: "error",
        costUsd: session.costUsd,
        lastResponse: session.lastAssistantText?.slice(0, 2000),
      });
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
        ctx.updateSessionDb({
          status: "error",
          costUsd: session.costUsd,
          lastResponse: session.lastAssistantText?.slice(0, 2000),
        });
      });
      return;
    }
    return;
  }

  // Query finished normally or with error — fire watchers so monitorSession resolves
  if (session.status !== "error") {
    session.status = "done";
    ctx.updateSessionDb({
      status: "done",
      costUsd: session.costUsd,
      lastResponse: session.lastAssistantText?.slice(0, 2000),
    });
  }

  ctx.broadcastEvent({ type: "done" });
}
