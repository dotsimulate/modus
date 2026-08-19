/**
 * Claude Code Provider — Claude Agent SDK execution backend.
 *
 * Handles: SDK subprocess management, streaming input channels, permission hooks,
 * MCP server resolution, thinking tracking, multi-turn drain loop.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SessionProvider, TurnContext } from "./types";
import { contentPreview, createPendingDispatchItem, type ActiveSession, type MessageContent } from "../session-manager";
import { getGlobalConfig, getUserData, type McpServerConfig, type PermissionPolicy } from "../profiles";
import {
  getMaxSeq,
  getObservedProviderSessionIds,
  getSession,
  updateProviderSessionId,
  updateSessionStatus,
} from "../db";
import { logActivity } from "../activity";
import { dirname, isAbsolute, join } from "path";
import { existsSync, appendFileSync, mkdirSync } from "fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { getMemoryLimitedEnv } from "../memory-guard";
import { claudeNativeHistoryExists, selectProviderResumeTarget, type ResumeTargetSelection } from "../provider-session-identity";
import { APP_PATHS } from "../app-paths";
import { attachPipeErrorHandler, pipeErrorCode } from "../pipe-errors";
import {
  createSensitiveTempDirectory,
  removeSensitiveTempDirectory,
  writeSensitiveTempFile,
} from "../sensitive-temp";

// Dedicated message-flow log — gitignored, append-only, easy to tail
const MSG_LOG = join(APP_PATHS.logsDir, "msg-flow.log");
try { mkdirSync(dirname(MSG_LOG), { recursive: true }); } catch {}
function msgLog(sid: string, event: string, detail: string) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 });
  const line = `${ts} [${sid}] ${event}: ${detail}\n`;
  try { appendFileSync(MSG_LOG, line); } catch {}
}
import { getSecretsInfo, resolveSecret } from "../secrets";
import type { ProviderCapabilities } from "./types";
import { CLAUDE_CODE_BUILTIN_TOOLS, CLAUDE_CODE_TOOL_GROUPS } from "./tool-catalog";
import { providerChildEnv } from "./child-env";
import { cliExists, resolveCli } from "./resolve-cli";

// On Windows we deliberately use the .cmd shim because that's the only thing the
// Claude Code installer puts on PATH. The cmd.exe -> node.exe tree it creates is
// killed reliably below via taskkill /T /F on the wrapper PID.
const CLAUDE_PATH = process.env.CLAUDE_PATH
  || (process.platform === "win32" ? "claude.cmd" : resolveCli("claude") ?? "claude");

// Universe of gate-able built-ins (catalog). Used to convert a profile tool
// allowlist into an SDK disallowedTools blocklist, so it must list every tool
// the UI can toggle.
const ALL_BUILTIN = CLAUDE_CODE_BUILTIN_TOOLS;

const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  name: "claude-code",
  label: "Claude Code",
  family: "claude-code",
  builtInTools: ALL_BUILTIN,
  builtInToolGroups: CLAUDE_CODE_TOOL_GROUPS,
  builtInToolMode: "explicit",
  slashCommands: [
    {
      command: "/compact",
      label: "/compact",
      source: "provider",
      description: "Ask Claude Code to compact the conversation context.",
    },
    {
      command: "/context",
      label: "/context",
      source: "provider",
      description: "Ask Claude Code for its current context usage/status.",
    },
  ],
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
  /** Private directory holding the CLI-readable MCP config for this provider generation. */
  sensitiveTempDir: string | null;
  input: InputChannel;
  skipNextPromptPersist?: boolean;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  stderrBuf: string;
  /** True while a drainEvents loop is active — prevents overlapping SDK queries */
  drainActive?: boolean;
  /** True after interrupt until the old SDK drain has fully exited */
  interrupting?: boolean;
  spawnedAt?: number;
  spawnedPid?: number;
  /** Native conversation requested for this subprocess, if it must resume. */
  resumeTarget?: string;
  /** Branch subprocesses legitimately return a new ID instead of resumeTarget. */
  isBranch?: boolean;
};

type InputChannel = {
  push(content: MessageContent): void;
  close(): void;
};

function getState(session: ActiveSession): ClaudeCodeState | null {
  return (session._providerState as ClaudeCodeState | null) ?? null;
}

/**
 * Force-kill the spawned Claude CLI wrapper tree by PID.
 *
 * The SDK's query.close() does NOT reliably propagate kill to our
 * spawnClaudeCodeProcess wrapper on Windows: closing the input iterator
 * lets the SDK exit gracefully but the cmd.exe → claude → node → MCP child
 * tree survives on its open MCP HTTP keepalive connections to /api/mcp/modus
 * and keeps executing tool calls as a ghost. Always call this on any
 * non-graceful termination (abort, error, drain-exit-while-running).
 */
function killPidTreeAsync(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const t0 = Date.now();
      try {
        const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        const done = () => {
          console.log(`[claude-code] taskkill pid=${pid} took=${Date.now() - t0}ms`);
          resolve();
        };
        child.on("close", done);
        child.on("error", done);
      } catch { resolve(); }
    } else {
      try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      resolve();
    }
  });
}

/**
 * Force-kill every subprocess this session has produced and not confirmed dead.
 *
 * Root pids are tracked in `session.osPids` because one session can own several
 * cmd.exe → claude trees over its lifetime (cold start, resume after interrupt,
 * restart after error). Killing a root is enough for each of them: `taskkill /T`
 * terminates the descendant tree natively, so nothing here enumerates children.
 * Do not reintroduce per-child PID polling — it spawns a process per sweep and
 * starves the spawns it is meant to protect.
 *
 * The SDK's own close() can return having closed only its iterator, leaving a
 * child alive and still calling MCP tools over its keepalive, so every
 * non-graceful termination path routes here: abort, drain-exit while the status
 * is not idle, post-drain restart, error, and dispose.
 */
const inFlightKills = new WeakMap<ActiveSession, Promise<void>>();

