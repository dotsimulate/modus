/**
 * Cursor Provider — Cursor Agent CLI execution backend.
 *
 * Handles: per-turn subprocess via cursor-agent CLI, NDJSON event streaming,
 * session resume for multi-turn, event translation to harness canonical format.
 *
 * Key characteristics:
 * - Spawns `cursor-agent` as a fresh subprocess per turn
 * - Multi-turn achieved via --resume <sessionId>
 * - Streams NDJSON events via --output-format stream-json
 * - Unique value: Composer models (cursor-native) and model multiplexer
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, isAbsolute } from "path";
import type { ProviderCapabilities, SessionProvider, TurnContext } from "./types";
import { createPendingDispatchItem, type ActiveSession, type MessageContent } from "../session-manager";
import { getMaxSeq, getSession, updateSessionStatus } from "../db";
import { getMemoryLimitedEnv } from "../memory-guard";
import { logActivity } from "../activity";
import { resolveSecret } from "../secrets";
import {
  getGlobalConfig, getProfile, resolveProfilePrompt,
  type McpServerConfig, type Profile,
} from "../profiles";
import { cursorAgentSpawnArgv0, resolveCursorAgentExecutable } from "./cursor-resolve-bin";

// ── Provider-specific state stored on session._providerState ──

type CursorState = {
  sessionId: string | null;      // cursor-agent session_id for --resume
  model: string;
  proc: ChildProcess | null;
  abortController: AbortController;
  mcpConfigPath: string | null;    // path to .cursor/mcp.json we wrote
  mcpConfigBackup: string | null;  // original content if we overwrote an existing file
};

const CURSOR_CAPABILITIES: ProviderCapabilities = {
  name: "cursor",
  label: "Cursor",
  family: "cursor" as any,
  builtInTools: ["Read", "Edit", "Bash", "Grep", "Glob", "WebSearch"],
  builtInToolGroups: [
    { label: "exec", tools: ["Bash"] },
    { label: "files", tools: ["Read", "Edit", "Grep", "Glob"] },
    { label: "web", tools: ["WebSearch"] },
  ],
  builtInToolMode: "event-derived",
  supportsMcp: true,
  mcpSupport: "full",
  nonToolSignals: ["thinking"],
  permissionModel: {
    mode: "runtime-native",
    interactive: false,
    summary: "Cursor agent runs with --force (auto-approve). Permission control via --mode flag (plan=read-only, ask=Q&A only).",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};

function getState(session: ActiveSession): CursorState {
  return session._providerState as CursorState;
}

// ── Content → string ──

function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return (content as any[])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

function buildCursorInput(content: MessageContent, ctx: TurnContext): string {
  const prompt = resolveProfilePrompt(ctx.profile);
  const userInput = contentToString(content);
  if (!prompt?.text) return userInput;

  const header = prompt.mode === "custom"
    ? "System instructions:"
    : "Additional profile instructions:";

  return `${header}\n${prompt.text}\n\nUser request:\n${userInput}`;
}

// ── Resolve API key ──

function resolveCursorApiKey(): string | undefined {
  return resolveSecret("CURSOR_API_KEY")
    ?? process.env.CURSOR_API_KEY
    ?? undefined;
}

// ── NDJSON Event Types (from cursor-agent --output-format stream-json) ──

type CursorEvent =
  | { type: "system"; subtype: "init"; session_id: string; model: string; cwd: string; apiKeySource: string; permissionMode: string }
  | { type: "user"; message: { role: string; content: any[] }; session_id: string }
  | { type: "thinking"; subtype: "delta" | "completed"; text?: string; session_id: string; timestamp_ms?: number }
  | { type: "assistant"; message: { role: string; content: any[] }; session_id: string; model_call_id?: string; timestamp_ms?: number }
  | { type: "tool_call"; subtype: "started" | "completed"; call_id: string; tool_call: Record<string, any>; model_call_id?: string; session_id: string; timestamp_ms?: number }
  | { type: "result"; subtype: "success" | "error"; duration_ms: number; duration_api_ms: number; is_error: boolean; result?: string; error?: string; session_id: string; request_id?: string; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } };

// ── Tool Call → Harness Events ──

function toolCallEvents(event: Extract<CursorEvent, { type: "tool_call" }>): any[] {
  if (event.subtype !== "completed") return [];

  const events: any[] = [];
  const callId = event.call_id;
  const tc = event.tool_call;

  // Identify tool type from the tool_call object keys
  // Known shapes: readToolCall, editToolCall, commandToolCall, listToolCall, grepToolCall, globToolCall
  const toolKey = Object.keys(tc)[0];
  if (!toolKey) return events;

  const toolData = tc[toolKey];
  const args = toolData?.args ?? {};
  const result = toolData?.result ?? {};

  // Determine tool name and extract relevant info
  let toolName = toolKey.replace("ToolCall", "");
  toolName = toolName.charAt(0).toUpperCase() + toolName.slice(1);

  const hasError = !!result.error;
  const resultContent = hasError
    ? (result.error?.errorMessage ?? result.error?.message ?? JSON.stringify(result.error))
    : (result.success?.message ?? result.success?.output ?? JSON.stringify(result.success ?? result));

  events.push({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: callId,
        name: toolName,
        input: args,
      }],
    },
  });

  events.push({
    type: "user",
    subtype: "tool_result",
    isSynthetic: true,
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: callId,
        content: typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent),
        is_error: hasError,
      }],
    },
  });

  return events;
}

// ── MCP Config ──

/**
 * Build a .cursor/mcp.json in the workspace directory with merged MCP servers
 * (built-in + global + profile). Returns the path written, or null if no servers.
 */
