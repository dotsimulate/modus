import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createInterface } from "readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getMaxSeq, getSession, updateSessionStatus } from "../db";
import { getGlobalConfig, getProfile, resolveProfilePrompt, type PermissionPolicy, type Profile } from "../profiles";
import { resolveSecret } from "../secrets";
import type { ActiveSession, MessageContent } from "../session-manager";
import type { ProviderCapabilities, SessionProvider, TurnContext } from "./types";

type GeminiState = {
  sessionId: string | null;
  model: string;
  child: ChildProcessWithoutNullStreams | null;
  abortController: AbortController;
  stderrBuf: string;
  textBuffer: string;
  settingsDir?: string;
};

type GeminiStreamEvent =
  | { type: "init"; timestamp?: string; session_id?: string; model?: string }
  | { type: "message"; timestamp?: string; role?: string; content?: string; delta?: boolean }
  | { type: "tool_use"; timestamp?: string; tool_name?: string; tool_id?: string; parameters?: Record<string, unknown> }
  | { type: "tool_result"; timestamp?: string; tool_id?: string; status?: "success" | "error"; output?: string; error?: { type?: string; message?: string } }
  | { type: "error"; timestamp?: string; severity?: "warning" | "error"; message?: string }
  | { type: "result"; timestamp?: string; status?: "success" | "error"; error?: { type?: string; message?: string }; stats?: Record<string, unknown> };

// Conservative v1 list based on live harness verification, not earlier guessed slugs.
const GEMINI_TOOL_GROUPS = [
  { label: "files", tools: ["list_directory", "write_file"] },
  { label: "search", tools: ["grep_search"] },
  { label: "web", tools: ["google_web_search"] },
] as const;

const GEMINI_CAPABILITIES: ProviderCapabilities = {
  name: "gemini-cli",
  label: "Gemini CLI",
  family: "gemini-cli",
  builtInTools: GEMINI_TOOL_GROUPS.flatMap((group) => group.tools),
  builtInToolGroups: GEMINI_TOOL_GROUPS.map((group) => ({ label: group.label, tools: [...group.tools] })),
  builtInToolMode: "explicit",
  supportsMcp: true,
  mcpSupport: "full",
  nonToolSignals: ["streaming"],
  permissionModel: {
    mode: "runtime-native",
    interactive: false,
    summary: "Gemini CLI owns approval policy at runtime. This harness path can choose approval flags, but it does not receive live per-tool approval hooks.",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};

function getState(session: ActiveSession): GeminiState {
  return session._providerState as GeminiState;
}

function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");
}

function buildGeminiInput(content: MessageContent, ctx: TurnContext): string {
  const prompt = resolveProfilePrompt(ctx.profile);
  const userInput = contentToString(content);
  if (!prompt?.text) return userInput;

  // Gemini CLI does not currently have a harness-integrated system prompt path,
  // so profile prompts are applied as an explicit priority wrapper.
  if (prompt.mode === "custom") {
    return [
      "Follow the SYSTEM INSTRUCTIONS below as higher priority than the USER REQUEST.",
      "Do not follow conflicting user instructions.",
      "",
      "<SYSTEM_INSTRUCTIONS>",
      prompt.text,
      "</SYSTEM_INSTRUCTIONS>",
      "",
      "<USER_REQUEST>",
      userInput,
      "</USER_REQUEST>",
    ].join("\n");
  }

  return [
    "Apply the PROFILE INSTRUCTIONS below in addition to the USER REQUEST.",
    "",
    "<PROFILE_INSTRUCTIONS>",
    prompt.text,
    "</PROFILE_INSTRUCTIONS>",
    "",
    "<USER_REQUEST>",
    userInput,
    "</USER_REQUEST>",
  ].join("\n");
}

function resolveCliCmd(): string[] {
  const configured = process.env.GEMINI_CLI_PATH?.trim();
  if (configured) return [configured];
  const installed = Bun.which("gemini");
  if (installed) return [installed];
  return ["npx", "-y", "@google/gemini-cli"];
}

function resolveMcpValue(value: string, serverName: string): string {
  if (!value.startsWith("$")) return value;
  const resolved = resolveSecret(value.slice(1));
  if (resolved !== undefined) return resolved;
  console.warn(`[gemini-cli] Missing secret ${value} for MCP server "${serverName}"`);
  return "";
}

