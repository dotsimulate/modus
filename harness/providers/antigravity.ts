import {
  contentPreview,
  createPendingDispatchItem,
  type ActiveSession,
  type MessageContent,
} from "../session-manager";
import { getMaxSeq, getSession, updateSessionStatus } from "../db";
import {
  getGlobalConfig,
  type McpServerConfig,
  type PermissionPolicy,
} from "../profiles";
import { permissionPolicyNeedsApproval } from "../permission-policy";
import { resolveMcpServers } from "../mcp-config";
import { resolveSecret } from "../secrets";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { createSensitiveTempDirectory, removeSensitiveTempDirectory, writeSensitiveTempFile } from "../sensitive-temp";
import type { SessionProvider, TurnContext } from "./types";
import { ANTIGRAVITY_CAPABILITIES } from "./antigravity-capabilities";
import { resolveAntigravityExecutable } from "./antigravity-cli-runtime";
import { ensureAntigravityPlugin } from "./antigravity-plugin";
import { providerChildEnv } from "./child-env";
import { requireSupportedProfilePrompt } from "./profile-prompt-delivery";

type AntigravityProcess = {
  pid?: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
};

export type AntigravityProviderDependencies = {
  resolveExecutable?: () => string | null;
  ensurePlugin?: (executable: string) => Promise<void>;
  spawn?: (options: Record<string, any>) => AntigravityProcess;
  hookPollMs?: number;
};

type ObservedTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AntigravityState = {
  conversationId: string | null;
  requestedConversationId: string | null;
  model?: string;
  abortController: AbortController;
  proc: AntigravityProcess | null;
  hookDir: string | null;
  processedHookLines: number;
  observedTools: Map<string, ObservedTool>;
  protocolError: string | null;
};

type HookEvent = {
  kind: "pre-invocation" | "pre-tool" | "post-tool" | "stop";
  requestId?: string;
  input?: Record<string, any>;
};

const ANTIGRAVITY_BUILTINS = new Set(ANTIGRAVITY_CAPABILITIES.builtInTools);
const HEADLESS_UNSUPPORTED_TOOLS = new Set(["ask_question"]);

function getState(session: ActiveSession): AntigravityState {
  return session._providerState as AntigravityState;
}

function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  const imageCount = content.filter((block) => block.type === "image").length;
  if (imageCount > 0) {
    throw new Error("Antigravity CLI print mode does not document a non-interactive image attachment flag, so Modus will not silently discard or fake image input.");
  }
  return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

export function buildAntigravityArgs(options: {
  prompt: string;
  conversationId?: string | null;
  model?: string;
  additionalDirectories?: string[];
  sandbox?: boolean;
  mode?: "accept-edits" | "plan";
  printTimeout?: string;
}): string[] {
  const args = ["--print", options.prompt, "--print-timeout", options.printTimeout ?? "1h"];
  if (options.conversationId) args.push("--conversation", options.conversationId);
  if (options.model) args.push("--model", options.model);
  for (const directory of options.additionalDirectories ?? []) args.push("--add-dir", directory);
  args.push("--mode", options.mode ?? "accept-edits");
  if (options.sandbox !== undefined) args.push(`--sandbox=${options.sandbox}`);
  return args;
}

function antigravityControls(ctx: TurnContext): {
  sandbox?: boolean;
  mode?: "accept-edits" | "plan";
  printTimeout?: string;
} {
  const raw = ctx.opts.providerControls?.antigravity;
  if (!raw || typeof raw !== "object") return {};
  const controls = raw as Record<string, unknown>;
  return {
    ...(typeof controls.sandbox === "boolean" ? { sandbox: controls.sandbox } : {}),
    ...(controls.mode === "accept-edits" || controls.mode === "plan" ? { mode: controls.mode } : {}),
    ...(typeof controls.printTimeout === "string" && controls.printTimeout.trim()
      ? { printTimeout: controls.printTimeout.trim() }
      : {}),
  };
}

function resolveMcpValue(value: string, serverName: string): string | undefined {
  if (!value.startsWith("$") || value.length < 2) return value;
  const resolved = resolveSecret(value.slice(1));
  if (resolved !== undefined) return resolved;
  console.warn(`[antigravity] Missing secret ${value} for MCP server "${serverName}"`);
  return undefined;
}

function resolvedMcpEntries(
  values: Record<string, string>,
  serverName: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, resolveMcpValue(value, serverName)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
}