function killAllSpawnedAsync(session: ActiveSession, state: ClaudeCodeState | null): Promise<void> {
  const existing = inFlightKills.get(session);
  if (existing) {
    console.log(`[claude-code] killAllSpawned coalesced session=${session.sessionId}`);
    return existing;
  }
  const run = (async () => {
    const t0 = Date.now();
    // Killing the known root is sufficient: the platform terminates the whole
    // descendant tree with it.
    const rootPid = state?.spawnedPid;
    if (rootPid) {
      session.osPids.add(rootPid);
      await killPidTreeAsync(rootPid);
      session.osPids.delete(rootPid);
    }
    // Any other PIDs that were tracked elsewhere (e.g. resume-after-interrupt
    // restarts) — kill those root handles too.
    const remaining = Array.from(session.osPids);
    await Promise.all(remaining.map(async (pid) => {
      await killPidTreeAsync(pid);
      session.osPids.delete(pid);
    }));
    if (state) state.spawnedPid = undefined;
    console.log(`[claude-code] killAllSpawned session=${session.sessionId} took=${Date.now() - t0}ms`);
  })().finally(() => {
    inFlightKills.delete(session);
  });
  inFlightKills.set(session, run);
  return run;
}

function normalizeClaudeEffort(effort?: string): string | undefined {
  if (!effort || effort === "off") return undefined;
  return effort;
}

function resolveClaudeResumeTarget(sessionId?: string): ResumeTargetSelection {
  if (!sessionId) return { target: null, source: "none" };
  const row = getSession(sessionId);
  if (!row) return { target: null, source: "none" };
  const needsResume = row.message_count > 0
    || getMaxSeq(sessionId) > 0
    || !!row.parent_session_id
    || !!row.branch_message_uuid;
  const selection = selectProviderResumeTarget({
    needsResume,
    modusSessionId: sessionId,
    persistedProviderSessionId: row.provider_session_id,
    observedProviderSessionIds: getObservedProviderSessionIds(sessionId),
    providerLabel: "Claude Code",
  }, claudeNativeHistoryExists);
  if (selection.target && selection.source.startsWith("legacy")) {
    updateProviderSessionId(sessionId, selection.target);
  }
  return selection;
}

type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
const VALID_PERMISSION_MODES = new Set<ClaudePermissionMode>(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"]);

function readClaudePermissionMode(providerControls: unknown): ClaudePermissionMode {
  if (!providerControls || typeof providerControls !== "object") return "default";
  const claude = (providerControls as Record<string, unknown>).claude;
  if (!claude || typeof claude !== "object") return "default";
  const mode = (claude as Record<string, unknown>).permissionMode;
  if (typeof mode === "string" && VALID_PERMISSION_MODES.has(mode as ClaudePermissionMode)) {
    return mode as ClaudePermissionMode;
  }
  return "default";
}

function spawnClaudeProcess(options: {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  onStderr?: (data: string) => void;
  onSpawn?: (pid: number | undefined) => void;
}) {
  // CRITICAL: Windows .cmd/.bat shims cannot be executed by Node's spawn with
  // shell:false (stdio never connects → startup hang). shell:true would fix
  // launching but mangles args (empty strings are dropped by cmd.exe
  // concatenation). The reliable path is to invoke `cmd.exe /c <cmd> <args...>`
  // ourselves with shell:false so Node quotes each arg properly. We still own
  // the cmd.exe PID for taskkill /T /F tree-kill on interrupt.
  const cmdLower = options.command.toLowerCase();
  const isWinShim = process.platform === "win32"
    && (cmdLower.endsWith(".cmd") || cmdLower.endsWith(".bat"));
  const spawnCommand = isWinShim ? "cmd.exe" : options.command;
  const spawnArgs = isWinShim
    ? ["/d", "/s", "/c", options.command, ...options.args]
    : options.args;
  const child = spawn(spawnCommand, spawnArgs, {
    cwd: options.cwd,
    env: getMemoryLimitedEnv(options.env),
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: isWinShim ? false : undefined,
  });

  let forceKilled = false;
  if (child.stdin) {
    attachPipeErrorHandler(child.stdin, (error) => {
      forceKilled = true;
      console.warn(`[claude-code] provider stdin closed code=${pipeErrorCode(error)}`);
      if (process.platform === "win32" && child.pid) {
        try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); }
        catch { /* best effort */ }
      } else {
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
      }
    });
  }
  child.stderr?.on("data", (chunk) => {
    options.onStderr?.(chunk.toString());
  });
  options.onSpawn?.(child.pid);

  const wrapped = {
    stdin: child.stdin!,
    stdout: child.stdout!,
    get killed() {
      return forceKilled || child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    kill(signal: NodeJS.Signals) {
      if (process.platform === "win32" && child.pid) {
        forceKilled = true;
        try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); }
        catch { /* ignore */ }
        return true;
      }
      return child.kill(signal);
    },
    on(event: "exit" | "error", listener: (...args: any[]) => void) {
      (child as ChildProcess).on(event, listener as any);
    },
    once(event: "exit" | "error", listener: (...args: any[]) => void) {
      (child as ChildProcess).once(event, listener as any);
    },
    off(event: "exit" | "error", listener: (...args: any[]) => void) {
      (child as ChildProcess).off(event, listener as any);
    },
  };

  return wrapped;
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
            console.warn(`[mcp] Add ${val.slice(1)} to ${getSecretsInfo().path}`);
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

type SensitiveMcpConfig = { directory: string; path: string };

function writeSensitiveMcpConfig(
  servers: Record<string, McpServerConfig>,
): SensitiveMcpConfig | null {
  if (Object.keys(servers).length === 0) return null;
  const directory = createSensitiveTempDirectory();
  try {
    const path = writeSensitiveTempFile(
      directory,
      "mcp.json",
      JSON.stringify({ mcpServers: servers }),
    );
    return { directory, path };
  } catch (error) {
    try { removeSensitiveTempDirectory(directory); } catch { /* best effort */ }
    throw error;
  }
}

function sdkExtraArgsWithMcpConfig(
  current: Record<string, string | null> | undefined,
  path: string | undefined,
): Record<string, string | null> | undefined {
  const next = { ...(current ?? {}) };
  delete next["mcp-config"];
  if (path) next["mcp-config"] = path;
  return Object.keys(next).length > 0 ? next : undefined;
}