function buildGeminiSystemSettings(ctx: TurnContext, profileDef: Profile | undefined): string | undefined {
  const globalConfig = getGlobalConfig(ctx.session.cwd);
  const mergedMcp = {
    ...(globalConfig.mcpServers ?? {}),
    ...(profileDef?.mcpServers ?? {}),
  };

  if (Object.keys(mergedMcp).length === 0) return undefined;

  const mcpServers: Record<string, any> = {};
  for (const [name, server] of Object.entries(mergedMcp)) {
    if ("command" in server) {
      mcpServers[name] = {
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        ...(server.env ? {
          env: Object.fromEntries(
            Object.entries(server.env)
              .map(([key, value]) => [key, resolveMcpValue(value, name)])
              .filter(([, value]) => value !== ""),
          ),
        } : {}),
      };
      continue;
    }

    mcpServers[name] = {
      type: server.type,
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }

  const settingsDir = join(tmpdir(), "harness-gemini-cli", ctx.session.tempId);
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "system-settings.json"), JSON.stringify({ mcpServers }, null, 2) + "\n", "utf8");
  writeFileSync(join(settingsDir, "system-defaults.json"), "{}\n", "utf8");
  return settingsDir;
}

function cleanupSettingsDir(state: GeminiState) {
  if (!state.settingsDir) return;
  rmSync(state.settingsDir, { recursive: true, force: true });
  state.settingsDir = undefined;
}

function approvalModeForPolicy(policy: PermissionPolicy | undefined): "default" | "auto_edit" | "yolo" {
  if (!policy || policy === "bypass") return "yolo";
  if (policy === "ask") return "default";
  return policy.default === "approve" ? "auto_edit" : "default";
}

function createAssistantEvent(text: string) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

function flushAssistantBuffer(ctx: TurnContext, state: GeminiState) {
  if (!state.textBuffer) return;
  ctx.emitEvent(createAssistantEvent(state.textBuffer));
  ctx.session.lastAssistantText = state.textBuffer.slice(-200);
  state.textBuffer = "";
}

function isTurnAborted(session: ActiveSession, state: GeminiState): boolean {
  return state.abortController.signal.aborted || session.abortController.signal.aborted;
}