function resolveMcpConfig(serverName: string, config: McpServerConfig): McpServerConfig {
  if ("command" in config) {
    return {
      ...config,
      ...(config.env ? { env: resolvedMcpEntries(config.env, serverName) } : {}),
    };
  }
  return {
    ...config,
    ...(config.headers ? { headers: resolvedMcpEntries(config.headers, serverName) } : {}),
  };
}

function mergedMcpServers(ctx: TurnContext): Record<string, McpServerConfig> {
  const merged = resolveMcpServers({
    cwd: ctx.session.projectRoot ?? ctx.session.cwd,
    profileName: ctx.opts.profile,
    profile: ctx.profile,
    sessionServers: ctx.opts.mcpServers,
  }).servers;
  return Object.fromEntries(Object.entries(merged).map(([name, config]) => [name, resolveMcpConfig(name, config)]));
}

/**
 * Create the per-turn hook/IPC directory.
 *
 * This directory holds fully resolved MCP credentials (including the Modus
 * supervisor bearer), so it must be process-private rather than a predictable
 * path under the shared system temp root that any local user can read.
 */
function makeIpcDirectory(): string {
  return createSensitiveTempDirectory();
}

function cleanupIpcDirectory(directory: string | null): void {
  if (!directory) return;
  try {
    removeSensitiveTempDirectory(directory);
  } catch { /* best effort */ }
}

function toolKey(input: Record<string, any>): string {
  return `${input.conversationId ?? "unknown"}:${input.stepIdx ?? "unknown"}`;
}

function toolUseEvent(tool: ObservedTool) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: tool.id, name: tool.name, input: tool.input }] },
  };
}

function toolResultEvent(tool: ObservedTool, error?: string) {
  const content = error
    ? error
    : `Antigravity reported that ${tool.name} completed. Its JSON Hooks API does not expose the tool's stdout or return payload.`;
  return {
    type: "user",
    subtype: "tool_result",
    isSynthetic: true,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: tool.id, content, is_error: !!error }],
    },
  };
}

const ANTIGRAVITY_SHELL_TOOLS = new Set(["run_command"]);

export function needsApproval(policy: PermissionPolicy, toolName: string): boolean {
  return permissionPolicyNeedsApproval(policy, toolName, ANTIGRAVITY_SHELL_TOOLS);
}

function writePermissionResponse(
  state: AntigravityState,
  requestId: string,
  response: { behavior: "allow" | "deny"; message?: string },
): void {
  if (!state.hookDir) return;
  writeFileSync(join(state.hookDir, `${requestId}.response.json`), JSON.stringify(response), "utf8");
}

