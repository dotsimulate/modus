/**
 * Claude Code PTY Provider — persistent PTY-based execution backend.
 *
 * Unlike the SDK-based claude-code provider which spawns a new CLI subprocess
 * per turn (and relies on JSONL session files for resume), this provider keeps
 * a single Claude Code CLI process alive across turns. Messages are piped to
 * stdin; NDJSON events are parsed from stdout.
 *
 * Benefits:
 * - No JSONL session file race (the "lost last turn" bug)
 * - MCP servers stay connected across turns
 * - Zero subprocess startup latency after first message
 * - Prompt cache stays warm (same API connection)
 *
 * Limitations:
 * - Cannot inject SDK-level hooks (canUseTool) — uses CLI permission mode flags
 * - Process crash requires restart with --resume (only time JSONL is read)
 * - Config changes (model, system prompt) require process restart
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import { join, dirname, isAbsolute } from "path";
import { existsSync } from "fs";
import type { ProviderCapabilities, SessionProvider, TurnContext } from "./types";
import { createPendingDispatchItem, type ActiveSession, type MessageContent } from "../session-manager";
import { getMaxSeq, getObservedProviderSessionIds, getSession, updateProviderSessionId, updateSessionStatus } from "../db";
import { logActivity } from "../activity";
import { registerExternalTerminal, updateTerminalSession } from "../terminal-manager";
import { getMemoryLimitedEnv } from "../memory-guard";
import { attachPipeErrorHandler, pipeErrorCode, tryPipeOperation } from "../pipe-errors";
import {
  getGlobalConfig, getUserData,
  type McpServerConfig,
} from "../profiles";
import { CLAUDE_CODE_BUILTIN_TOOLS, CLAUDE_CODE_TOOL_GROUPS } from "./tool-catalog";
import { claudeNativeHistoryExists, selectProviderResumeTarget, type ResumeTargetSelection } from "../provider-session-identity";
import {
  createSensitiveTempDirectory,
  removeSensitiveTempDirectory,
  writeSensitiveTempFile,
} from "../sensitive-temp";
import {
  ProviderProcessOwner,
  type ProviderProcessLease,
} from "./provider-process-owner";
import { redactProviderDiagnostic } from "./provider-diagnostics";
import { providerChildEnv } from "./child-env";
import { cliExists, resolveCli } from "./resolve-cli";

// ── Constants ──

const CLAUDE_PATH = process.env.CLAUDE_PATH
  || (process.platform === "win32" ? "claude.cmd" : resolveCli("claude") ?? "claude");

// Universe of gate-able built-ins (catalog). Used to turn a profile tool
// allowlist into a --disallowedTools blocklist for the CLI.
const ALL_BUILTIN = CLAUDE_CODE_BUILTIN_TOOLS;

const CAPABILITIES: ProviderCapabilities = {
  name: "claude-code-pty",
  label: "Claude Code (PTY)",
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
    mode: "runtime-native",
    interactive: false,
    summary: "Claude Code runs with permission mode set at spawn time. Mid-turn permission changes require process restart.",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};

// ── Provider State ──

type PtyState = {
  proc: ChildProcess | null;
  rl: ReadlineInterface | null;
  sessionId: string | null;       // Claude Code's internal session ID
  /** Provider-native ID requested for the process currently starting. */
  resumeTarget: string | null;
  model: string;
  effort?: string;
  cwd: string;
  stderrBuf: string;
  drainPromise: Promise<void> | null;
  /** True while the drain loop is actively processing events */
  draining: boolean;
  /** Accumulated thinking text for the current turn */
  thinkingBuffer: string;
  thinkingStartedAt: number | undefined;
  thinkingDurationMs: number | undefined;
  /** Track tokens across turns within a single process */
  lifetimeTokens: { input: number; output: number; cached: number };
  /** Whether the process died and needs restart on next sendMessage */
  needsRestart: boolean;
  /** True after a config change has requested a close-gated replacement. */
  restartPending: boolean;
  /** True after interrupt until the old PTY has fully exited */
  interrupting: boolean;
  /** Prevent any close handler from restarting a disposed session. */
  disposed: boolean;
  /** Generation-bound force-kill timer, cleared only when that process closes. */
  forceKillTimer: ReturnType<typeof setTimeout> | null;
  /** CLI args used to spawn — stored for restart */
  spawnArgs: string[];
  spawnEnv: Record<string, string>;
  spawnCwd: string;
  /** Private per-process directory containing MCP config/system prompt files. */
  sensitiveTempDir: string | null;
  /** Enforces one close-delimited provider process generation at a time. */
  processOwner: ProviderProcessOwner<ChildProcess>;
  /** Terminal registration for UI visibility */
  terminal: { id: string; pushData: (data: Uint8Array) => void; unregister: () => void; clearInputBuffer: () => void } | null;
  /** Exit code from the process (set by exit handler, consumed by drain loop) */
  processExitCode?: number | null;
};

function getState(session: ActiveSession): PtyState | null {
  return (session._providerState as PtyState | null) ?? null;
}

function cleanupSensitiveTempDir(state: PtyState, directory = state.sensitiveTempDir): void {
  if (!directory) return;
  if (state.sensitiveTempDir === directory) state.sensitiveTempDir = null;
  try {
    removeSensitiveTempDirectory(directory);
  } catch {
    console.warn("[claude-code-pty] could not remove private temporary directory");
  }
}

function resolveClaudePtyResumeTarget(sessionId?: string): ResumeTargetSelection {
  if (!sessionId) return { target: null, source: "none" };
  const row = getSession(sessionId);
  if (!row) return { target: null, source: "none" };
  const selection = selectProviderResumeTarget({
    needsResume: row.message_count > 0
      || getMaxSeq(sessionId) > 0
      || !!row.parent_session_id
      || !!row.branch_message_uuid,
    modusSessionId: sessionId,
    persistedProviderSessionId: row.provider_session_id,
    observedProviderSessionIds: getObservedProviderSessionIds(sessionId),
    providerLabel: "Claude Code PTY",
  }, claudeNativeHistoryExists);
  if (selection.target && selection.source.startsWith("legacy")) {
    updateProviderSessionId(sessionId, selection.target);
  }
  return selection;
}