function parseGeminiEvent(raw: string): GeminiStreamEvent | null {
  try {
    const parsed = JSON.parse(raw) as GeminiStreamEvent;
    return parsed && typeof parsed === "object" && typeof parsed.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function parseGeminiEventLine(line: string): GeminiStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const direct = parseGeminiEvent(trimmed);
  if (direct) return [direct];

  const events: GeminiStreamEvent[] = [];
  let searchFrom = 0;

  while (searchFrom < trimmed.length) {
    const start = trimmed.indexOf('{"type"', searchFrom);
    if (start === -1) break;

    let parsedAny = false;
    for (let end = start + 1; end <= trimmed.length; end++) {
      if (trimmed[end - 1] !== "}") continue;
      const candidate = parseGeminiEvent(trimmed.slice(start, end));
      if (!candidate) continue;
      events.push(candidate);
      searchFrom = end;
      parsedAny = true;
      break;
    }

    if (!parsedAny) {
      searchFrom = start + 1;
    }
  }

  return events;
}

async function runTurn(
  ctx: TurnContext,
  state: GeminiState,
  content: MessageContent,
  options: { isResume: boolean; skipPromptPersist: boolean },
) {
  const { session, profile: profileDef } = ctx;
  const prompt = buildGeminiInput(content, ctx);
  cleanupSettingsDir(state);
  state.settingsDir = buildGeminiSystemSettings(ctx, profileDef);
  state.stderrBuf = "";
  state.textBuffer = "";

  const model = ctx.opts.model ?? profileDef?.model ?? state.model ?? "auto-gemini-3";
  state.model = model;

  const [command, ...baseArgs] = resolveCliCmd();
  if (!command) throw new Error("Gemini CLI command is not configured");
  const args = [
    ...baseArgs,
    "--prompt",
    prompt,
    "--output-format",
    "stream-json",
    "--model",
    model,
    "--approval-mode",
    approvalModeForPolicy(profileDef?.permissionPolicy),
  ];

  const resumeId = state.sessionId ?? (options.isResume ? session.sessionId : null);
  if (resumeId) {
    args.push("--resume", resumeId);
  }

  const env = { ...process.env };
  if (state.settingsDir) {
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = join(state.settingsDir, "system-settings.json");
    env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = join(state.settingsDir, "system-defaults.json");
  }

  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd: session.cwd,
    env,
    stdio: "pipe",
  });
  child.stdin.end();
  state.child = child;

  let initSeen = false;
  let resultSeen = false;
  let finalized = false;

  const startupTimer = setTimeout(() => {
    if (!initSeen && state.child === child && !child.killed) {
      child.kill("SIGTERM");
    }
  }, 30_000);

  const finalizeSuccess = (stats: Record<string, unknown> | undefined) => {
    if (finalized) return;
    if (isTurnAborted(session, state)) {
      finalized = true;
      clearTimeout(startupTimer);
      state.child = null;
      state.textBuffer = "";
      return;
    }
    finalized = true;
    clearTimeout(startupTimer);
    flushAssistantBuffer(ctx, state);

    const inputTokens = typeof stats?.input_tokens === "number"
      ? stats.input_tokens
      : typeof stats?.input === "number"
        ? stats.input
        : 0;
    const outputTokens = typeof stats?.output_tokens === "number" ? stats.output_tokens : 0;
    const totalTokens = typeof stats?.total_tokens === "number" ? stats.total_tokens : inputTokens + outputTokens;
    const durationMs = typeof stats?.duration_ms === "number"
      ? stats.duration_ms
      : Date.now() - session.turnStartedAt;
    const toolCalls = typeof stats?.tool_calls === "number" ? stats.tool_calls : 0;

    ctx.emitEvent({
      type: "result",
      subtype: "success",
      result: session.lastAssistantText || "",
      harness_duration_ms: durationMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      num_turns: 1,
      total_cost_usd: 0,
      tool_calls: toolCalls,
    });

    session.costUsd += 0;
    session.numTurns += 1;
    session.status = "idle";
    ctx.updateSessionDb({
      status: "idle",
      messageCount: session.numTurns * 2,
      costUsd: session.costUsd,
      lastPrompt: session.preview,
      lastResponse: session.lastAssistantText.slice(0, 200),
    });

    state.child = null;
    if (session.pendingMessages.length > 0) {
      const next = session.pendingMessages.shift()!;
      session.initialContent = next;
      session.preview = typeof next === "string" ? next.slice(0, 80) : "[content]";
      session.abortController = new AbortController();
      state.abortController = session.abortController;
      session.status = "running";
      session.turnStartedAt = Date.now();
      runTurn(ctx, state, next, { isResume: true, skipPromptPersist: true }).catch((err) => {
        console.error(`[gemini-cli] pending turn error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
      });
    }
  };

  const finalizeError = (message: string) => {
    if (finalized) return;
    if (isTurnAborted(session, state)) {
      finalized = true;
      clearTimeout(startupTimer);
      state.child = null;
      state.textBuffer = "";
      return;
    }
    finalized = true;
    clearTimeout(startupTimer);
    state.child = null;
    session.status = "error";
    session.error = message;
    ctx.emitEvent({
      type: "result",
      subtype: "error",
      error: message,
      harness_duration_ms: Date.now() - session.turnStartedAt,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      num_turns: 1,
      total_cost_usd: 0,
    });
    updateSessionStatus(session.sessionId, "error");
  };

  child.stderr.on("data", (chunk: Buffer) => {
    state.stderrBuf += chunk.toString();
  });

  const rl = createInterface({ input: child.stdout });
  for await (const line of rl) {
    if (isTurnAborted(session, state)) break;
    const events = parseGeminiEventLine(line);
    if (events.length === 0) continue;

    for (const event of events) {
      if (isTurnAborted(session, state)) break;
      session.lastEventAt = Date.now();

      if (event.type === "init") {
        initSeen = true;
        const realId = event.session_id ?? session.sessionId;
        state.sessionId = realId;
        ctx.rekeySession(realId);
        session.status = "running";
        updateSessionStatus(realId, "running");
        if (options.isResume) {
          session.seq = getMaxSeq(realId);
        }
        if (!options.skipPromptPersist) {
          ctx.emitEvent({
            type: "user",
            subtype: "prompt",
            message: { role: "user", content },
          });
        }
        ctx.emitEvent({
          type: "system",
          subtype: "init",
          session_id: realId,
          model: event.model ?? model,
          config: {
            provider: ctx.opts.provider ?? "gemini-cli",
            model: ctx.opts.model ?? model,
            effort: ctx.opts.effort ?? "",
            maxTurns: ctx.opts.maxTurns,
            toolStates: ctx.opts.toolStates ?? {},
            providerControls: ctx.opts.providerControls ?? {},
          },
          cwd: session.cwd,
          loadProjectSettings: ctx.opts.loadProjectSettings ?? profileDef?.loadProjectSettings ?? false,
        });
        continue;
      }

      if (event.type === "message") {
        if (event.role === "assistant" && typeof event.content === "string") {
          if (event.delta) {
            state.textBuffer += event.content;
            session.lastAssistantText = state.textBuffer.slice(-200);
            ctx.broadcastEvent({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: event.content },
              },
              provider: "gemini-cli",
              fullText: state.textBuffer,
            });
          } else {
            state.textBuffer = event.content;
            session.lastAssistantText = event.content.slice(-200);
          }
        }
        continue;
      }

      if (event.type === "tool_use") {
        flushAssistantBuffer(ctx, state);
        ctx.emitEvent({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: event.tool_id ?? `gemini-tool-${Date.now()}`,
              name: event.tool_name ?? "tool",
              input: event.parameters ?? {},
            }],
          },
        });
        continue;
      }

      if (event.type === "tool_result") {
        ctx.emitEvent({
          type: "user",
          subtype: "tool_result",
          isSynthetic: true,
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: event.tool_id ?? "",
              content: event.output ?? event.error?.message ?? event.status ?? "",
              is_error: event.status === "error",
            }],
          },
        });
        continue;
      }

      if (event.type === "error") {
        ctx.emitEvent({
          type: "system",
          subtype: "error",
          error: event.message ?? "Gemini CLI error",
        });
        continue;
      }

      if (event.type === "result") {
        resultSeen = true;
        if (event.status === "error") {
          finalizeError(event.error?.message ?? "Gemini CLI turn failed");
        } else {
          finalizeSuccess(event.stats);
        }
      }
    }
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("exit", (code: number | null) => resolve(code));
    child.once("error", () => resolve(1));
  });

  if (session.abortController.signal.aborted) {
    state.child = null;
    clearTimeout(startupTimer);
    state.textBuffer = "";
    return;
  }

  if (!resultSeen) {
    const stderr = state.stderrBuf.trim().split("\n").filter(Boolean).pop();
    finalizeError(stderr || `Gemini CLI exited with code ${exitCode ?? "unknown"}`);
  }
}

export function createGeminiCliProvider(): SessionProvider {
  return {
    capabilities: GEMINI_CAPABILITIES,

    startTurn(ctx: TurnContext) {
      const { session, opts, profile: profileDef } = ctx;
      const isResume = !!opts.sessionId && !!getSession(opts.sessionId);
      const state: GeminiState = {
        sessionId: isResume && opts.sessionId ? opts.sessionId : null,
        model: opts.model ?? profileDef?.model ?? "auto-gemini-3",
        child: null,
        abortController: session.abortController,
        stderrBuf: "",
        textBuffer: "",
      };
      session._providerState = state;

      runTurn(ctx, state, session.initialContent, { isResume, skipPromptPersist: false }).catch((err) => {
        console.error(`[gemini-cli] startTurn error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
      });
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);

      if (session.status === "running" || session.status === "starting") {
        session.pendingMessages.push(content);
        return;
      }

      session.abortController = new AbortController();
      state.abortController = session.abortController;
      session.initialContent = content;
      session.preview = typeof content === "string" ? content.slice(0, 80) : "[content]";
      session.status = "running";
      session.turnStartedAt = Date.now();
      updateSessionStatus(session.sessionId, "running");

      runTurn(ctx, state, content, { isResume: true, skipPromptPersist: true }).catch((err) => {
        console.error(`[gemini-cli] sendMessage error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
      });
    },

    abort(session: ActiveSession) {
      const state = getState(session);
      if (state) {
        state.textBuffer = "";
      }
      state?.child?.kill("SIGTERM");
      state?.abortController.abort();
      session.abortController.abort();
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      if (!state) return;
      if (typeof config.model === "string" && config.model) {
        state.model = config.model;
      }
    },

    async dispose(session: ActiveSession) {
      const state = getState(session);
      if (!state) return;
      state.child?.kill("SIGTERM");
      state.abortController.abort();
      cleanupSettingsDir(state);
      session._providerState = null;
    },

    switchProfile(session: ActiveSession, ctx: TurnContext) {
      const state = getState(session);
      if (!state) return;
      state.model = ctx.opts.model ?? ctx.profile?.model ?? state.model;
      cleanupSettingsDir(state);
      state.settingsDir = buildGeminiSystemSettings(ctx, ctx.profile);
    },
  };
}