function handleHookEvent(ctx: TurnContext, state: AntigravityState, event: HookEvent): void {
  const input = event.input ?? {};
  const nativeId = typeof input.conversationId === "string" ? input.conversationId : null;
  if (nativeId) {
    if (state.requestedConversationId && nativeId !== state.requestedConversationId) {
      state.protocolError = `Antigravity resumed ${nativeId} instead of requested conversation ${state.requestedConversationId}; refusing a context-free continuation.`;
      try { state.proc?.kill(); } catch { /* best effort */ }
      return;
    }
    if (state.conversationId && state.conversationId !== nativeId) {
      state.protocolError = `Antigravity changed conversation identity from ${state.conversationId} to ${nativeId} during one Modus session.`;
      try { state.proc?.kill(); } catch { /* best effort */ }
      return;
    }
    if (!state.conversationId) {
      state.conversationId = nativeId;
      ctx.setProviderSessionId(nativeId);
    }
  }

  if (event.kind === "pre-tool") {
    const toolCall = input.toolCall ?? {};
    const name = typeof toolCall.name === "string" ? toolCall.name : "antigravity_tool";
    const args = toolCall.args && typeof toolCall.args === "object" ? toolCall.args as Record<string, unknown> : {};
    const key = toolKey(input);
    const observed: ObservedTool = {
      id: `agy-tool-${nativeId ?? ctx.session.sessionId}-${input.stepIdx ?? crypto.randomUUID()}`,
      name,
      input: args,
    };
    state.observedTools.set(key, observed);
    ctx.emitEvent(toolUseEvent(observed));

    if (!event.requestId) {
      state.protocolError = "Antigravity PreToolUse hook omitted its Modus request ID.";
      try { state.proc?.kill(); } catch { /* best effort */ }
      return;
    }
    if (HEADLESS_UNSUPPORTED_TOOLS.has(name)) {
      writePermissionResponse(state, event.requestId, {
        behavior: "deny",
        message: `${name} requires Antigravity's interactive TUI, and agy print mode exposes no documented response channel. Ask the user in the final response instead.`,
      });
      return;
    }
    const requestedTools = ctx.opts.tools ?? ctx.profile?.tools;
    const disallowedTools = ctx.opts.disallowedTools ?? ctx.profile?.disallowedTools ?? [];
    const blockedByList = disallowedTools.includes(name)
      || (Array.isArray(requestedTools) && ANTIGRAVITY_BUILTINS.has(name) && !requestedTools.includes(name));
    if (blockedByList) {
      writePermissionResponse(state, event.requestId, { behavior: "deny", message: `${name} is disabled by the active Modus profile.` });
      return;
    }

    const policy = ctx.opts.permissionPolicy ?? ctx.profile?.permissionPolicy ?? "bypass";
    if (!needsApproval(policy, name) || ctx.session.sessionApprovals.has(name)) {
      writePermissionResponse(state, event.requestId, { behavior: "allow" });
      return;
    }

    const requestId = event.requestId;
    ctx.emitEvent({
      type: "system",
      subtype: "permission_request",
      requestId,
      toolName: name,
      toolInput: args,
      toolUseID: observed.id,
      interactive: false,
      decisionReason: `${name} requires approval`,
    });
    ctx.session.pendingPermissions.set(requestId, {
      toolName: name,
      input: args,
      requestedAt: Date.now(),
      resolve: (response) => {
        try {
          writePermissionResponse(state, requestId, { behavior: response.behavior, message: response.message });
        } catch (error) {
          state.protocolError = `Could not answer Antigravity permission request: ${error instanceof Error ? error.message : String(error)}`;
          try { state.proc?.kill(); } catch { /* best effort */ }
        }
        ctx.emitEvent({ type: "system", subtype: "permission_resolved", requestId, behavior: response.behavior });
        ctx.session.pendingPermissions.delete(requestId);
      },
    });
    return;
  }

  if (event.kind === "post-tool") {
    const key = toolKey(input);
    const observed = state.observedTools.get(key);
    if (!observed) return;
    state.observedTools.delete(key);
    ctx.emitEvent(toolResultEvent(observed, typeof input.error === "string" && input.error ? input.error : undefined));
  }
}

function drainHookEvents(ctx: TurnContext, state: AntigravityState): void {
  if (!state.hookDir) return;
  const eventPath = join(state.hookDir, "events.jsonl");
  if (!existsSync(eventPath)) return;
  const content = readFileSync(eventPath, "utf8");
  const lines = content.split(/\r?\n/);
  const completeCount = content.endsWith("\n") ? lines.length - 1 : Math.max(0, lines.length - 1);
  for (let index = state.processedHookLines; index < completeCount; index++) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      handleHookEvent(ctx, state, JSON.parse(line) as HookEvent);
    } catch (error) {
      state.protocolError = `Could not process an Antigravity hook event: ${error instanceof Error ? error.message : String(error)}`;
      try { state.proc?.kill(); } catch { /* best effort */ }
    }
  }
  state.processedHookLines = completeCount;
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onText?: (chunk: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      result += text;
      if (text) onText?.(text);
    }
    const tail = decoder.decode();
    result += tail;
    if (tail) onText?.(tail);
    return result;
  } finally {
    reader.releaseLock();
  }
}