// ── Helpers ──

function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return (content as any[])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

function resolveSystemPrompt(profileDef: any): string | undefined {
  if (!profileDef?.prompt) return undefined;
  const userData = getUserData();
  return profileDef.prompt.replace(/\{\{(\w+)\}\}/g, (_: string, key: string) => userData[key] ?? `{{${key}}}`);
}

function resolvePermissionMode(providerControls: unknown): string {
  if (!providerControls || typeof providerControls !== "object") return "default";
  const claude = (providerControls as Record<string, unknown>).claude;
  if (!claude || typeof claude !== "object") return "default";
  const mode = (claude as Record<string, unknown>).permissionMode;
  if (typeof mode === "string") return mode;
  return "default";
}

/**
 * Resolve the set of built-in tools to disable for this turn.
 * Mirrors the SDK provider: a tool allowlist (opts/profile `tools`) is converted
 * to a blocklist over the full built-in catalog, merged with any explicit
 * `disallowedTools`. Session overrides win over the profile.
 */
function resolveDisallowedTools(ctx: TurnContext): string[] {
  const { opts, profile: profileDef } = ctx;
  const rawTools = opts.tools ?? profileDef?.tools;
  const rawDisallowed = opts.disallowedTools ?? profileDef?.disallowedTools ?? [];
  const blocked = new Set<string>(rawDisallowed);
  if (Array.isArray(rawTools)) {
    for (const tool of ALL_BUILTIN) {
      if (!rawTools.includes(tool)) blocked.add(tool);
    }
  }
  return Array.from(blocked);
}

// ── MCP Config Resolution (reuses claude-code pattern) ──

function readProjectMcpServers(projectRoot: string): Record<string, McpServerConfig> {
  const mcpPath = join(projectRoot, ".claude", "mcp.json");
  if (!existsSync(mcpPath)) return {};
  try {
    const raw = JSON.parse(require("fs").readFileSync(mcpPath, "utf-8"));
    return raw?.mcpServers ?? {};
  } catch {
    return {};
  }
}

function buildMcpArgs(ctx: TurnContext, privateTempDir: () => string): string[] {
  const { session, opts, profile: profileDef } = ctx;
  const projectRoot = session.projectRoot ?? opts.cwd ?? session.cwd ?? process.cwd();
  const globalConfig = getGlobalConfig(projectRoot);
  const sessionCwdMcp = readProjectMcpServers(projectRoot);

  const mergedMcp: Record<string, any> = {
    ...sessionCwdMcp,
    ...(globalConfig.mcpServers ?? {}),
    ...(profileDef?.mcpServers ?? {}),
    ...(opts.mcpServers as Record<string, any> ?? {}),
  };

  if (Object.keys(mergedMcp).length === 0) return [];

  // Resolve relative --directory args
  const harnessRoot = dirname(dirname(import.meta.url.replace("file://", "")));
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

  // Build --mcp-servers JSON arg
  const mcpEntries: Record<string, any> = {};
  for (const [name, config] of Object.entries(mergedMcp)) {
    if ("command" in config) {
      // Detect `npx mcp-remote <url>` pattern and convert to native HTTP type.
      // The CLI handles HTTP MCP servers directly — the npx bridge is slow on
      // Windows and causes startup timeouts that prevent tools from loading.
      const args = (config as any).args as string[] | undefined;
      if ((config as any).command === "npx" && args?.[0] === "mcp-remote" && args[1]?.startsWith("http")) {
        mcpEntries[name] = { type: "http", url: args[1] };
        console.log("[claude-code-pty] converted an mcp-remote server to native HTTP");
      } else {
        mcpEntries[name] = {
          command: (config as any).command,
          ...(args?.length ? { args } : {}),
          ...((config as any).env && Object.keys((config as any).env).length > 0 ? { env: (config as any).env } : {}),
        };
      }
    } else if ("url" in config) {
      mcpEntries[name] = {
        ...(config.type ? { type: config.type } : {}),
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
      };
    }
  }

  if (Object.keys(mcpEntries).length === 0) return [];
  const mcpJson = JSON.stringify({ mcpServers: mcpEntries });
  console.log(`[claude-code-pty] configured ${Object.keys(mcpEntries).length} MCP server(s)`);
  // Write to temp file instead of passing inline JSON as CLI arg.
  // On Windows, inline JSON gets mangled by cmd.exe shell escaping.
  const mcpFile = writeSensitiveTempFile(privateTempDir(), "mcp.json", mcpJson);
  return ["--mcp-config", mcpFile];
}

// ── Build CLI spawn args ──

