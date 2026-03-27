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
import type { ActiveSession, MessageContent } from "../session-manager";
import { getMaxSeq, getSession, updateSessionStatus } from "../db";
import { logActivity } from "../activity";
import { registerExternalTerminal, updateTerminalSession } from "../terminal-manager";
import {
  getGlobalConfig, getUserData, getUserProfile,
  type McpServerConfig,
} from "../profiles";

// ── Constants ──

const CLAUDE_PATH = process.env.CLAUDE_PATH
  || (process.platform === "win32" ? "claude.cmd" : "claude");

const ALL_BUILTIN = [
  "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash",
  "WebSearch", "WebFetch", "Agent", "TodoWrite", "Skill", "NotebookEdit", "AskUserQuestion",
];

const CAPABILITIES: ProviderCapabilities = {
  name: "claude-code-pty",
  label: "Claude Code (PTY)",
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
  model: string;
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
  /** CLI args used to spawn — stored for restart */
  spawnArgs: string[];
  spawnEnv: Record<string, string>;
  spawnCwd: string;
  /** Terminal registration for UI visibility */
  terminal: { id: string; pushData: (data: Uint8Array) => void; unregister: () => void; clearInputBuffer: () => void } | null;
};

function getState(session: ActiveSession): PtyState | null {
  return (session._providerState as PtyState | null) ?? null;
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

function buildMcpArgs(ctx: TurnContext): string[] {
  const { session, opts, profile: profileDef } = ctx;
  const projectRoot = session.projectRoot ?? opts.cwd ?? session.cwd ?? process.cwd();
  const globalConfig = getGlobalConfig(projectRoot);
  const sessionCwdMcp = readProjectMcpServers(projectRoot);

  const mergedMcp: Record<string, any> = {
    ...sessionCwdMcp,
    ...(globalConfig.mcpServers ?? {}),
    ...(profileDef?.mcpServers ?? {}),
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

  // Inject agent-memory env vars
  if (mergedMcp["agent-memory"]) {
    const am = mergedMcp["agent-memory"] as any;
    const env: Record<string, string> = { ...(am.env ?? {}) };
    if (opts.profile) env.AGENT_PROFILE = opts.profile;
    if (opts.userProfile) env.USER_PROFILE = opts.userProfile;

    const sessionCwd = opts.cwd ?? process.env.AGENT_CWD;
    if (sessionCwd) {
      const projectMemoryDir = join(sessionCwd, ".modus", "memory");
      if (existsSync(projectMemoryDir)) {
        env.AGENT_MEMORY_DIR = projectMemoryDir;
        const dirIdx = (am.args as string[] | undefined)?.indexOf("--directory");
        const agentMemoryRoot = dirIdx !== undefined && dirIdx >= 0 ? (am.args as string[])[dirIdx + 1] : undefined;
        if (agentMemoryRoot) {
          env.AGENT_MEMORY_READ_DIRS = `${agentMemoryRoot}/memory`;
        }
      }
    }

    if (opts.userProfile) {
      const userProf = getUserProfile(opts.userProfile);
      if (userProf?.projects?.length) {
        env.AGENT_MEMORY_SKILLS_DIRS = userProf.projects
          .map((p: string) => join(p, ".claude", "skills"))
          .join(",");
      } else {
        env.AGENT_MEMORY_SKILLS_DIRS = "";
      }
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

  // Build --mcp-servers JSON arg
  const mcpEntries: Record<string, any> = {};
  for (const [name, config] of Object.entries(mergedMcp)) {
    if ("command" in config) {
      mcpEntries[name] = {
        command: config.command,
        ...(config.args?.length ? { args: config.args } : {}),
        ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
      };
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
  console.log(`[claude-code-pty] mcp-config:`, mcpJson.slice(0, 500));
  return ["--mcp-config", mcpJson];
}

// ── Build CLI spawn args ──

function buildSpawnArgs(ctx: TurnContext, state: PtyState, resumeSessionId?: string): { args: string[]; env: Record<string, string>; cwd: string } {
  const { session, opts, profile: profileDef } = ctx;

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

  // System prompt
  const systemPrompt = resolveSystemPrompt(profileDef);
  if (systemPrompt) {
    if (profileDef?.promptMode === "custom") {
      args.push("--system-prompt", systemPrompt);
    } else {
      args.push("--append-system-prompt", systemPrompt);
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
  const mcpArgs = buildMcpArgs(ctx);
  args.push(...mcpArgs);

  // Project settings
  const loadSettings = opts.loadProjectSettings ?? profileDef?.loadProjectSettings ?? true;
  if (!loadSettings) {
    args.push("--no-project-settings");
  }

  // Build env
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (profileDef?.env) {
    Object.assign(env, profileDef.env);
  }

  return { args, env, cwd };
}

// ── Spawn the CLI process ──

function spawnClaude(state: PtyState, sessionId?: string): ChildProcess {
  const bin = CLAUDE_PATH;
  console.log(`[claude-code-pty] spawning: ${bin} ${state.spawnArgs.join(" ")}`);

  const proc = spawn(bin, state.spawnArgs, {
    cwd: state.spawnCwd,
    env: state.spawnEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Collect stderr and pipe to terminal
  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim().slice(0, 2000);
    if (line) {
      console.error(`[claude-code-pty] stderr:`, line);
      state.stderrBuf += (state.stderrBuf ? "\n" : "") + line;
    }
    // Also push stderr to terminal UI for visibility
    if (state.terminal) state.terminal.pushData(new Uint8Array(chunk));
  });

  state.proc = proc;
  state.rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

  // Pipe stdout to terminal UI for raw visibility (after readline is wired)
  let stdoutChunks = 0;
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks++;
    if (stdoutChunks <= 3) {
      console.log(`[claude-code-pty] stdout chunk #${stdoutChunks} (${chunk.length} bytes): ${chunk.toString().slice(0, 120)}`);
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
    onInput: (data) => {
      const str = typeof data === "string" ? data : new TextDecoder().decode(data);
      for (const ch of str) {
        if (ch === "\r" || ch === "\n") {
          // Enter — send buffered text as a stream-json message
          if (inputBuffer.trim() && proc.stdin?.writable) {
            // Echo newline
            registration.pushData(new TextEncoder().encode("\r\n"));
            const msg = formatStdinMessage(inputBuffer.trim());
            proc.stdin.write(msg + "\n");
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

  return proc;
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

  state.proc.stdin.write(formatStdinMessage(content) + "\n");
  return true;
}

// ── NDJSON Event Drain Loop ──

async function drainEvents(ctx: TurnContext, state: PtyState): Promise<void> {
  const { session } = ctx;
  const rl = state.rl;
  if (!rl) return;

  state.draining = true;
  console.log(`[claude-code-pty] drain loop starting for ${session.sessionId}, proc pid=${state.proc?.pid}`);
  let initSeen = false;
  let turnTokens = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
  let turnCount = 0;

  try {
    for await (const line of rl) {

      if (!initSeen) {
        console.log(`[claude-code-pty] first line (${line.length} chars): ${line.slice(0, 200)}`);
      }

      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        // Skip non-JSON lines (ANSI, progress, etc.)
        console.log(`[claude-code-pty] non-JSON line: ${line.slice(0, 100)}`);
        continue;
      }

      session.lastEventAt = Date.now();

      // ── System init ──
      if (m.type === "system" && m.subtype === "init" && m.session_id && !initSeen) {
        initSeen = true;
        const realId = m.session_id;
        state.sessionId = realId;

        const isResume = session.sessionId === realId && !!getSession(realId);
        ctx.rekeySession(realId);
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
        } else if (m.usage) {
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
        if (session.pendingMessages.length > 0) {
          const next = session.pendingMessages.shift()!;
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

    console.log(`[claude-code-pty] drain loop exited for ${session.sessionId}, status=${session.status}`);
  } catch (err: any) {
    if (session.status === "idle") return;

    console.error(`[claude-code-pty] drain caught for ${session.sessionId}:`, err);
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
      session.error = String(err);
      ctx.updateSessionDb({
        status: "error",
        costUsd: session.costUsd,
        lastResponse: session.lastAssistantText?.slice(0, 2000),
      });
    }
  } finally {
    state.draining = false;
    // If the readline stream ended, the process likely died
    if (state.proc && state.proc.exitCode !== null) {
      console.log(`[claude-code-pty] process exited with code ${state.proc.exitCode}`);
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
      if (!Bun.which(CLAUDE_PATH)) {
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
      const isResume = !!opts.sessionId && !!getSession(opts.sessionId);
      const resumeId = isResume ? opts.sessionId : undefined;

      // Build spawn args
      const { args, env, cwd: resolvedCwd } = buildSpawnArgs(ctx, {
        model, cwd,
      } as any, resumeId);

      const state: PtyState = {
        proc: null,
        rl: null,
        sessionId: isResume ? opts.sessionId! : null,
        model,
        cwd,
        stderrBuf: "",
        drainPromise: null,
        draining: false,
        thinkingBuffer: "",
        thinkingStartedAt: undefined,
        thinkingDurationMs: undefined,
        lifetimeTokens: { input: 0, output: 0, cached: 0 },
        needsRestart: false,
        spawnArgs: args,
        spawnEnv: env,
        spawnCwd: resolvedCwd,
        terminal: null,
      };
      session._providerState = state;

      // Spawn the process (pass session ID for terminal registration)
      const proc = spawnClaude(state, session.sessionId);

      // Write the initial user message to stdin (stream-json format)
      proc.stdin?.write(formatStdinMessage(session.initialContent) + "\n");

      session.status = "starting";
      session.turnStartedAt = Date.now();

      // Start drain loop
      state.drainPromise = drainEvents(ctx, state).catch((err) => {
        console.error(`[claude-code-pty] drain error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        ctx.updateSessionDb({
          status: "error",
          costUsd: session.costUsd,
          lastResponse: session.lastAssistantText?.slice(0, 2000),
        });
      });

      // Handle process exit — mark for restart
      proc.on("exit", (code) => {
        console.log(`[claude-code-pty] process exited (code=${code}) for ${session.sessionId}`);
        state.needsRestart = true;
        if (session.status === "running" || session.status === "starting") {
          session.status = "error";
          session.error = `Claude Code process exited unexpectedly (code ${code})`;
          ctx.updateSessionDb({
            status: "error",
            costUsd: session.costUsd,
            lastResponse: session.lastAssistantText?.slice(0, 2000),
          });
        }
      });

      // Startup timeout
      const abortController = session.abortController;
      setTimeout(() => {
        if (session.status === "starting" && session.abortController === abortController) {
          const reason = state.stderrBuf
            ? `Session failed to start.\n\nstderr:\n${state.stderrBuf}`
            : "Session failed to start — no response from Claude Code within 30s.";
          console.error(`[claude-code-pty] startup timeout for ${session.sessionId}`);
          session.status = "error";
          session.error = reason;
          abortController.abort();
          state.proc?.kill("SIGTERM");
        }
      }, 30_000);
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);
      if (!state) {
        throw new Error("claude-code-pty provider state missing during sendMessage");
      }

      // If currently running, queue the message
      if (session.status === "running" || session.status === "starting") {
        session.pendingMessages.push(content);
        return;
      }

      // If process died, restart it with --resume
      if (state.needsRestart || !state.proc || state.proc.killed) {
        console.log(`[claude-code-pty] process needs restart for ${session.sessionId}, using --resume`);
        state.needsRestart = false;

        // Rebuild spawn args with --resume
        const { args, env, cwd: newCwd } = buildSpawnArgs(ctx, state, state.sessionId ?? undefined);
        state.spawnArgs = args;
        state.spawnEnv = env;
        state.spawnCwd = newCwd;

        const proc = spawnClaude(state, session.sessionId);
        proc.stdin?.write(formatStdinMessage(content) + "\n");

        session.initialContent = content;
        session.preview = typeof content === "string" ? content.slice(0, 80) : "[content]";
        session.status = "running";
        session.turnStartedAt = Date.now();
        session.abortController = new AbortController();

        updateSessionStatus(session.sessionId, "running");

        // Handle exit
        proc.on("exit", (code) => {
          console.log(`[claude-code-pty] restarted process exited (code=${code})`);
          state.needsRestart = true;
          if (session.status === "running") {
            session.status = "error";
            session.error = `Process exited unexpectedly (code ${code})`;
          }
        });

        state.drainPromise = drainEvents(ctx, state).catch((err) => {
          console.error(`[claude-code-pty] restart drain error:`, err);
          session.status = "error";
          session.error = String(err);
        });
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
        state.drainPromise = drainEvents(ctx, state).catch((err) => {
          console.error(`[claude-code-pty] re-drain error:`, err);
        });
      }
    },

    abort(session: ActiveSession) {
      const state = getState(session);
      if (!state) return;

      // Send SIGINT to interrupt current turn without killing the process.
      // Don't abort the drain loop — let the result event flow through naturally.
      if (state.proc && !state.proc.killed) {
        state.proc.kill("SIGINT");
        // If still alive after 5s, force kill
        setTimeout(() => {
          if (state.proc && !state.proc.killed && state.proc.exitCode === null) {
            console.log(`[claude-code-pty] force-killing after SIGINT timeout`);
            state.proc.kill("SIGTERM");
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
    },

    async dispose(session: ActiveSession) {
      const state = getState(session);
      if (!state) return;

      if (state.terminal) {
        state.terminal.unregister();
        state.terminal = null;
      }
      if (state.proc && !state.proc.killed) {
        state.proc.kill("SIGTERM");
      }
      if (state.rl) {
        state.rl.close();
      }
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
    },
  };
}