function assistantEvent(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function knownCliError(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`.trim();
  if (/please sign in|not signed in|authentication required|unauthenticated/i.test(combined)) {
    return "Antigravity authentication required. Run `agy` once in a terminal and complete Google Sign-In, then retry in Modus.";
  }
  return null;
}

async function runTurn(
  ctx: TurnContext,
  state: AntigravityState,
  content: MessageContent,
  options: { isResume: boolean; skipPromptPersist: boolean },
  deps: Required<AntigravityProviderDependencies>,
): Promise<void> {
  const { session } = ctx;
  let poll: ReturnType<typeof setInterval> | null = null;
  let procPid: number | null = null;
  try {
    requireSupportedProfilePrompt(ANTIGRAVITY_CAPABILITIES, ctx.profile);
    const executable = deps.resolveExecutable();
    if (!executable) {
      throw new Error("Google Antigravity CLI (`agy`) is not installed or not on PATH. Install it from https://antigravity.google/docs/cli-getting-started");
    }
    if (options.isResume && !state.requestedConversationId) {
      throw new Error("This Modus session has no saved Antigravity conversation UUID, so it cannot be resumed without inventing context.");
    }
    const input = contentToString(content);
    await deps.ensurePlugin(executable);
    if (state.abortController.signal.aborted || session.abortController.signal.aborted) {
      session.status = "idle";
      updateSessionStatus(session.sessionId, "idle");
      ctx.emitEvent({ type: "done" });
      return;
    }

    state.hookDir = makeIpcDirectory();
    state.processedHookLines = 0;
    state.protocolError = null;
    state.observedTools.clear();
    // Credential-bearing: written 0600 inside the private per-turn directory.
    const mcpConfigPath = writeSensitiveTempFile(
      state.hookDir,
      "mcp-servers.json",
      JSON.stringify(mergedMcpServers(ctx)),
    );
    if (!options.skipPromptPersist) {
      ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content } });
    }
    const unsupportedControls: string[] = [];
    if (ctx.opts.effort ?? ctx.profile?.effort) unsupportedControls.push("effort");
    if (ctx.opts.maxTurns ?? ctx.profile?.maxTurns) unsupportedControls.push("maxTurns");
    if (unsupportedControls.length > 0) {
      ctx.emitEvent({
        type: "system",
        subtype: "provider_message",
        content: `Antigravity CLI exposes no documented headless ${unsupportedControls.join(" or ")} flag; Modus is leaving ${unsupportedControls.join(" and ")} unset rather than simulating enforcement.`,
      });
    }
    ctx.emitEvent({
      type: "system",
      subtype: "init",
      session_id: session.sessionId,
      provider_session_id: state.requestedConversationId ?? undefined,
      model: ctx.opts.model ?? ctx.profile?.model ?? state.model ?? "Gemini 3.5 Flash",
      config: {
        provider: "antigravity",
        model: ctx.opts.model ?? ctx.profile?.model ?? state.model ?? "Gemini 3.5 Flash",
        effort: "",
        toolStates: ctx.opts.toolStates ?? {},
        providerControls: ctx.opts.providerControls ?? {},
      },
      cwd: session.cwd,
      additionalDirectories: session.additionalDirectories,
      loadProjectSettings: true,
    });
    session.status = "running";
    updateSessionStatus(session.sessionId, "running");

    const controls = antigravityControls(ctx);
    const args = buildAntigravityArgs({
      prompt: input,
      conversationId: options.isResume ? state.requestedConversationId : null,
      model: ctx.opts.model ?? ctx.profile?.model ?? state.model ?? "Gemini 3.5 Flash",
      additionalDirectories: session.additionalDirectories,
      ...controls,
    });
    const proc = deps.spawn({
      cmd: [executable, ...args],
      cwd: session.cwd ?? ctx.opts.cwd ?? process.cwd(),
      env: {
        ...providerChildEnv(),
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        MODUS_ANTIGRAVITY_HOOK_DIR: state.hookDir,
        MODUS_ANTIGRAVITY_MCP_CONFIG_PATH: mcpConfigPath,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      windowsHide: true,
    });
    state.proc = proc;
    procPid = typeof proc.pid === "number" ? proc.pid : null;
    if (procPid != null) session.osPids.add(procPid);
    poll = setInterval(() => drainHookEvents(ctx, state), deps.hookPollMs);

    let fullText = "";
    const stdoutPromise = readStream(proc.stdout, (chunk) => {
      session.lastEventAt = Date.now();
      fullText += chunk;
      session.lastAssistantText = fullText.slice(-200);
      ctx.broadcastEvent({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: chunk } },
        provider: "antigravity",
        fullText,
      });
    });
    const stderrPromise = readStream(proc.stderr);
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (poll) { clearInterval(poll); poll = null; }
    drainHookEvents(ctx, state);

    if (state.abortController.signal.aborted || session.abortController.signal.aborted) {
      session.status = "idle";
      updateSessionStatus(session.sessionId, "idle");
      ctx.emitEvent({ type: "done" });
      return;
    }
    if (state.protocolError) throw new Error(state.protocolError);
    const cliError = knownCliError(stdout, stderr);
    if (cliError) throw new Error(cliError);
    if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `agy exited with code ${exitCode}`);
    if (!state.conversationId) {
      throw new Error("Antigravity completed without reporting its native conversation UUID through the documented hook interface; refusing to create a session that cannot be resumed safely.");
    }
    if (options.isResume && state.conversationId !== state.requestedConversationId) {
      throw new Error(`Antigravity did not confirm resume target ${state.requestedConversationId}.`);
    }

    const text = stdout.trim();
    if (!text) throw new Error("Antigravity completed without a printable assistant response.");
    ctx.emitEvent(assistantEvent(text));
    ctx.emitEvent({
      type: "result",
      subtype: "success",
      result: text,
      harness_duration_ms: Date.now() - session.turnStartedAt,
      num_turns: 1,
      total_cost_usd: 0,
    });
    session.numTurns += 1;
    session.status = "idle";
    state.requestedConversationId = state.conversationId;
    ctx.updateSessionDb({
      status: "idle",
      messageCount: session.numTurns * 2,
      costUsd: session.costUsd,
      lastPrompt: session.preview,
      lastResponse: text.slice(0, 200),
    });
  } catch (error) {
    const wasAborted = state.abortController.signal.aborted || session.abortController.signal.aborted;
    if (wasAborted) {
      session.status = "idle";
      updateSessionStatus(session.sessionId, "idle");
      ctx.emitEvent({ type: "done" });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    session.status = "error";
    session.error = message;
    updateSessionStatus(session.sessionId, "error");
    ctx.emitEvent({
      type: "result",
      subtype: "error",
      error: message,
      harness_duration_ms: Date.now() - session.turnStartedAt,
      num_turns: 1,
      total_cost_usd: 0,
    });
    ctx.emitEvent({ type: "done" });
  } finally {
    if (poll) clearInterval(poll);
    state.proc = null;
    if (procPid != null) session.osPids.delete(procPid);
    for (const [requestId, pending] of session.pendingPermissions) {
      pending.resolve({ behavior: "deny", message: "Antigravity turn ended before permission was resolved." });
      session.pendingPermissions.delete(requestId);
    }
    const hookDir = state.hookDir;
    state.hookDir = null;
    cleanupIpcDirectory(hookDir);
  }

  if (session.status === "idle" && session.pendingDispatch.length > 0) {
    const next = session.pendingDispatch.shift()!.content;
    session.initialContent = next;
    session.preview = contentPreview(next);
    session.abortController = new AbortController();
    state.abortController = session.abortController;
    session.status = "running";
    session.turnStartedAt = Date.now();
    void runTurn(ctx, state, next, { isResume: true, skipPromptPersist: true }, deps);
  }
}

export function createAntigravityProvider(overrides: AntigravityProviderDependencies = {}): SessionProvider {
  const deps: Required<AntigravityProviderDependencies> = {
    resolveExecutable: overrides.resolveExecutable ?? (() => resolveAntigravityExecutable()),
    ensurePlugin: overrides.ensurePlugin ?? ensureAntigravityPlugin,
    spawn: overrides.spawn ?? ((options) => Bun.spawn(options as any) as unknown as AntigravityProcess),
    hookPollMs: overrides.hookPollMs ?? 50,
  };
  return {
    capabilities: ANTIGRAVITY_CAPABILITIES,

    startTurn(ctx: TurnContext) {
      const { session, opts, profile } = ctx;
      const existing = opts.sessionId ? getSession(opts.sessionId) : null;
      const isResume = !!opts.sessionId && !!existing && (existing.message_count > 0 || getMaxSeq(opts.sessionId) > 0);
      const nativeId = isResume ? session.providerSessionId : null;
      const state: AntigravityState = {
        conversationId: nativeId,
        requestedConversationId: nativeId,
        model: opts.model ?? profile?.model ?? "Gemini 3.5 Flash",
        abortController: session.abortController,
        proc: null,
        hookDir: null,
        processedHookLines: 0,
        observedTools: new Map(),
        protocolError: null,
      };
      session._providerState = state;
      void runTurn(ctx, state, session.initialContent, { isResume, skipPromptPersist: false }, deps);
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);
      if (session.status === "running" || session.status === "starting") {
        session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
        return;
      }
      session.abortController = new AbortController();
      state.abortController = session.abortController;
      state.requestedConversationId = state.conversationId ?? session.providerSessionId;
      session.initialContent = content;
      session.preview = contentPreview(content);
      session.status = "running";
      session.turnStartedAt = Date.now();
      updateSessionStatus(session.sessionId, "running");
      void runTurn(ctx, state, content, { isResume: true, skipPromptPersist: true }, deps);
    },

    abort(session: ActiveSession) {
      const state = getState(session);
      try { state.abortController.abort(); } catch { /* best effort */ }
      try { session.abortController.abort(); } catch { /* best effort */ }
      try { state.proc?.kill(); } catch { /* best effort */ }
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      if (typeof config.model === "string") state.model = config.model || undefined;
    },

    async dispose(session: ActiveSession) {
      const state = getState(session);
      try { state?.abortController.abort(); } catch { /* best effort */ }
      try { state?.proc?.kill(); } catch { /* best effort */ }
      cleanupIpcDirectory(state?.hookDir ?? null);
      session._providerState = null;
    },
  };
}