function buildSpawnArgs(ctx: TurnContext, resumeSessionId?: string): {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  sensitiveTempDir: string | null;
} {
  const { session, opts, profile: profileDef } = ctx;
  let sensitiveTempDir: string | null = null;
  const privateTempDir = (): string => {
    sensitiveTempDir ??= createSensitiveTempDirectory();
    return sensitiveTempDir;
  };

  try {
    const args: string[] = [
    "-p",                                // headless/print mode
    "--output-format", "stream-json",    // NDJSON streaming
    "--input-format", "stream-json",     // streaming JSON input (stdin stays open)
    "--verbose",                         // include all event types
    "--include-partial-messages",         // streaming deltas
  ];

  // Model
  const model = opts.model ?? profileDef?.model ?? undefined;
  if (model) args.push("--model", model);

  // Effort
  const effort = opts.effort ?? profileDef?.effort;
  if (effort && effort !== "off") args.push("--effort", effort);

  // Max turns
  const maxTurns = opts.maxTurns ?? profileDef?.maxTurns;
  if (maxTurns) args.push("--max-turns", String(maxTurns));

  // Permission mode — PTY has no interactive approval, so default to bypass
  const permMode = resolvePermissionMode(opts.providerControls);
  if (permMode === "acceptEdits") {
    args.push("--allowedTools", "Edit,Write,MultiEdit,NotebookEdit");
  } else {
    // In PTY mode there's no interactive terminal for permission prompts,
    // so we must bypass permissions (the harness handles approval via its own UI)
    args.push("--dangerously-skip-permissions");
  }

  // Tool toggles — apply session/profile tool overrides so the config UI
  // actually disables tools. --disallowedTools removes the tool entirely, which
  // still takes effect alongside --dangerously-skip-permissions.
  const disallowedTools = resolveDisallowedTools(ctx);
  if (disallowedTools.length > 0) {
    args.push("--disallowedTools", disallowedTools.join(","));
  }

  // System prompt — write to temp file to avoid Windows command line length limits.
  // Long system prompts as CLI args get truncated by cmd.exe at 8191 chars,
  // which can silently drop flags that come after (like --mcp-config).
  const systemPrompt = resolveSystemPrompt(profileDef);
  if (systemPrompt) {
    const promptFile = writeSensitiveTempFile(privateTempDir(), "prompt.txt", systemPrompt);
    if (profileDef?.promptMode === "custom") {
      args.push("--system-prompt-file", promptFile);
    } else {
      args.push("--append-system-prompt-file", promptFile);
    }
  }

  // CWD
  const cwd = session.cwd ?? opts.cwd ?? process.env.AGENT_CWD ?? process.cwd();
  // cwd is passed to spawn() options, not as a CLI flag

  // Resume (only used on crash recovery)
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  // MCP servers
  const mcpArgs = buildMcpArgs(ctx, privateTempDir);
  args.push(...mcpArgs);
  // Only use harness-provided MCP config — ignore CLI's own discovery
  if (mcpArgs.length > 0) args.push("--strict-mcp-config");

  // Project settings. The CLI dropped --no-project-settings; --setting-sources
  // takes the list to load (user, project, local), so an empty list disables
  // settings files and CLAUDE.md discovery. Loading stays on the CLI default.
  const loadSettings = opts.loadProjectSettings ?? profileDef?.loadProjectSettings ?? true;
  if (!loadSettings) {
    args.push("--setting-sources", "");
  }

  // Build env
  const env: Record<string, string> = providerChildEnv();
  if (profileDef?.env) {
    Object.assign(env, profileDef.env);
  }

    return { args, env, cwd, sensitiveTempDir };
  } catch (error) {
    if (sensitiveTempDir) {
      try {
        removeSensitiveTempDirectory(sensitiveTempDir);
      } catch {
        console.warn("[claude-code-pty] could not clean up failed launch configuration");
      }
    }
    throw error;
  }
}

// ── Spawn the CLI process ──

function spawnClaude(state: PtyState, sessionId?: string): {
  proc: ChildProcess;
  lease: ProviderProcessLease<ChildProcess>;
  rl: ReadlineInterface;
} {
  const bin = CLAUDE_PATH;
  if (state.processOwner.current()) {
    throw new Error("refusing to spawn a replacement Claude PTY before the prior process closed");
  }
  console.log(`[claude-code-pty] spawning provider with ${state.spawnArgs.length} arguments`);

  let proc: ChildProcess;
  try {
    proc = spawn(bin, state.spawnArgs, {
      cwd: state.spawnCwd,
      env: getMemoryLimitedEnv(state.spawnEnv),
      stdio: ["pipe", "pipe", "pipe"],
      // A dedicated POSIX process group lets shutdown reach descendants that
      // inherited the wrapper's stdio. Windows uses taskkill /T below.
      detached: process.platform !== "win32",
    });
  } catch (error) {
    cleanupSensitiveTempDir(state);
    throw error;
  }

  if (proc.stdin) {
    attachPipeErrorHandler(proc.stdin, (error) => {
      state.stderrBuf = `Provider input stream closed unexpectedly (${pipeErrorCode(error)}).`;
      const current = state.processOwner.current();
      if (current?.process === proc) terminatePtyProcessTree(current, true);
      else {
        try { proc.kill("SIGKILL"); } catch { /* best effort */ }
      }
    });
  }

  // Collect stderr and pipe to terminal
  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim().slice(0, 2000);
    if (line) {
      console.error(`[claude-code-pty] provider stderr received (${line.length} characters)`);
      // Raw stderr remains visible only in the attached local terminal. Do not
      // copy it into long-lived session errors/logs where debug output could
      // retain headers, environment values, prompts, or private paths.
      state.stderrBuf = "Provider stderr was emitted; inspect the attached provider terminal for details.";
    }
    // Also push stderr to terminal UI for visibility
    if (state.terminal) state.terminal.pushData(new Uint8Array(chunk));
  });

  state.proc = proc;
  state.rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  const lease = state.processOwner.claim(proc);
  const processTempDir = state.sensitiveTempDir;
  proc.once("error", () => {
    // A missing executable has no live process to consume these files. Other
    // ChildProcess errors (for example a failed kill) do not prove closure.
    if (!proc.pid) cleanupSensitiveTempDir(state, processTempDir);
  });

  // Pipe stdout to terminal UI for raw visibility (after readline is wired)
  let stdoutChunks = 0;
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks++;
    if (stdoutChunks <= 3) {
      console.log(`[claude-code-pty] stdout chunk #${stdoutChunks} (${chunk.length} bytes)`);
    }
    if (state.terminal) state.terminal.pushData(new Uint8Array(chunk));
  });

  // Register with terminal system so the UI can attach
  // Unregister previous terminal if restarting
  if (state.terminal) {
    state.terminal.unregister();
    state.terminal = null;
  }

  const exitedPromise = new Promise<number | null>((resolve) => {
    proc.on("exit", (code) => resolve(code ?? null));
  });

  // Line buffer for terminal input — keystrokes are buffered and sent as
  // a properly formatted stream-json message on Enter
  let inputBuffer = "";

  const registration = registerExternalTerminal({
    sessionId: sessionId ?? state.sessionId ?? undefined,
    cwd: state.spawnCwd,
    shell: bin,
    kind: "provider",
    ownerType: "provider",
    ownerName: "claude-code-pty",
    provider: "claude-code-pty",
    interactive: true,
    pid: proc.pid ?? null,
    onStop: () => {
      try {
        proc.kill();
      } catch {}
    },
    onInput: (data) => {
      const str = typeof data === "string" ? data : new TextDecoder().decode(data);
      for (const ch of str) {
        if (ch === "\r" || ch === "\n") {
          // Enter — send buffered text as a stream-json message
          if (inputBuffer.trim() && proc.stdin?.writable) {
            // Echo newline
            registration.pushData(new TextEncoder().encode("\r\n"));
            const msg = formatStdinMessage(inputBuffer.trim());
            const wrote = tryPipeOperation(
              () => proc.stdin!.write(msg + "\n"),
              (error) => {
                state.stderrBuf = `Provider input stream closed unexpectedly (${pipeErrorCode(error)}).`;
                const current = state.processOwner.current();
                if (current?.process === proc) terminatePtyProcessTree(current, true);
              },
            );
            if (!wrote) {
              registration.pushData(new TextEncoder().encode("\r\nProvider input stream closed.\r\n"));
            }
            inputBuffer = "";
          }
        } else if (ch === "\x7f" || ch === "\b") {
          // Backspace
          if (inputBuffer.length > 0) {
            inputBuffer = inputBuffer.slice(0, -1);
            registration.pushData(new TextEncoder().encode("\b \b"));
          }
        } else if (ch === "\x03") {
          // Ctrl+C — clear buffer, echo ^C
          inputBuffer = "";
          registration.pushData(new TextEncoder().encode("^C\r\n"));
        } else if (ch >= " ") {
          // Printable character — buffer and echo
          inputBuffer += ch;
          registration.pushData(new TextEncoder().encode(ch));
        }
      }
    },
    exited: exitedPromise,
  });

  // Expose clearInputBuffer so writeMessageToStdin can discard pending keystrokes
  state.terminal = {
    ...registration,
    clearInputBuffer() { inputBuffer = ""; },
  };

  return { proc, lease, rl: state.rl };
}