function writeCursorMcpConfig(ctx: TurnContext, workspaceDir: string): string | null {
  const { opts, profile } = ctx;
  const globalConfig = getGlobalConfig(ctx.session.cwd);

  const mergedMcp: Record<string, McpServerConfig> = {
    ...(globalConfig.mcpServers ?? {}),
    ...(profile?.mcpServers ?? {}),
    ...(opts.mcpServers as Record<string, any> ?? {}),
  };
  if (Object.keys(mergedMcp).length === 0) return null;

  // Resolve relative --directory args to absolute
  const harnessRoot = join(import.meta.dir, "..");
  for (const server of Object.values(mergedMcp)) {
    if ("command" in server) {
      const args = server.args;
      if (!args) continue;
      const dirIdx = args.indexOf("--directory");
      const dirVal = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
      if (dirVal && !isAbsolute(dirVal)) {
        args[dirIdx + 1] = join(harnessRoot, dirVal);
      }
    }
  }

  // Convert to Cursor mcp.json format
  const cursorMcpServers: Record<string, any> = {};
  for (const [name, config] of Object.entries(mergedMcp)) {
    if ("command" in config) {
      // stdio server
      const entry: any = { command: config.command };
      if (config.args?.length) entry.args = config.args;
      if (config.env && Object.keys(config.env).length > 0) entry.env = config.env;
      cursorMcpServers[name] = entry;
    } else if ("url" in config) {
      // HTTP/SSE server — Cursor uses "url" key
      const entry: any = { url: config.url };
      if (config.headers && Object.keys(config.headers).length > 0) entry.headers = config.headers;
      cursorMcpServers[name] = entry;
    }
  }

  if (Object.keys(cursorMcpServers).length === 0) return null;

  const mcpDir = join(workspaceDir, ".cursor");
  const mcpPath = join(mcpDir, "mcp.json");

  // Back up existing file if present
  let backup: string | null = null;
  if (existsSync(mcpPath)) {
    try { backup = readFileSync(mcpPath, "utf-8"); } catch { /* ignore */ }
  }

  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: cursorMcpServers }, null, 2));

  console.log(`[cursor] wrote MCP config: ${mcpPath} (${Object.keys(cursorMcpServers).length} servers: ${Object.keys(cursorMcpServers).join(", ")}${backup ? ", backed up existing" : ""})`);
  return mcpPath;
}