function cleanupSensitiveMcpConfig(directory: string | null): void {
  if (!directory) return;
  try {
    removeSensitiveTempDirectory(directory);
  } catch {
    console.warn("[claude-code] could not remove private MCP configuration directory");
  }
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

// ── Provider Implementation ──

type ClaudeCodeProviderDependencies = {
  /** Override executable discovery for deterministic tests without a local CLI. */
  which?: (command: string) => string | null;
};

export function createClaudeCodeProvider(dependencies: ClaudeCodeProviderDependencies = {}): SessionProvider {
  // CLAUDE_PATH may be an already-resolved absolute path, which Bun.which
  // would reject — cliExists accepts both a PATH name and a concrete file.
  const which = dependencies.which ?? ((command: string) => (cliExists(command) ? command : null));
  return {
    capabilities: CLAUDE_CAPABILITIES,
    startTurn(ctx: TurnContext) {
      const { session, opts, profile: profileDef } = ctx;
      const _t0 = performance.now();
      const _sid = session.tempId?.slice(0, 12) ?? "?";
      const _timing = (step: string) => console.log(`[claude-code-timing] step=${step} dt=${(performance.now() - _t0).toFixed(0)}ms sid=${_sid}`);

      // Pre-check: ensure claude binary is available
      _timing("which-check");
      if (!which(CLAUDE_PATH)) {
        const reason = `Provider binary "${CLAUDE_PATH}" not found in PATH. Install Claude Code CLI or set CLAUDE_PATH.`;
        console.error(`[claude-code] ${reason}`);
        session.status = "error";
        session.error = reason;
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: reason });
        ctx.emitEvent({ type: "done" });
        return;
      }

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

      _timing("pre-mcp-merge");
      // Merge MCP servers: project CWD .claude/mcp.json + global + profile
      // Priority: profile > global > project CWD (project CWD is lowest, gets overridden)
      // Use project root (where .modus/ lives), not session.cwd (may be a profile subfolder)
      const projectRoot = session.projectRoot ?? opts.cwd ?? session.cwd;
      const globalConfig = getGlobalConfig(projectRoot);
      const sessionCwdMcp = readProjectMcpServers(projectRoot ?? process.cwd());
      console.log(`[claude-code] MCP merge: projectRoot=${projectRoot} sessionCwd=${session.cwd} projectMcp=${JSON.stringify(Object.keys(sessionCwdMcp))} globalMcp=${JSON.stringify(Object.keys(globalConfig.mcpServers ?? {}))} profileMcp=${JSON.stringify(Object.keys(profileDef?.mcpServers ?? {}))} sessionMcp=${JSON.stringify(Object.keys(opts.mcpServers ?? {}))}`);
      const mergedMcp = {
        ...sessionCwdMcp,
        ...(globalConfig.mcpServers ?? {}),
        ...(profileDef?.mcpServers ?? {}),
        ...(opts.mcpServers as Record<string, any> ?? {}),
      };

      // Resolve relative --directory args to absolute
      // Project CWD servers: resolve relative to session CWD
      // Harness servers (global/profile): resolve relative to harness root
      const harnessRoot = APP_PATHS.resourcesDir;
      const projectCwdNames = new Set(Object.keys(sessionCwdMcp));
      for (const [name, server] of Object.entries(mergedMcp) as [string, any][]) {
        const args = server.args as string[] | undefined;
        if (!args) continue;
        const dirIdx = args.indexOf("--directory");
        const dirVal = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
        if (dirVal && !isAbsolute(dirVal)) {
          const anchor = projectCwdNames.has(name) ? (opts.cwd ?? session.cwd ?? process.cwd()) : harnessRoot;
          args[dirIdx + 1] = join(anchor, dirVal);
        }
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
      // Session-level override (from interact endpoint) takes precedence over profile
      const policy: PermissionPolicy = ctx.opts.permissionPolicy ?? profileDef?.permissionPolicy ?? "bypass";
      const isBypass = policy === "bypass";

      const preToolUseHook = async (hookInput: any, toolUseID: string | undefined) => {
        const toolName: string = hookInput.tool_name;
        const input: Record<string, unknown> = hookInput.tool_input ?? {};

        if (toolName === "AskUserQuestion") {
          // AskUserQuestion is always handled by canUseTool interactively.
          // Explicitly allow it through the PreToolUse hook so the SDK
          // doesn't treat an empty return as a block.
          return {
            continue: true,
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
          };
        }
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

        // ── AskUserQuestion — always intercept regardless of permission mode ──
        // Even in bypass mode we must show the interactive form. Without this,
        // AskUserQuestion runs headlessly in the CLI, gets no stdin response,
        // and returns empty — causing Claude to write "Standing by..." fallback text.
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

        // In bypass mode, allow all other tools without permission checks.
        if (isBypass) {
          return { behavior: "allow" as const, updatedInput: toolInput };
        }

        // Non-bypass: apply permission policy for remaining tools.
        return { behavior: "allow" as const, updatedInput: toolInput };
      };

      let stderrBuf = "";

      // Branch fork: resume from parent session, fork to new ID
      const isBranch = !!opts.branchParentId;
      const resumeSelection = resolveClaudeResumeTarget(isBranch ? opts.branchParentId : opts.sessionId);
      const resumeTarget = resumeSelection.target ?? undefined;
      const resumeError = resumeSelection.error
        ?? (isBranch && !resumeTarget ? "Claude Code branch parent has no verifiable native conversation" : undefined);
      if (resumeError) {
        console.error(`[claude-code] ${resumeError} session=${session.sessionId}`);
        session.status = "error";
        session.error = resumeError;
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: resumeError });
        ctx.emitEvent({ type: "done" });
        return;
      }
      session.providerSessionId = resumeTarget ?? null;
      console.log(`[claude-code] startTurn isBranch=${isBranch} resume=${resumeTarget} resumeSource=${resumeSelection.source} sessionId=${opts.sessionId} branchParent=${opts.branchParentId} branchMsgUUID=${opts.branchMessageUUID}`);

      // Fork options are one-shot — only used for the initial query(), never stored
      const forkOpts = isBranch ? {
        forkSession: true,
        sessionId: opts.sessionId,
        resumeSessionAt: opts.branchMessageUUID ?? undefined,
      } : {};

      _timing("pre-sdk-options");
      const resolvedMcp = hasMcp ? resolveEnvVars(mergedMcp) : {};
      const sensitiveMcpConfig = writeSensitiveMcpConfig(resolvedMcp);
      const claudeEnv = {
        ...providerChildEnv(),
        ...(profileDef?.env ?? {}),
        // Large Windows repos with many submodules can make Claude Code's
        // startup git status checks hang before system/init. Keep submodule
        // status out of those inherited git calls; explicit git commands still
        // work normally when Claude runs them with its own arguments.
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "diff.ignoreSubmodules",
        GIT_CONFIG_VALUE_0: "all",
        GIT_CONFIG_KEY_1: "status.submoduleSummary",
        GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "submodule.recurse",
        GIT_CONFIG_VALUE_2: "false",
      };
      const sdkOptions: any = {
        pathToClaudeCodeExecutable: CLAUDE_PATH,
        cwd: session.cwd ?? opts.cwd ?? process.env.AGENT_CWD ?? process.cwd(),
        additionalDirectories: session.additionalDirectories.length > 0 ? session.additionalDirectories : undefined,
        includePartialMessages: true,
        enableFileCheckpointing: true,
        resume: resumeTarget,
        model: opts.model ?? profileDef?.model ?? undefined,
        thinking: { type: "adaptive" },
        effort: normalizeClaudeEffort(opts.effort ?? profileDef?.effort),
        maxTurns: opts.maxTurns ?? profileDef?.maxTurns ?? undefined,
        disallowedTools: sdkDisallowed,
        tools: sdkTools,
        systemPrompt,
        settingSources: (opts.loadProjectSettings ?? profileDef?.loadProjectSettings ?? true) ? ["project"] : [],
        // When harness policy is bypass, use bypassPermissions and skip hooks entirely.
        // On Windows, the hook IPC stream between SDK and CLI is unreliable —
        // every tool call triggers a round-trip that can fail with "Stream closed".
        permissionMode: isBypass ? "bypassPermissions" : readClaudePermissionMode(opts.providerControls),
        maxBudgetUsd: profileDef?.maxBudgetUsd,
        env: claudeEnv,
        plugins: profileDef?.plugins,
        sandbox: profileDef?.sandbox,
        // Always wire canUseTool — it intercepts AskUserQuestion regardless of
        // bypass mode. Non-AskUserQuestion tools short-circuit immediately in
        // bypass mode so there's no performance cost.
        canUseTool,
        ...(isBypass ? {} : {
          hooks: {
            PreToolUse: [{
              hooks: [preToolUseHook],
              timeout: 300,
            }],
          },
        }),
        // Passing mcpServers asks the SDK to serialize the full config into
        // argv. Point the CLI at a process-private file instead.
        mcpServers: undefined,
        extraArgs: sdkExtraArgsWithMcpConfig(undefined, sensitiveMcpConfig?.path),
        stderr: (data: string) => {
          const line = data.trim().slice(0, 2000);
          // Filter Gemini CLI core spam (experiment IDs, flags, .geminiignore warnings)
          if (line.includes("experimentIds") || line.includes("flagId") || line.includes(".geminiignore") ||
              line.includes("Experiments loaded") || line.includes("Hook registry initialized") ||
              line.includes("Hook system initialized") || line.includes("Loaded cached credentials") ||
              line.startsWith("{") || line.startsWith("]") || line.startsWith("[")) return;
          console.error(`[claude-code] stderr (${session.tempId}):`, line);
          stderrBuf += (stderrBuf ? "\n" : "") + line;
          const liveState = session._providerState as ClaudeCodeState | null;
          if (liveState) liveState.stderrBuf = stderrBuf;
        },
        spawnClaudeCodeProcess: (spawnOptions: {
          command: string;
          args: string[];
          cwd?: string;
          env: Record<string, string | undefined>;
          signal: AbortSignal;
        }) => spawnClaudeProcess({
          ...spawnOptions,
          onStderr: (data) => sdkOptions.stderr(data),
          onSpawn: (pid) => {
            state.spawnedPid = pid;
            if (pid) session.osPids.add(pid);
          },
        }),
      };

      // Log resolved MCP configs for debugging startup failures (especially on Windows)
      if (hasMcp) {
        const mcpSummary = Object.entries(resolvedMcp).map(([name, cfg]: [string, any]) => {
          if (cfg.type === "http" || cfg.url) return `${name}(http→${cfg.url})`;
          return `${name}(${cfg.command} ${(cfg.args ?? []).join(" ")})`;
        });
        console.log(`[claude-code] MCP servers for ${session.tempId}: ${mcpSummary.join(", ")}`);
      }

      const abortController = session.abortController;

      // Store provider state
      const state: ClaudeCodeState = {
        queryObj: null,
        sdkOptions,
        sensitiveTempDir: sensitiveMcpConfig?.directory ?? null,
        input: channel,
        stderrBuf: "",
        resumeTarget,
        isBranch,
      };
      session._providerState = state;

      // Push initial content into the input channel
      channel.push(session.initialContent);

      // Start the SDK query
      _timing("pre-sdk-query");
      const spawnedAt = Date.now();
      console.log(`[claude-code] SPAWN ${session.tempId} at ${new Date(spawnedAt).toLocaleTimeString()}`);
      let q: ReturnType<typeof sdkQuery>;
      try {
        q = sdkQuery({ prompt: generator, options: { ...sdkOptions, ...forkOpts, abortController } });
      } catch (error) {
        cleanupSensitiveMcpConfig(state.sensitiveTempDir);
        state.sensitiveTempDir = null;
        session._providerState = null;
        throw error;
      }
      _timing("post-sdk-query");
      state.queryObj = q;
      (state as any).spawnedAt = spawnedAt;

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
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
      });

      // Startup timeout — only fires if this specific turn is still starting.
      // Guard against false positives: if the abortController has changed (sendMessage
      // created a new turn), this timeout belongs to an already-completed turn.
      // Longer on Windows where MCP server startup and pipe buffering add latency.
      const startupTimeoutMs = process.platform === "win32" ? 120_000 : 30_000;
      setTimeout(() => {
        if (session.status === "starting" && session.abortController === abortController) {
          const reason = stderrBuf
            ? `Session failed to start.\n\nstderr:\n${stderrBuf}`
            : `Session failed to start — no response from Claude Code within ${startupTimeoutMs / 1000}s.`;
          console.error(`[claude-code] startup timeout for ${session.sessionId}: ${reason}`);
          session.status = "error";
          session.error = reason;
          abortController.abort();
          killAllSpawnedAsync(session, state)
            .catch((e) => console.error(`[claude-code] startup timeout kill error session=${session.sessionId}`, e));
          ctx.broadcastEvent({ type: "error", error: reason });
          ctx.emitEvent({ type: "done" });
        }
      }, startupTimeoutMs);
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);
      const sid = session.sessionId?.slice(0, 12) ?? session.tempId?.slice(0, 12) ?? "?";
      msgLog(sid, "sendMessage", `status=${session.status} drainActive=${!!state?.drainActive} pending=${session.pendingDispatch?.length ?? 0}`);
      if (!state) {
        throw new Error("claude-code provider state missing during sendMessage");
      }

      // Subprocess still alive from previous turn — push directly through input channel.
      // Check this BEFORE status, because session-manager sets status="starting" before
      // calling sendMessage, which would cause us to queue instead of reusing.
      if (state.drainActive && !state.interrupting && session.status !== "running") {
        session.initialContent = content;
        session.preview = contentPreview(content);
        session.status = "running";
        session.turnStartedAt = Date.now();
        state.skipNextPromptPersist = true;
        updateSessionStatus(session.sessionId, "running");
        state.input.push(content);
        msgLog(sid, "REUSE", "pushed to live subprocess via input channel");
        console.log(`[claude-code] REUSE subprocess for ${session.sessionId} (drainActive, no cold start)`);
        return;
      }

      // Defer ONLY while a live subprocess is still draining an interrupt. If it
      // was force-killed (abort nulls queryObj), the drain may be hung and will
      // never flip these flags — deferring here would strand every resume
      // forever. Fall through to a clean cold-start instead.
      if (state.interrupting && state.drainActive && state.queryObj) {
        session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
        msgLog(sid, "DEFER-UNTIL-EXIT", "queued follow-up until interrupted subprocess drain exits");
        console.log(`[claude-code] deferring follow-up until interrupted subprocess exits for ${session.sessionId}`);
        return;
      }

      if (session.status === "running" || (session.status === "starting" && state.drainActive)) {
        session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
        msgLog(sid, "QUEUED", `status=${session.status} — message stuck until result event or drain exit`);
        console.log(`[claude-code] queued message for ${session.sessionId} (status=${session.status})`);
        return;
      }

      // Idle — resume with fresh SDK query
      // A fresh subprocess is about to be spawned. Wipe any leftover
      // per-subprocess flags from prior turns (specifically `interrupting`,
      // which would otherwise cause sendMessage to defer every follow-up
      // against the new live subprocess). This is the second line of defense;
      // the drain-exit error path also clears it.
      state.interrupting = false;
      session.abortController = new AbortController();
      const { generator, channel } = createInputChannel();
      state.input = channel;
      session.initialContent = content;
      session.preview = contentPreview(content);
      channel.push(content);

      const resumeSelection = resolveClaudeResumeTarget(session.sessionId);
      if (!resumeSelection.target) {
        const reason = resumeSelection.error ?? "Claude Code native conversation identity is unavailable; refusing to start fresh";
        console.error(`[claude-code] ${reason} session=${session.sessionId}`);
        session.status = "error";
        session.error = reason;
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: reason });
        ctx.emitEvent({ type: "done" });
        return;
      }
      session.providerSessionId = resumeSelection.target;
      state.resumeTarget = resumeSelection.target;
      state.isBranch = false;

      const sdkOpts = {
        ...state.sdkOptions,
        resume: resumeSelection.target,
        abortController: session.abortController,
      };
      const spawnedAt = Date.now();
      msgLog(sid, "COLD-START", "spawning new subprocess with --resume");
      console.log(`[claude-code] SPAWN (resume) modus=${session.sessionId} provider=${resumeSelection.target} source=${resumeSelection.source} at ${new Date(spawnedAt).toLocaleTimeString()}`);
      const newQ = sdkQuery({ prompt: generator, options: sdkOpts });
      state.queryObj = newQ;
      state.spawnedAt = spawnedAt;
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
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
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
      const tAbort = Date.now();
      console.log(`[claude-code] abort() enter session=${session.sessionId}`);
      const state = getState(session);
      if (state) state.interrupting = true;

      const queryObj = state?.queryObj;
      const finishAbort = (label: string) => {
        const tStep1 = Date.now();
        try { state?.input.close(); } catch { /* ignore cleanup errors */ }
        console.log(`[claude-code] abort() ${label} input.close took=${Date.now() - tStep1}ms`);
        const tStep2 = Date.now();
        try { session.abortController.abort(); } catch { /* AbortError from inflight operations */ }
        console.log(`[claude-code] abort() ${label} abortController.abort took=${Date.now() - tStep2}ms`);
        const tStep3 = Date.now();
        // SDK close() is the documented forceful termination path. On Windows,
        // still do not trust it alone: the cmd.exe -> claude/node tree can
        // survive on MCP keepalives, so the PID-tree kill below remains required.
        try { queryObj?.close(); } catch { /* ignore cleanup errors */ }
        console.log(`[claude-code] abort() ${label} queryObj.close took=${Date.now() - tStep3}ms`);
        if (state && state.queryObj === queryObj) state.queryObj = null;

        const tDispatch = Date.now();
        setImmediate(() => {
          console.log(`[claude-code] abort() ${label} killAllSpawned scheduled session=${session.sessionId} schedDelay=${Date.now() - tDispatch}ms`);
          killAllSpawnedAsync(session, state)
            .then(() => console.log(`[claude-code] abort() ${label} kill complete session=${session.sessionId} totalElapsed=${Date.now() - tAbort}ms`))
            .catch((e) => console.error(`[claude-code] killAllSpawnedAsync error session=${session.sessionId}`, e));
        });
      };

      // Official Agent SDK control path for streaming queries. This asks Claude
      // Code to interrupt the current turn before we force-close transports.
      // A short fallback keeps Escape from becoming "stop my stream but keep
      // executing tools" if the SDK control request hangs or the process is wedged.
      if (queryObj?.interrupt) {
        let finished = false;
        const fallback = setTimeout(() => {
          if (finished) return;
          finished = true;
          console.warn(`[claude-code] abort() interrupt timed out; forcing close session=${session.sessionId}`);
          finishAbort("fallback");
        }, 750);
        void queryObj.interrupt()
          .then(() => {
            if (finished) return;
            finished = true;
            clearTimeout(fallback);
            console.log(`[claude-code] abort() queryObj.interrupt resolved session=${session.sessionId}`);
            finishAbort("interrupt");
          })
          .catch((err) => {
            if (finished) return;
            finished = true;
            clearTimeout(fallback);
            console.warn(`[claude-code] abort() queryObj.interrupt failed session=${session.sessionId}:`, err);
            finishAbort("interrupt-error");
          });
      } else {
        finishAbort("no-interrupt");
      }
      console.log(`[claude-code] abort() returned (sync part) session=${session.sessionId} took=${Date.now() - tAbort}ms`);
    },

    stopTask(session: ActiveSession, taskId: string): boolean {
      const state = getState(session);
      if (!state?.queryObj) return false;
      void state.queryObj.stopTask(taskId).catch((err: unknown) => {
        console.warn(`[claude-code] stopTask failed task=${taskId} session=${session.sessionId}:`, err);
      });
      return true;
    },

    async previewWorkspaceRewind(session: ActiveSession, providerMessageId: string) {
      const queryObj = getState(session)?.queryObj;
      if (!queryObj?.rewindFiles) {
        return { available: false, files: [], error: "Claude native file checkpoint is not active for this session" };
      }
      try {
        const result = await queryObj.rewindFiles(providerMessageId, { dryRun: true });
        return {
          available: result.canRewind,
          files: result.filesChanged ?? [],
          insertions: result.insertions,
          deletions: result.deletions,
          error: result.error,
        };
      } catch (err: any) {
        return { available: false, files: [], error: err?.message ?? String(err) };
      }
    },

    async applyWorkspaceRewind(session: ActiveSession, providerMessageId: string) {
      const queryObj = getState(session)?.queryObj;
      if (!queryObj?.rewindFiles) {
        return { ok: false, files: [], error: "Claude native file checkpoint is no longer active; review again" };
      }
      try {
        const result = await queryObj.rewindFiles(providerMessageId);
        return {
          ok: result.canRewind,
          files: result.filesChanged ?? [],
          insertions: result.insertions,
          deletions: result.deletions,
          error: result.error,
        };
      } catch (err: any) {
        return { ok: false, files: [], error: err?.message ?? String(err) };
      }
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      if (!state) return;
      const hasMcp = !!state.sensitiveTempDir;

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
      // Ask the SDK to close its subprocess and MCP transports first, so a
      // process that can exit cleanly does.
      try { state.queryObj?.close(); } catch { /* ignore cleanup errors */ }
      // Then take the authoritative path. close() alone leaves surviving trees
      // on Windows, and a disposed session has no later opportunity to reap
      // them — this is the last point at which the pids are still known.
      try { await killAllSpawnedAsync(session, state); } catch { /* best effort */ }
      cleanupSensitiveMcpConfig(state.sensitiveTempDir);
      state.sensitiveTempDir = null;
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

      // Re-merge MCP servers for the new profile
      const globalConfig = getGlobalConfig(session.cwd);
      const sessionCwdMcp = readProjectMcpServers(ctx.opts.cwd ?? session.cwd ?? process.cwd());
      const mergedMcp = {
        ...sessionCwdMcp,
        ...(globalConfig.mcpServers ?? {}),
        ...(profileDef?.mcpServers ?? {}),
        ...(ctx.opts.mcpServers as Record<string, any> ?? {}),
      };

      // Resolve relative --directory args to absolute
      const harnessRoot = APP_PATHS.resourcesDir;
      const projectCwdNames = new Set(Object.keys(sessionCwdMcp));
      for (const [name, server] of Object.entries(mergedMcp) as [string, any][]) {
        const args = server.args as string[] | undefined;
        if (!args) continue;
        const dirIdx = args.indexOf("--directory");
        const dirVal = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
        if (dirVal && !isAbsolute(dirVal)) {
          const anchor = projectCwdNames.has(name) ? (ctx.opts.cwd ?? session.cwd ?? process.cwd()) : harnessRoot;
          args[dirIdx + 1] = join(anchor, dirVal);
        }
      }

      const hasMcpNew = Object.keys(mergedMcp).length > 0;
      const nextMcpConfig = writeSensitiveMcpConfig(hasMcpNew ? resolveEnvVars(mergedMcp) : {});
      console.log(`[claude-code] switchProfile MCP re-merge: ${Object.keys(mergedMcp).join(", ") || "(none)"}`);

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
      const hasMcp = hasMcpNew;
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

      // Close old query + input — kills SDK subprocess and MCP transports before fresh resume
      try { state.queryObj?.close(); } catch { /* ignore cleanup errors */ }
      state.queryObj = null;
      state.input.close();
      const previousSensitiveTempDir = state.sensitiveTempDir;
      state.sensitiveTempDir = nextMcpConfig?.directory ?? null;
      state.sdkOptions.mcpServers = undefined;
      state.sdkOptions.extraArgs = sdkExtraArgsWithMcpConfig(
        state.sdkOptions.extraArgs,
        nextMcpConfig?.path,
      );
      cleanupSensitiveMcpConfig(previousSensitiveTempDir);
    },
  };
}