// ── Write a user message to the live process stdin ──

function formatStdinMessage(content: MessageContent): string {
  // stream-json input format expects JSON messages on stdin
  // Preserve full content array (images, etc.) when multimodal
  const blocks = typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
  const msg = {
    type: "user",
    message: {
      role: "user",
      content: blocks,
    },
  };
  return JSON.stringify(msg);
}

function writeMessageToStdin(state: PtyState, content: MessageContent): boolean {
  if (!state.proc || state.proc.killed || !state.proc.stdin?.writable) {
    return false;
  }

  // Discard any partial keystrokes from the terminal UI
  if (state.terminal) state.terminal.clearInputBuffer();

  return tryPipeOperation(
    () => state.proc!.stdin!.write(formatStdinMessage(content) + "\n"),
    (error) => {
      state.stderrBuf = `Provider input stream closed unexpectedly (${pipeErrorCode(error)}).`;
      const current = state.processOwner.current();
      if (current?.process === state.proc) terminatePtyProcessTree(current, true);
    },
  );
}

function terminatePtyProcessTree(lease: ProviderProcessLease<ChildProcess>, force: boolean): void {
  const proc = lease.process;
  if (process.platform === "win32" && proc.pid) {
    const args = ["taskkill", "/T", ...(force ? ["/F"] : []), "/PID", String(proc.pid)];
    try { Bun.spawnSync(args, { stdout: "ignore", stderr: "ignore" }); } catch { /* best effort */ }
    return;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  if (proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch { /* fall back to the direct child */ }
  }
  try { proc.kill(signal); } catch { /* best effort */ }
}

function requestPtyRestart(ctx: TurnContext, state: PtyState, content?: MessageContent): void {
  const { session } = ctx;
  if (content !== undefined) {
    session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
  }
  if (state.restartPending) return;

  const lease = state.processOwner.current();
  if (!lease) {
    const next = session.pendingDispatch.shift()?.content;
    if (next !== undefined) restartPtyTurn(ctx, state, next);
    return;
  }

  state.restartPending = true;
  state.needsRestart = true;
  console.log(`[claude-code-pty] closing process generation ${lease.generation} before config restart`);
  terminatePtyProcessTree(lease, false);

  if (state.forceKillTimer) clearTimeout(state.forceKillTimer);
  state.forceKillTimer = setTimeout(() => {
    state.forceKillTimer = null;
    if (!state.processOwner.isCurrent(lease) || state.disposed) return;
    console.warn(`[claude-code-pty] force-closing process generation ${lease.generation} after restart timeout`);
    terminatePtyProcessTree(lease, true);
  }, 5000);
}

function attachPtyExitHandler(
  ctx: TurnContext,
  state: PtyState,
  prefix: string,
  lease: ProviderProcessLease<ChildProcess>,
  processTempDir: string | null,
): void {
  const { session } = ctx;
  lease.process.on("exit", (code) => {
    if (!state.processOwner.isCurrent(lease)) return;
    console.log(`[claude-code-pty] ${prefix} process exited (code=${code}) for ${session.sessionId}`);
    state.needsRestart = true;
    state.processExitCode = code;
    if (session.status === "running" && !state.interrupting && !state.restartPending && !state.disposed) {
      session.status = "error";
      session.error = `Claude Code process exited unexpectedly (code ${code})`;
      ctx.updateSessionDb({
        status: "error",
        costUsd: session.costUsd,
        lastResponse: session.lastAssistantText?.slice(0, 2000),
      });
    }
  });
  state.processOwner.releaseOnClose(lease, lease.process, () => {
    // A generation remains owned until close, not merely exit. Command wrappers
    // can exit while descendants still hold stdout/stderr and remain alive.
    cleanupSensitiveTempDir(state, processTempDir);
    if (state.forceKillTimer) {
      clearTimeout(state.forceKillTimer);
      state.forceKillTimer = null;
    }
    if (state.proc === lease.process) {
      state.proc = null;
      state.rl = null;
    }
    if (state.terminal) {
      state.terminal.unregister();
      state.terminal = null;
    }

    const shouldRestart = state.restartPending || state.interrupting;
    state.interrupting = false;
    if (!shouldRestart || state.disposed) {
      state.restartPending = false;
      return;
    }
    state.restartPending = true;

    // Let the readline iterator finish its generation before installing the next
    // one. The owner is already vacant, so no old/new process overlap is possible.
    setImmediate(() => {
      if (state.disposed) {
        state.restartPending = false;
        return;
      }
      if (state.processOwner.current()) return;
      const next = session.pendingDispatch.shift()?.content;
      if (next !== undefined) {
        restartPtyTurn(ctx, state, next);
      } else {
        state.restartPending = false;
      }
    });
  });
}

function restartPtyTurn(ctx: TurnContext, state: PtyState, content: MessageContent): void {
  const { session } = ctx;
  console.log(`[claude-code-pty] restarting PTY turn for ${session.sessionId} using --resume`);
  if (!state.sessionId || !claudeNativeHistoryExists(state.sessionId)) {
    const reason = `Claude Code PTY native history ${state.sessionId ?? "(unknown)"} is missing; refusing to start a context-free replacement`;
    console.error(`[claude-code-pty] ${reason} modus=${session.sessionId}`);
    session.status = "error";
    session.error = reason;
    updateSessionStatus(session.sessionId, "error");
    ctx.broadcastEvent({ type: "error", error: reason });
    ctx.emitEvent({ type: "done" });
    state.restartPending = false;
    return;
  }
  state.needsRestart = false;
  state.restartPending = false;
  state.interrupting = false;
  state.resumeTarget = state.sessionId;
  state.processExitCode = undefined;
  state.stderrBuf = "";

  cleanupSensitiveTempDir(state);
  const { args, env, cwd: newCwd, sensitiveTempDir } = buildSpawnArgs(ctx, state.sessionId ?? undefined);
  state.spawnArgs = args;
  state.spawnEnv = env;
  state.spawnCwd = newCwd;
  state.sensitiveTempDir = sensitiveTempDir;

  const { proc, lease, rl } = spawnClaude(state, session.sessionId);
  if (!writeMessageToStdin(state, content)) {
    terminatePtyProcessTree(lease, true);
    throw new Error("Claude Code provider input stream closed during restart");
  }

  session.initialContent = content;
  session.preview = typeof content === "string" ? content.slice(0, 80) : "[content]";
  session.status = "running";
  session.turnStartedAt = Date.now();
  session.abortController = new AbortController();

  updateSessionStatus(session.sessionId, "running");
  attachPtyExitHandler(ctx, state, "restarted", lease, sensitiveTempDir);

  state.drainPromise = drainEvents(ctx, state, lease, rl).catch((err) => {
    const safeError = redactProviderDiagnostic(String(err));
    console.error(`[claude-code-pty] restart drain error: ${safeError}`);
    session.status = "error";
    session.error = safeError;
  });
}

// ── NDJSON Event Drain Loop ──

async function drainEvents(
  ctx: TurnContext,
  state: PtyState,
  lease: ProviderProcessLease<ChildProcess>,
  rl: ReadlineInterface,
): Promise<void> {
  const { session } = ctx;
  if (!state.processOwner.isCurrent(lease)) return;

  state.draining = true;
  console.log(`[claude-code-pty] drain loop starting for ${session.sessionId}, generation=${lease.generation}`);
  let initSeen = false;
  let turnTokens = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
  let turnCount = 0;

  try {
    for await (const line of rl) {
      if (!state.processOwner.isCurrent(lease)) return;

      if (!initSeen) {
        console.log(`[claude-code-pty] first line received (${line.length} characters)`);
      }

      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        // Skip non-JSON lines (ANSI, progress, etc.)
        console.log(`[claude-code-pty] non-JSON provider output received (${line.length} characters)`);
        continue;
      }

      session.lastEventAt = Date.now();

      // ── System init ──
      if (m.type === "system" && m.subtype === "init" && m.session_id && !initSeen) {
        initSeen = true;
        const realId = m.session_id;
        if (state.resumeTarget && realId !== state.resumeTarget) {
          const reason = `Claude Code PTY refused resume target ${state.resumeTarget} and returned ${realId}; refusing to continue without the original context`;
          console.error(`[claude-code-pty] ${reason}`);
          session.status = "error";
          session.error = reason;
          updateSessionStatus(session.sessionId, "error");
          ctx.broadcastEvent({ type: "error", error: reason });
          terminatePtyProcessTree(lease, false);
          ctx.emitEvent({ type: "done" });
          return;
        }
        const isResume = !!state.resumeTarget;
        state.sessionId = realId;

        ctx.setProviderSessionId(realId);
        ctx.rekeySession(realId);
        state.resumeTarget = null;
        // Update terminal's session ID to match the rekeyed ID so the UI can find it
        if (state.terminal) {
          updateTerminalSession(state.terminal.id, realId);
        }
        session.model = m.model ?? state.model;
        session.status = "running";
        updateSessionStatus(realId, "running");

        if (isResume) {
          session.seq = getMaxSeq(realId);
        }

        // Emit initial user prompt
        ctx.emitEvent({
          type: "user",
          subtype: "prompt",
          message: { role: "user", content: session.initialContent },
        });

        ctx.emitEvent({
          type: "system",
          subtype: "init",
          session_id: realId,
          model: m.model ?? state.model,
          config: {
            provider: ctx.opts.provider ?? "claude-code-pty",
            model: ctx.opts.model ?? state.model,
            effort: ctx.opts.effort ?? "",
            maxTurns: ctx.opts.maxTurns,
            toolStates: ctx.opts.toolStates ?? {},
            providerControls: ctx.opts.providerControls ?? {},
          },
          cwd: session.cwd,
          additionalDirectories: session.additionalDirectories,
          loadProjectSettings: ctx.opts.loadProjectSettings ?? ctx.profile?.loadProjectSettings ?? true,
        });
        continue;
      }

      // ── Thinking deltas ──
      if (m.type === "stream_event" && m.event?.type === "content_block_delta") {
        const delta = m.event.delta;
        if (delta?.type === "thinking_delta") {
          if (!state.thinkingStartedAt) state.thinkingStartedAt = Date.now();
          state.thinkingBuffer += delta.thinking ?? "";
          ctx.broadcastEvent({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "thinking_delta", thinking: delta.thinking },
            },
            provider: "claude-code-pty",
          });
          continue;
        }
        if (delta?.type === "text_delta") {
          if (state.thinkingStartedAt) {
            state.thinkingDurationMs = Date.now() - state.thinkingStartedAt;
            state.thinkingStartedAt = undefined;
          }
          session.lastAssistantText = (session.lastAssistantText + (delta.text ?? "")).slice(-2000);
          ctx.broadcastEvent(m);
          continue;
        }
        // Pass through other stream events
        ctx.broadcastEvent(m);
        continue;
      }

      // ── Assistant message (full) ──
      if (m.type === "assistant" && m.message?.content) {
        session.status = "running";
        // Finalize accumulated thinking
        if (state.thinkingBuffer && state.thinkingStartedAt) {
          state.thinkingDurationMs = Date.now() - state.thinkingStartedAt;
          state.thinkingStartedAt = undefined;
        }
        ctx.emitEvent(m);
        continue;
      }

      // ── Tool result ──
      if (m.type === "user" && m.subtype === "tool_result") {
        ctx.emitEvent(m);
        continue;
      }

      // ── Compaction events ──
      if (m.type === "system" && m.subtype === "status" && m.status === "compacting") {
        ctx.emitEvent({ type: "system", subtype: "compacting", provider: "claude-code-pty" });
        continue;
      }
      if (m.type === "system" && m.subtype === "compact_boundary") {
        ctx.emitEvent({
          type: "system", subtype: "compact_complete", provider: "claude-code-pty",
          pre_tokens: m.compact_metadata?.pre_tokens,
          trigger: m.compact_metadata?.trigger ?? "auto",
        });
        continue;
      }
      if (m.type === "system" && m.subtype === "status" && m.status === null) {
        continue; // compaction clear
      }

      // ── Result event (turn complete) ──
      if (m.type === "result") {
        turnCount++;
        m.harness_duration_ms = Date.now() - session.turnStartedAt;
        if (state.thinkingDurationMs) {
          m.thinking_duration_ms = state.thinkingDurationMs;
        }
        state.thinkingStartedAt = undefined;
        state.thinkingDurationMs = undefined;
        state.thinkingBuffer = "";

        // Extract token counts
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
          turnTokens = { input: totalIn, output: totalOut, cached: totalCacheRead, cacheWrite: totalCacheWrite };
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

        if (!m.modelUsage && m.usage) {
          // Alternate format
          turnTokens.input = m.usage.inputTokens ?? 0;
          turnTokens.output = m.usage.outputTokens ?? 0;
          turnTokens.cached = m.usage.cacheReadTokens ?? 0;
        }

        state.lifetimeTokens.input += turnTokens.input;
        state.lifetimeTokens.output += turnTokens.output;
        state.lifetimeTokens.cached += turnTokens.cached;

        session.costUsd += m.total_cost_usd ?? 0;
        session.numTurns += m.num_turns ?? 0;

        ctx.updateSessionDb({
          status: (m.subtype === "success" || m.subtype === "error_max_turns" || m.subtype === "error_during_execution") ? "idle" : "error",
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
          metadata: {
            costUsd: m.total_cost_usd,
            numTurns: m.num_turns,
            status: m.subtype,
            durationMs: m.harness_duration_ms,
          },
        });

        session.status = "idle";

        // Flush queued messages — pipe to the SAME process (no new subprocess!)
        if (session.pendingDispatch.length > 0) {
          if (state.needsRestart) {
            requestPtyRestart(ctx, state);
            ctx.emitEvent(m);
            continue;
          }
          const next = session.pendingDispatch.shift()!.content;
          session.initialContent = next;
          session.preview = typeof next === "string" ? next.slice(0, 80) : "[content]";
          session.status = "running";
          session.turnStartedAt = Date.now();

          // Persist the queued user event
          ctx.emitEvent({
            type: "user",
            subtype: "prompt",
            message: { role: "user", content: next },
          });

          // Write directly to stdin — no new subprocess
          if (!writeMessageToStdin(state, next)) {
            console.error(`[claude-code-pty] failed to write pending message to stdin, process may have died`);
            state.needsRestart = true;
            session.status = "error";
            session.error = "Process died while flushing pending message";
          }
          // Reset turn-level counters
          turnTokens = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
          turnCount = 0;
        }

        ctx.emitEvent(m);
        continue;
      }

      // ── Pass through everything else ──
      ctx.emitEvent(m);
    }

    console.log(`[claude-code-pty] drain loop exited for ${session.sessionId}, status=${session.status}, initSeen=${initSeen}`);

    // Process exited and drain consumed all stdout. If we never saw init,
    // the session is stuck in "starting" — set a proper error now.
    if (session.status === "starting" && !initSeen) {
      const reason = state.stderrBuf
        ? `Claude Code process exited without initializing.\n\nstderr:\n${state.stderrBuf}`
        : `Claude Code process exited (code ${state.processExitCode ?? "?"}) without sending init`;
      console.error(`[claude-code-pty] ${reason}`);
      session.status = "error";
      session.error = reason;
      ctx.updateSessionDb({
        status: "error",
        costUsd: session.costUsd,
        lastResponse: session.lastAssistantText?.slice(0, 2000),
      });
    }
  } catch (err: any) {
    if (session.status === "idle") return;

    const safeError = redactProviderDiagnostic(String(err));
    console.error(`[claude-code-pty] drain caught for ${session.sessionId}: ${safeError}`);
    const isAbort = err?.name === "AbortError" || String(err).includes("abort")
      || session.abortController.signal.aborted;

    if (isAbort) {
      session.status = "idle";
      ctx.updateSessionDb({
        status: "idle",
        costUsd: session.costUsd,
        lastResponse: session.lastAssistantText?.slice(0, 2000),
      });
    } else {
      session.status = "error";
      session.error = safeError;
      ctx.updateSessionDb({
        status: "error",
        costUsd: session.costUsd,
        lastResponse: session.lastAssistantText?.slice(0, 2000),
      });
    }
  } finally {
    if (!state.processOwner.isCurrent(lease)) return;
    state.draining = false;
    const procExited = lease.process.exitCode !== null;
    if (procExited) {
      console.log(`[claude-code-pty] process generation ${lease.generation} exited with code ${lease.process.exitCode}`);
      state.needsRestart = true;
    }
  }
}