/** Read existing .cursor/mcp.json content for backup, or null */
function readExistingMcpConfig(workspaceDir: string): string | null {
  const mcpPath = join(workspaceDir, ".cursor", "mcp.json");
  if (!existsSync(mcpPath)) return null;
  try { return readFileSync(mcpPath, "utf-8"); } catch { return null; }
}

// ── Provider Implementation ──

export function createCursorProvider(): SessionProvider {
  return {
    capabilities: CURSOR_CAPABILITIES,

    startTurn(ctx: TurnContext) {
      const { session, opts, profile: profileDef } = ctx;

      // Pre-check: ensure cursor-agent binary is available
      if (!resolveCursorAgentExecutable()) {
        const bin = cursorAgentSpawnArgv0();
        const reason = `Provider binary "${bin}" not found in PATH. Install cursor-agent or set CURSOR_AGENT_BIN to the correct path.`;
        console.error(`[cursor] ${reason}`);
        session.status = "error";
        session.error = reason;
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: reason });
        ctx.emitEvent({ type: "done" });
        return;
      }

      const model = opts.model ?? profileDef?.model ?? "composer-2-fast";

      const state: CursorState = {
        sessionId: null,
        model,
        proc: null,
        abortController: session.abortController,
        mcpConfigPath: null,
        mcpConfigBackup: null,
      };
      session._providerState = state;

      // Check if this is a resume
      const isResume = !!opts.sessionId && !!getSession(opts.sessionId);
      if (isResume && opts.sessionId) {
        state.sessionId = opts.sessionId;
      }

      const input = buildCursorInput(session.initialContent, ctx);
      runTurn(ctx, state, input, isResume, false).catch((err) => {
        console.error(`[cursor] startTurn error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
      });

      // Startup timeout
      const abortController = session.abortController;
      setTimeout(() => {
        if (session.status === "starting" && session.abortController === abortController && !state.sessionId) {
          const reason = "Session failed to start — no response from Cursor within 60s.";
          console.error(`[cursor] startup timeout for ${session.sessionId}`);
          session.status = "error";
          session.error = reason;
          abortController.abort();
          ctx.broadcastEvent({ type: "error", error: reason });
          ctx.emitEvent({ type: "done" });
        }
      }, 60_000);
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);

      // session-manager briefly flips idle sessions to "starting" before follow-up
      // delivery so SSE subscribers stay attached. Once Cursor has a real session
      // ID, that synthetic "starting" state should not be treated as an active turn.
      if (session.status === "running" || (session.status === "starting" && !state.sessionId)) {
        session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
        return;
      }

      // Idle — start a new turn on the existing session
      session.abortController = new AbortController();
      state.abortController = session.abortController;
      session.initialContent = content;
      session.preview = typeof content === "string" ? content.slice(0, 80) : "[content]";
      session.status = "running";
      session.turnStartedAt = Date.now();

      updateSessionStatus(session.sessionId, "running");

      const input = buildCursorInput(content, ctx);
      runTurn(ctx, state, input, true, true).catch((err) => {
        console.error(`[cursor] sendMessage error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
      });
    },

    abort(session: ActiveSession) {
      const state = getState(session);
      if (state?.proc) {
        state.proc.kill("SIGTERM");
        // Force kill after 3s if still alive
        setTimeout(() => {
          if (state.proc && !state.proc.killed) {
            state.proc.kill("SIGKILL");
          }
        }, 3000);
      }
      state?.abortController.abort();
      session.abortController.abort();
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      if (!state) return;

      if (config.model !== undefined) {
        state.model = config.model || "composer-2-fast";
      }

      if (session.status === "running" || session.status === "starting") {
        // Can't update mid-turn — will take effect on next turn
      }
    },

    async dispose(session: ActiveSession) {
      const state = getState(session);
      if (!state) return;
      if (state.proc && !state.proc.killed) {
        state.proc.kill("SIGTERM");
      }
      // Restore or clean up .cursor/mcp.json
      if (state.mcpConfigPath) {
        try {
          if (state.mcpConfigBackup) {
            writeFileSync(state.mcpConfigPath, state.mcpConfigBackup);
          } else {
            unlinkSync(state.mcpConfigPath);
          }
        } catch { /* ignore */ }
        state.mcpConfigPath = null;
        state.mcpConfigBackup = null;
      }
      state.abortController.abort();
      session._providerState = null;
    },

    switchProfile(session: ActiveSession, ctx: TurnContext, _contextMode: string) {
      const state = getState(session);
      if (!state) return;
      state.model = ctx.opts.model || state.model;
    },
  };
}