// ── Event Drain Loop ──

async function drainEvents(ctx: TurnContext, state: ClaudeCodeState, q: AsyncIterable<any>) {
  const { session } = ctx;
  // Identity of the turn this drain belongs to. If a force-kill leaves this
  // drain's iterator hung and the session later cold-starts a new turn, the
  // abortController is replaced. A stale drain must NOT mutate the new turn's
  // shared state — both terminal exits below bail when this no longer matches.
  const turnAbort = session.abortController;
  let initSeen = false;
  let eventCount = 0;
  let resultSeen = false;
  const spawnedAt = state.spawnedAt ?? Date.now();
  state.drainActive = true;

  try {
    for await (const msg of q) {
      const m = msg as any;
      session.lastEventAt = Date.now();
      eventCount++;
      if (eventCount === 1) {
        console.log(`[claude-code] FIRST EVENT for ${session.sessionId} after ${Date.now() - spawnedAt}ms (type=${m.type} sub=${m.subtype ?? ""})`);
      }

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
        console.log(`[claude-code] INIT for ${session.sessionId} after ${Date.now() - spawnedAt}ms (${eventCount} events so far)`);
        const realId = m.session_id;
        if (!state.isBranch && state.resumeTarget && realId !== state.resumeTarget) {
          const reason = `Claude Code refused resume target ${state.resumeTarget} and returned ${realId}; refusing to continue without the original context`;
          console.error(`[claude-code] ${reason}`);
          session.status = "error";
          session.error = reason;
          updateSessionStatus(session.sessionId, "error");
          ctx.broadcastEvent({ type: "error", error: reason });
          try { session.abortController.abort(); } catch { /* best effort */ }
          try { state.input.close(); } catch { /* best effort */ }
          try { state.queryObj?.close(); } catch { /* best effort */ }
          ctx.emitEvent({ type: "done" });
          return;
        }
        const isResume = !!state.resumeTarget && state.resumeTarget === realId;

        ctx.setProviderSessionId(realId);
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
        resultSeen = true;
        const wasInterrupting = !!state.interrupting || session.status === "interrupting";
        if (wasInterrupting && (m.subtype === "success" || m.subtype === "error_max_turns")) {
          m.subtype = "interrupted";
          m.interrupted = true;
        }
        console.log(`[claude-code] RESULT for ${session.sessionId} after ${Date.now() - spawnedAt}ms (${eventCount} events total)`);
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

        // Extract current context window usage from the last API iteration
        if (m.usage?.iterations && Array.isArray(m.usage.iterations) && m.usage.iterations.length > 0) {
          for (let i = m.usage.iterations.length - 1; i >= 0; i--) {
            const iter = m.usage.iterations[i];
            if (!iter || (iter as any).type === "compaction") continue;
            m.context_tokens_used = (iter.input_tokens ?? 0) + (iter.cache_read_input_tokens ?? 0) + (iter.cache_creation_input_tokens ?? 0);
            break;
          }
        }
        const ctxWindow = m.modelUsage ? (Object.values(m.modelUsage as Record<string, any>)[0] as any)?.contextWindow : null;
        console.log(`[claude-code] CONTEXT: tokens_used=${m.context_tokens_used ?? "none"} window=${ctxWindow ?? "none"}`);

        session.costUsd += m.total_cost_usd ?? 0;
        session.numTurns += m.num_turns ?? 0;

        const noVisibleAssistantOutput = !(m.result || session.lastAssistantText);
        const completedBeforeInit = !initSeen;
        const zeroTurnResult = (m.num_turns ?? 0) === 0;
        if (completedBeforeInit && zeroTurnResult && noVisibleAssistantOutput) {
          const stderrDetail = state.stderrBuf ? `\n\nstderr:\n${state.stderrBuf}` : "";
          const reason = `Claude Code process ended before system/init with no assistant output${stderrDetail}`;
          console.error(`[claude-code] ${reason} for ${session.sessionId}`);
          session.status = "error";
          session.error = reason;
          ctx.updateSessionDb({
            status: "error",
            messageCount: session.exchangeCount * 2,
            costUsd: m.total_cost_usd ?? 0,
            lastPrompt: session.preview,
            lastResponse: reason,
          });
          ctx.broadcastEvent({ type: "error", error: reason });
          m.harness_error = reason;
        } else {

          ctx.updateSessionDb({
            status: (m.subtype === "success" || m.subtype === "error_max_turns" || m.subtype === "interrupted") ? "idle" : "error",
            messageCount: session.numTurns * 2,
            costUsd: m.total_cost_usd ?? 0,
            lastPrompt: session.preview,
            lastResponse: (m.result || session.lastAssistantText || "").slice(0, 2000),
          });
        }

        logActivity({
          userProfile: session.userProfile,
          eventType: "session_end",
          sessionId: session.sessionId,
          agentProfile: session.profile,
          summary: `Turn completed: ${m.num_turns ?? 0} turns, $${(m.total_cost_usd ?? 0).toFixed(4)}`,
          metadata: { costUsd: m.total_cost_usd, numTurns: m.num_turns, status: m.subtype, durationMs: m.harness_duration_ms },
        });

        if (session.status !== "error") session.status = "idle";
        const sid2 = session.sessionId?.slice(0, 12) ?? "?";

        // Flush queued messages only after normal completion. If this turn was
        // interrupted, never push the user's correction into the old live
        // subprocess; wait for drain exit, close/kill it, then restart clean.
        if (!wasInterrupting && session.pendingDispatch.length > 0) {
          const next = session.pendingDispatch.shift()!.content;
          session.initialContent = next;
          msgLog(sid2, "FLUSH-PENDING", `pushing queued message through live subprocess (${session.pendingDispatch.length} remaining)`);
          state.input.push(next);
          session.status = "running";
          session.turnStartedAt = Date.now();
          session.preview = contentPreview(next);
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
    console.log(`[claude-code] DRAIN EXIT for ${session.sessionId} after ${Date.now() - spawnedAt}ms, status=${session.status}, events=${eventCount}`);

    if (!resultSeen && session.status === "interrupting") {
      const interruptedResult = {
        type: "result",
        subtype: "interrupted",
        interrupted: true,
        total_cost_usd: session.costUsd,
      };
      session.status = "idle";
      state.interrupting = false;
      ctx.updateSessionDb({
        status: "idle",
        messageCount: session.exchangeCount * 2,
        costUsd: session.costUsd,
        lastResponse: session.lastAssistantText?.slice(0, 2000),
      });
      ctx.emitEvent(interruptedResult);
      resultSeen = true;
    }

    // SDK iterator ended. If status is still starting/running, the SDK exited without
    // sending a result event — mark as error so the UI knows.
    if (!resultSeen && (session.status === "starting" || session.status === "running")) {
      const reason = "Claude Code process ended without completing (no result event received)";
      console.error(`[claude-code] ${reason} for ${session.sessionId}`);
      session.status = "error";
      session.error = reason;
      ctx.updateSessionDb({
        status: "error",
        messageCount: session.exchangeCount * 2,
        costUsd: session.costUsd,
        lastResponse: session.lastAssistantText?.slice(0, 2000),
      });
      ctx.broadcastEvent({ type: "error", error: reason });
    }

    // Kill the SDK subprocess on any non-idle terminal status.
    // Without this, the CLI process becomes a zombie endlessly retrying hooks on a closed stream.
    if (session.status !== "idle") {
      try { state.input.close(); } catch { /* ignore */ }
      try { state.queryObj?.close(); } catch { /* ignore */ }
      state.queryObj = null;
      killAllSpawnedAsync(session, state).catch((e) => console.error(`[claude-code] killAllSpawnedAsync error session=${session.sessionId}`, e));
      // The interrupted-flag belongs to the subprocess we just killed.
      // Clear it so the next spawn isn't poisoned by stale interrupt state —
      // otherwise sendMessage will defer every follow-up forever, treating
      // the live subprocess as if it were still mid-interrupt.
      state.interrupting = false;
    }
  } catch (err: any) {
    // Superseded by a newer turn (this drain was force-killed and the session
    // already cold-started)? Don't touch the active turn's status/flags.
    if (session.abortController !== turnAbort) return;
    console.error(`[claude-code] drain caught for ${session.sessionId}:`, err);
    const isAbort = err?.name === "AbortError" || err?.type === "abort"
      || String(err).includes("aborted by user");
    const wasAlreadyIdle = session.status === "idle";
    const wasAlreadyError = session.status === "error" || !!session.error;
    if (isAbort || wasAlreadyIdle || wasAlreadyError) {
      console.log(`[claude-code] aborted ${session.sessionId}`);
      try { state.input.close(); } catch { /* ignore */ }
      try { state.queryObj?.close(); } catch { /* ignore */ }
      state.queryObj = null;
      killAllSpawnedAsync(session, state).catch((e) => console.error(`[claude-code] killAllSpawnedAsync error session=${session.sessionId}`, e));
      // Subprocess is dead — clear interrupt flag so next subprocess starts clean.
      state.interrupting = false;
      if (wasAlreadyError) {
        ctx.updateSessionDb({
          status: "error",
          messageCount: session.exchangeCount * 2,
          costUsd: session.costUsd,
          lastResponse: (session.error ?? session.lastAssistantText ?? String(err)).slice(0, 2000),
        });
      } else if (!wasAlreadyIdle) {
        session.status = "idle";
        ctx.updateSessionDb({
          status: "idle",
          messageCount: session.exchangeCount * 2,
          costUsd: session.costUsd,
          lastResponse: session.lastAssistantText?.slice(0, 2000),
        });
      }
    } else {
      session.error = String(err);
      session.status = "error";
      ctx.updateSessionDb({
        status: "error",
        costUsd: session.costUsd,
        lastResponse: session.lastAssistantText?.slice(0, 2000),
      });
      ctx.broadcastEvent({ type: "error", error: String(err) });
      // Kill subprocess — without this it becomes a zombie spamming hook errors
      try { state.input.close(); } catch { /* ignore */ }
      try { state.queryObj?.close(); } catch { /* ignore */ }
      state.queryObj = null;
      killAllSpawnedAsync(session, state).catch((e) => console.error(`[claude-code] killAllSpawnedAsync error session=${session.sessionId}`, e));
      // Subprocess is dead — clear interrupt flag so next subprocess starts clean.
      state.interrupting = false;
    }
  }

  // Superseded by a newer turn (force-killed + cold-started)? Leave the active
  // turn's shared state alone — it owns drainActive / pendingDispatch now.
  if (session.abortController !== turnAbort) return;

  // Drain is no longer actively consuming events.
  // If post-drain starts a new drain, it re-sets drainActive synchronously (before first await).
  state.drainActive = false;
  const sidDrain = session.sessionId?.slice(0, 12) ?? "?";
  msgLog(sidDrain, "DRAIN-EXIT", `status=${session.status} pending=${session.pendingDispatch.length} events=${eventCount}`);

  // Post-drain: handle pending messages after abort
  if (session.status === "idle") {
    // Capture the just-drained subprocess PID BEFORE any cold-start below can
    // overwrite state.spawnedPid, so the targeted reap can never hit the new tree.
    const deadPid = state.spawnedPid;
    try { state.input.close(); } catch { /* ignore */ }
    try { state.queryObj?.close(); } catch { /* ignore */ }
    state.queryObj = null;
    state.interrupting = false;

    // Windows: queryObj.close() does NOT reliably kill the cmd.exe -> node -> MCP
    // tree — it survives on MCP keepalives and can spin/leak as a ghost until it
    // exhausts system virtual memory (see TODO/idle-drain-exit-ghost-leak-2026-07-02.md).
    // Every other teardown path reaps via taskkill; the clean-idle path was the one
    // gap. Reap it explicitly. Targeted kill (not killAllSpawnedAsync) so a concurrent
    // cold-start's fresh PID is never taskkilled. Safe: drainActive is already false
    // here, so this subprocess is reuse-ineligible — the next turn cold-starts anyway.
    if (deadPid) {
      session.osPids.delete(deadPid);
      state.spawnedPid = undefined;
      killPidTreeAsync(deadPid).catch((e) =>
        console.error(`[claude-code] idle reap kill error session=${session.sessionId}`, e));
    }

    if (session.pendingDispatch.length > 0) {
      console.log(`[claude-code] ${session.pendingDispatch.length} pending after drain exit, restarting ${session.sessionId}`);

      // Drain exited — subprocess is dead, cold start unavoidable
      const next = session.pendingDispatch.shift()!.content;
      session.initialContent = next;
      session.preview = contentPreview(next);
      session.status = "running";
      session.turnStartedAt = Date.now();
      state.skipNextPromptPersist = true;

      session.abortController = new AbortController();
      const { generator, channel } = createInputChannel();
      state.input = channel;
      channel.push(next);
      const resumeSelection = resolveClaudeResumeTarget(session.sessionId);
      if (!resumeSelection.target) {
        const reason = resumeSelection.error ?? "Claude Code native conversation identity is unavailable; refusing to start fresh";
        console.error(`[claude-code] ${reason} session=${session.sessionId}`);
        session.status = "error";
        session.error = reason;
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: reason });
        ctx.emitEvent({ type: "done" });
        return;
      }
      session.providerSessionId = resumeSelection.target;
      state.resumeTarget = resumeSelection.target;
      state.isBranch = false;
      const sdkOpts = { ...state.sdkOptions, resume: resumeSelection.target, abortController: session.abortController };
      const newQ = sdkQuery({ prompt: generator, options: sdkOpts });
      state.queryObj = newQ;
      drainEvents(ctx, state, newQ).catch((err) => {
        console.error(`[claude-code] restart drain error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        ctx.updateSessionDb({
          status: "error",
          costUsd: session.costUsd,
          lastResponse: session.lastAssistantText?.slice(0, 2000),
        });
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
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
      messageCount: session.exchangeCount * 2,
      costUsd: session.costUsd,
      lastResponse: session.lastAssistantText?.slice(0, 2000),
    });
  }

  ctx.emitEvent({ type: "done" });
}