// ── Provider Implementation ──

export function createClaudeCodePtyProvider(): SessionProvider {
  return {
    capabilities: CAPABILITIES,

    startTurn(ctx: TurnContext) {
      const { session, opts, profile: profileDef } = ctx;

      // Pre-check
      if (!cliExists(CLAUDE_PATH)) {
        const reason = `Provider binary "${CLAUDE_PATH}" not found in PATH. Install Claude Code CLI or set CLAUDE_PATH.`;
        console.error(`[claude-code-pty] ${reason}`);
        session.status = "error";
        session.error = reason;
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: reason });
        return;
      }

      const model = opts.model ?? profileDef?.model ?? "claude-sonnet-4-6";
      const cwd = session.cwd ?? opts.cwd ?? process.env.AGENT_CWD ?? process.cwd();

      // Check for resume
      const resumeSelection = resolveClaudePtyResumeTarget(opts.sessionId);
      if (resumeSelection.error) {
        console.error(`[claude-code-pty] ${resumeSelection.error} modus=${session.sessionId}`);
        session.status = "error";
        session.error = resumeSelection.error;
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: resumeSelection.error });
        ctx.emitEvent({ type: "done" });
        return;
      }
      const resumeId = resumeSelection.target ?? undefined;
      const isResume = !!resumeId;

      // Build spawn args
      const { args, env, cwd: resolvedCwd, sensitiveTempDir } = buildSpawnArgs(ctx, resumeId);

      const state: PtyState = {
        proc: null,
        rl: null,
        sessionId: isResume ? (resumeId ?? null) : null,
        resumeTarget: resumeId ?? null,
        model,
        effort: opts.effort ?? profileDef?.effort,
        cwd,
        stderrBuf: "",
        drainPromise: null,
        draining: false,
        thinkingBuffer: "",
        thinkingStartedAt: undefined,
        thinkingDurationMs: undefined,
        lifetimeTokens: { input: 0, output: 0, cached: 0 },
        needsRestart: false,
        restartPending: false,
        interrupting: false,
        disposed: false,
        forceKillTimer: null,
        spawnArgs: args,
        spawnEnv: env,
        spawnCwd: resolvedCwd,
        sensitiveTempDir,
        processOwner: new ProviderProcessOwner<ChildProcess>(),
        terminal: null,
      };
      session._providerState = state;

      // Spawn the process (pass session ID for terminal registration)
      const { proc, lease, rl } = spawnClaude(state, session.sessionId);

      // Write the initial user message to stdin (stream-json format)
      if (!writeMessageToStdin(state, session.initialContent)) {
        terminatePtyProcessTree(lease, true);
        throw new Error("Claude Code provider input stream closed during startup");
      }

      session.status = "starting";
      session.turnStartedAt = Date.now();

      // Start drain loop
      state.drainPromise = drainEvents(ctx, state, lease, rl).catch((err) => {
        const safeError = redactProviderDiagnostic(String(err));
        console.error(`[claude-code-pty] drain error for ${session.sessionId}: ${safeError}`);
        session.status = "error";
        session.error = safeError;
        ctx.updateSessionDb({
          status: "error",
          costUsd: session.costUsd,
          lastResponse: session.lastAssistantText?.slice(0, 2000),
        });
      });

      // Handle process exit — mark for restart.
      // On Windows, .cmd wrappers can fire 'exit' before buffered stdout is delivered,
      // so DON'T immediately error during startup — let the drain loop consume remaining
      // stdout first. The drain loop handles the "exited without init" case.
      attachPtyExitHandler(ctx, state, "initial", lease, sensitiveTempDir);

      // Startup timeout — longer on Windows where pipe buffering delays stdout delivery.
      // If the process already exited, the drain loop handles the error — don't double-fire.
      const abortController = session.abortController;
      const startupTimeoutMs = process.platform === "win32" ? 60_000 : 30_000;
      setTimeout(() => {
        if (session.status === "starting" && session.abortController === abortController) {
          // If process already exited, let drain loop handle it — don't kill
          if (state.processExitCode !== undefined) {
            console.log(`[claude-code-pty] startup timeout for ${session.sessionId} but process already exited — drain loop will handle`);
            return;
          }
          const reason = state.stderrBuf
            ? `Session failed to start.\n\nstderr:\n${state.stderrBuf}`
            : `Session failed to start — no response from Claude Code within ${startupTimeoutMs / 1000}s.`;
          console.error(`[claude-code-pty] startup timeout for ${session.sessionId}`);
          session.status = "error";
          session.error = reason;
          abortController.abort();
          terminatePtyProcessTree(lease, false);
        }
      }, startupTimeoutMs);
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);
      if (!state) {
        throw new Error("claude-code-pty provider state missing during sendMessage");
      }
      const processOpen = !!state.processOwner.current();
      console.log(`[claude-code-pty] sendMessage for ${session.sessionId}: status=${session.status} processOpen=${processOpen} needsRestart=${state.needsRestart} restartPending=${state.restartPending} interrupting=${state.interrupting} draining=${state.draining} pending=${session.pendingDispatch?.length}`);

      // A close-gated replacement is already draining. Additional turns queue
      // behind the same replacement rather than spawning another generation.
      if (state.restartPending) {
        session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
        return;
      }

      // If currently running, queue the message
      if (session.status === "running" || (session.status === "starting" && state.draining)) {
        console.log(`[claude-code-pty] QUEUED message for ${session.sessionId} (status=${session.status})`);
        session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
        return;
      }

      // After an interrupt, the old PTY may still be unwinding even though the
      // session-manager already marked the session idle. Queue the follow-up
      // until the old process actually exits, then restart cleanly.
      if (state.interrupting && processOpen) {
        console.log(`[claude-code-pty] deferring follow-up until interrupted PTY exits for ${session.sessionId}`);
        session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
        return;
      }

      // Spawn-time config changed: close the current generation before resume.
      if (state.needsRestart && processOpen) {
        requestPtyRestart(ctx, state, content);
        return;
      }

      if (state.needsRestart || !processOpen) {
        console.log(`[claude-code-pty] process needs restart for ${session.sessionId}, using --resume`);
        restartPtyTurn(ctx, state, content);
        return;
      }

      // Process is alive and idle — pipe message directly to stdin
      session.initialContent = content;
      session.preview = typeof content === "string" ? content.slice(0, 80) : "[content]";
      session.status = "running";
      session.turnStartedAt = Date.now();
      session.abortController = new AbortController();

      updateSessionStatus(session.sessionId, "running");

      // Persist user event
      ctx.emitEvent({
        type: "user",
        subtype: "prompt",
        message: { role: "user", content },
      });

      console.log(`[claude-code-pty] writing to live process stdin for ${session.sessionId} (pid=${state.proc?.pid})`);
      if (!writeMessageToStdin(state, content)) {
        console.error(`[claude-code-pty] failed to write to stdin — process may have died`);
        state.needsRestart = true;
        session.status = "error";
        session.error = "Failed to write to Claude Code stdin";
        ctx.updateSessionDb({
          status: "error",
          costUsd: session.costUsd,
          lastResponse: session.lastAssistantText?.slice(0, 2000),
        });
      }

      // If the drain loop isn't running (shouldn't happen if process is alive),
      // restart it
      if (!state.draining && state.rl) {
        const lease = state.processOwner.current();
        if (!lease) return;
        state.drainPromise = drainEvents(ctx, state, lease, state.rl).catch((err) => {
          console.error(`[claude-code-pty] re-drain error: ${redactProviderDiagnostic(String(err))}`);
        });
      }
    },

    steerMessage(ctx: TurnContext, content: MessageContent): boolean {
      const { session } = ctx;
      const state = getState(session);
      if (!state) return false;

      if (session.status !== "running" && session.status !== "starting") return false;

      // A generation that is unwinding cannot carry the message into the turn
      // the user is watching: an interrupted CLI is finishing and exiting, and a
      // pending restart will replace the process outright. Refuse so the caller
      // queues instead of writing into a doomed stdin.
      if (state.interrupting || state.restartPending) return false;
      if (!state.processOwner.current()) return false;

      // Same channel the SDK provider steers through — this process was spawned
      // with `--input-format stream-json` and stdin stays open for the life of
      // the generation, so the CLI picks the message up at the next tool boundary.
      return writeMessageToStdin(state, content);
    },

    abort(session: ActiveSession) {
      const state = getState(session);
      if (!state) return;

      // Interrupt the current turn without killing the process.
      // On Linux: SIGINT works directly.
      // On Windows: SIGINT is a no-op for .cmd wrappers, so we close stdin
      // which forces the CLI to finish the current turn and emit a result.
      const lease = state.processOwner.current();
      if (lease) {
        state.interrupting = true;
        state.needsRestart = true;
        if (process.platform === "win32") {
          // Close stdin — CLI will finish current operation and exit cleanly
          try { lease.process.stdin?.end(); } catch {}
        } else {
          lease.process.kill("SIGINT");
        }
        // If still alive after 5s, force kill.
        if (state.forceKillTimer) clearTimeout(state.forceKillTimer);
        state.forceKillTimer = setTimeout(() => {
          state.forceKillTimer = null;
          if (state.processOwner.isCurrent(lease)) {
            console.log(`[claude-code-pty] force-killing generation ${lease.generation} after SIGINT timeout`);
            terminatePtyProcessTree(lease, true);
            state.needsRestart = true;
            session.abortController.abort();
          }
        }, 5000);
      }
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      if (!state) return;

      if (config.model !== undefined && config.model !== state.model) {
        state.model = config.model;
        // Model change requires process restart on next turn
        state.needsRestart = true;
        console.log(`[claude-code-pty] model changed to ${config.model}, will restart on next turn`);
      }
      if (config.effort !== undefined && config.effort !== state.effort) {
        state.effort = config.effort || undefined;
        // Effort is a spawn-time CLI flag, so it applies after a process restart.
        state.needsRestart = true;
        console.log(`[claude-code-pty] effort changed to ${config.effort || "default"}, will restart on next turn`);
      }
      if (config.tools !== undefined || config.disallowedTools !== undefined) {
        // Tool toggles are --disallowedTools spawn args, applied on restart.
        // The new override is read from ctx.opts (merged from _configOverrides)
        // when buildSpawnArgs runs for the next turn.
        state.needsRestart = true;
        console.log(`[claude-code-pty] tool overrides changed, will restart on next turn`);
      }
    },

    async dispose(session: ActiveSession) {
      const state = getState(session);
      if (!state) return;
      state.disposed = true;
      state.restartPending = false;
      state.interrupting = false;
      if (state.forceKillTimer) {
        clearTimeout(state.forceKillTimer);
        state.forceKillTimer = null;
      }

      if (state.terminal) {
        state.terminal.unregister();
        state.terminal = null;
      }
      const sensitiveTempDir = state.sensitiveTempDir;
      const lease = state.processOwner.current();
      if (lease) {
        const closed = new Promise<void>((resolve) => lease.process.once("close", () => resolve()));
        terminatePtyProcessTree(lease, false);
        await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
        if (state.processOwner.isCurrent(lease)) {
          terminatePtyProcessTree(lease, true);
          await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
        }
      }
      // Disposal is terminal for this provider state. Remove private launch
      // material even if a broken descendant prevents Node's close event.
      cleanupSensitiveTempDir(state, sensitiveTempDir);
      session.abortController.abort();
      session._providerState = null;
    },

    switchProfile(session: ActiveSession, ctx: TurnContext, _contextMode: string) {
      const state = getState(session);
      if (!state) return;
      const newModel = ctx.opts.model;
      if (newModel && newModel !== state.model) {
        state.model = newModel;
        state.needsRestart = true;
      }
      const newEffort = ctx.opts.effort;
      if (newEffort !== state.effort) {
        state.effort = newEffort;
        state.needsRestart = true;
      }
    },
  };
}