// ── Turn Execution ──

async function runTurn(
  ctx: TurnContext,
  state: CursorState,
  input: string,
  isResume: boolean,
  skipPromptPersist: boolean,
) {
  const { session } = ctx;

  // Build cursor-agent command args
  const args: string[] = [
    "-p",                            // headless/print mode
    "--output-format", "stream-json", // NDJSON streaming
    "--trust",                        // skip workspace trust prompt
    "--force",                        // auto-approve tool use
    "--model", state.model,
  ];

  // Set workspace
  const cwd = session.cwd ?? ctx.opts.cwd ?? process.env.AGENT_CWD ?? process.cwd();
  args.push("--workspace", cwd);

  // Write MCP config and auto-approve
  if (!state.mcpConfigPath) {
    state.mcpConfigBackup = readExistingMcpConfig(cwd);
    state.mcpConfigPath = writeCursorMcpConfig(ctx, cwd);
  }
  if (state.mcpConfigPath) {
    args.push("--approve-mcps");
  }

  // Resume existing session for multi-turn
  if (isResume && state.sessionId) {
    args.push("--resume", state.sessionId);
  }

  // API key via env or flag
  const apiKey = resolveCursorApiKey();

  // The prompt is the final positional argument
  args.push(input);

  const bin = cursorAgentSpawnArgv0();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (apiKey) {
    env.CURSOR_API_KEY = apiKey;
  }

  console.log(`[cursor] spawning: ${bin} -p --model ${state.model} ${isResume && state.sessionId ? `--resume ${state.sessionId}` : "(new)"}`);

  let proc: ChildProcess;
  try {
    proc = spawn(bin, args, {
      env: getMemoryLimitedEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: any) {
    const msg = err?.code === "ENOENT"
      ? `Cursor CLI not found: "${bin}". Install cursor-agent or set CURSOR_AGENT_BIN to its path.`
      : `Failed to spawn cursor-agent: ${err?.message ?? err}`;
    console.error(`[cursor] ${msg}`);
    throw new Error(msg);
  }
  state.proc = proc;

  // Catch early spawn errors (e.g. ENOENT if binary not found)
  // so they don't become unhandled before we reach the exit-wait promise.
  let earlySpawnError: Error | null = null;
  proc.on("error", (err: any) => {
    if (!earlySpawnError) {
      const msg = err?.code === "ENOENT"
        ? `Cursor CLI not found: "${bin}". Install cursor-agent or set CURSOR_AGENT_BIN to its path.`
        : `Failed to spawn cursor-agent: ${err?.message ?? err}`;
      earlySpawnError = new Error(msg);
    }
  });

  // Close stdin immediately — cursor-agent reads prompt from args
  proc.stdin?.end();

  // Collect stderr for diagnostics
  let stderrBuf = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  // Parse NDJSON from stdout
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

  let initEmitted = false;
  let turnTokens = { input: 0, output: 0, cached: 0 };
  let lastAssistantText = "";
  let thinkingBuffer = "";
  let turnCount = 0;

  try {
    for await (const line of rl) {
      if (state.abortController.signal.aborted) break;

      let event: CursorEvent;
      try {
        event = JSON.parse(line);
      } catch {
        // Skip non-JSON lines (ANSI escape sequences, progress indicators, etc.)
        continue;
      }

      session.lastEventAt = Date.now();

      switch (event.type) {
        case "system": {
          if (event.subtype === "init") {
            state.sessionId = event.session_id;

            if (!initEmitted) {
              initEmitted = true;
              const realId = event.session_id;

              ctx.rekeySession(realId);
              session.status = "running";
              updateSessionStatus(realId, "running");

              if (isResume) {
                session.seq = getMaxSeq(realId);
              }

              if (!skipPromptPersist) {
                ctx.emitEvent({
                  type: "user",
                  subtype: "prompt",
                  message: { role: "user", content: session.initialContent },
                });
              }

              ctx.emitEvent({
                type: "system",
                subtype: "init",
                session_id: realId,
                model: event.model || state.model,
                config: {
                  provider: ctx.opts.provider ?? "cursor",
                  model: ctx.opts.model ?? state.model,
                  effort: ctx.opts.effort ?? "",
                  maxTurns: ctx.opts.maxTurns,
                  toolStates: ctx.opts.toolStates ?? {},
                  providerControls: ctx.opts.providerControls ?? {},
                },
                cwd: session.cwd,
                additionalDirectories: session.additionalDirectories,
                loadProjectSettings: ctx.opts.loadProjectSettings ?? ctx.profile?.loadProjectSettings ?? false,
              });
            }
          }
          break;
        }

        case "thinking": {
          if (event.subtype === "delta" && event.text) {
            thinkingBuffer += event.text;
            ctx.broadcastEvent({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "thinking_delta", thinking: event.text },
              },
              provider: "cursor",
            });
          } else if (event.subtype === "completed" && thinkingBuffer) {
            ctx.emitEvent({
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "thinking", thinking: thinkingBuffer }],
              },
            });
            thinkingBuffer = "";
          }
          break;
        }

        case "assistant": {
          const textBlocks = event.message?.content?.filter((b: any) => b.type === "text") ?? [];
          const text = textBlocks.map((b: any) => b.text).join("");

          if (text.trim()) {
            lastAssistantText = text;
            session.lastAssistantText = text.slice(-200);

            // Stream delta for live display
            ctx.broadcastEvent({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text },
              },
              provider: "cursor",
              fullText: text,
            });

            // Only persist final assistant messages (ones without model_call_id are final)
            if (!event.model_call_id) {
              ctx.emitEvent({
                type: "assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text }],
                },
              });
            }
          }
          break;
        }

        case "tool_call": {
          if (event.subtype === "started") {
            // Emit a streaming indicator for tool start
            const toolKey = Object.keys(event.tool_call)[0] ?? "unknown";
            const toolName = toolKey.replace("ToolCall", "");
            ctx.broadcastEvent({
              type: "stream_event",
              event: {
                type: "tool_use_begin",
                name: toolName.charAt(0).toUpperCase() + toolName.slice(1),
                id: event.call_id,
              },
              provider: "cursor",
            });
          } else if (event.subtype === "completed") {
            for (const ev of toolCallEvents(event)) {
              ctx.emitEvent(ev);
            }
          }
          break;
        }

        case "result": {
          turnCount++;
          if (event.usage) {
            turnTokens.input += event.usage.inputTokens ?? 0;
            turnTokens.output += event.usage.outputTokens ?? 0;
            turnTokens.cached += event.usage.cacheReadTokens ?? 0;
          }

          if (event.is_error || event.subtype === "error") {
            ctx.emitEvent({
              type: "result",
              subtype: "error",
              error: event.error ?? event.result ?? "Unknown cursor error",
              harness_duration_ms: event.duration_ms ?? (Date.now() - session.turnStartedAt),
              input_tokens: turnTokens.input,
              output_tokens: turnTokens.output,
              total_tokens: turnTokens.input + turnTokens.output,
              num_turns: turnCount,
              total_cost_usd: 0,
            });
            session.status = "error";
            session.error = event.error ?? event.result ?? "cursor error";
            updateSessionStatus(session.sessionId, "error");
            ctx.emitEvent({ type: "done" });
            return;
          }
          // Success result handled after loop ends
          break;
        }
      }
    }

    // Wait for process to exit
    if (earlySpawnError) throw earlySpawnError;
    await new Promise<void>((resolve, reject) => {
      if (earlySpawnError) return reject(earlySpawnError);
      if (proc.exitCode !== null) return resolve();
      proc.on("close", (code) => {
        if (code !== 0 && code !== null && !state.abortController.signal.aborted) {
          reject(new Error(`cursor-agent exited with code ${code}. stderr: ${stderrBuf.slice(-500)}`));
        } else {
          resolve();
        }
      });
      proc.on("error", (err) => reject(earlySpawnError ?? err));
    });

    // Stream completed — emit result
    const durationMs = Date.now() - session.turnStartedAt;

    ctx.emitEvent({
      type: "result",
      subtype: "success",
      result: lastAssistantText,
      harness_duration_ms: durationMs,
      input_tokens: turnTokens.input,
      output_tokens: turnTokens.output,
      total_tokens: turnTokens.input + turnTokens.output,
      num_turns: turnCount,
      total_cost_usd: 0, // Subscription-based
    });

    session.costUsd += 0;
    session.numTurns += turnCount;

    ctx.updateSessionDb({
      status: "idle",
      messageCount: session.numTurns * 2,
      costUsd: 0,
      lastPrompt: session.preview,
      lastResponse: (lastAssistantText || session.lastAssistantText || "").slice(0, 200),
    });

    logActivity({
      userProfile: session.userProfile,
      eventType: "session_end",
      sessionId: session.sessionId,
      agentProfile: session.profile,
      summary: `Turn completed: ${turnCount} turns, tokens: ${turnTokens.input}in/${turnTokens.output}out`,
      metadata: {
        numTurns: turnCount,
        status: "success",
        durationMs,
        inputTokens: turnTokens.input,
        outputTokens: turnTokens.output,
      },
    });

    session.status = "idle";

    // Flush queued messages
    if (session.pendingDispatch.length > 0) {
      const next = session.pendingDispatch.shift()!.content;
      session.initialContent = next;
      session.preview = typeof next === "string" ? next.slice(0, 80) : "[content]";
      session.abortController = new AbortController();
      state.abortController = session.abortController;
      session.status = "running";
      session.turnStartedAt = Date.now();

      const nextInput = buildCursorInput(next, ctx);
      runTurn(ctx, state, nextInput, true, true).catch((err) => {
        console.error(`[cursor] pending drain error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
      });
    }

  } catch (err: any) {
    if (session.status === "idle") return;

    console.error(`[cursor] drain caught for ${session.sessionId}:`, err);
    const isAbort = err?.name === "AbortError" || err?.type === "abort"
      || String(err).includes("abort") || state.abortController.signal.aborted;

    if (isAbort) {
      console.log(`[cursor] aborted ${session.sessionId}`);
      session.status = "idle";
      updateSessionStatus(session.sessionId, "idle");
      ctx.emitEvent({ type: "done" });

      if (session.pendingDispatch.length > 0) {
        const next = session.pendingDispatch.shift()!.content;
        session.initialContent = next;
        session.preview = typeof next === "string" ? next.slice(0, 80) : "[content]";
        session.abortController = new AbortController();
        state.abortController = session.abortController;
        session.status = "running";
        session.turnStartedAt = Date.now();

        const nextInput = buildCursorInput(next, ctx);
        runTurn(ctx, state, nextInput, true, true).catch((err2) => {
          console.error(`[cursor] post-abort drain error for ${session.sessionId}:`, err2);
          session.status = "error";
          session.error = String(err2);
          updateSessionStatus(session.sessionId, "error");
          ctx.broadcastEvent({ type: "error", error: String(err2) });
          ctx.emitEvent({ type: "done" });
        });
      }
    } else {
      session.error = String(err);
      session.status = "error";
      updateSessionStatus(session.sessionId, "error");
      ctx.broadcastEvent({ type: "error", error: String(err) });
      ctx.emitEvent({ type: "done" });
    }
  }
}
