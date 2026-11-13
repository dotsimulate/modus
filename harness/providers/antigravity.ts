import { isAbsolute } from "path";
import {
  contentPreview,
  createPendingDispatchItem,
  type ActiveSession,
  type MessageContent,
} from "../session-manager";
import { getMaxSeq, getSession, updateSessionStatus } from "../db";
import type { PermissionPolicy } from "../profiles";
import { permissionPolicyNeedsApproval } from "../permission-policy";
import { resolveMcpServers } from "../mcp-config";
import { resolveSecret } from "../secrets";
import type { SessionProvider, TurnContext } from "./types";
import { GrokAcpClient, type JsonRpcId } from "./grok-build-acp";
import { ANTIGRAVITY_CAPABILITIES } from "./antigravity-capabilities";
import {
  ANTIGRAVITY_INITIALIZE_PARAMS,
  ANTIGRAVITY_VERIFICATION_MESSAGE,
  antigravityEnvironment,
  disableLegacyModusPlugin,
  isAntigravityVerificationNotice,
  resolveAntigravityCommand,
  resolveAntigravityModelId,
  type AntigravityCommand,
  type AntigravityModelEntry,
} from "./antigravity-runtime";
import { requireSupportedProfilePrompt } from "./profile-prompt-delivery";
import { resolveCli } from "./resolve-cli";
import { claudeToolResultContent, peelToolResultImages } from "../tool-result-images";

/** ACP session modes `agy acp` offers. `default` asks Modus before edits and commands. */
export type AntigravityMode = "default" | "accept-edits" | "auto" | "plan";

type AntigravityControls = {
  mode?: AntigravityMode;
  sandbox?: boolean;
};

type ToolState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  resultEmitted: boolean;
};

type AntigravityState = {
  client: GrokAcpClient | null;
  pid: number | null;
  providerSessionId: string | null;
  abortController: AbortController;
  turnActive: boolean;
  disposed: boolean;
  /** The round streaming now; finalized before each tool call and at turn end. */
  text: string;
  thinking: string;
  /** Every message chunk of the turn, for the result and the session preview. */
  turnText: string;
  tools: Map<string, ToolState>;
  pendingRpcPermissions: Map<string, JsonRpcId>;
  /** Model entries the live ACP session offers; refreshed on every connect. */
  availableModels: AntigravityModelEntry[];
  currentModelId?: string;
  model?: string;
  effort?: string;
  restartBeforeNextTurn: boolean;
  command: AntigravityCommand;
};

export function ownsAntigravityClientGeneration(
  currentClient: unknown,
  currentAbortController: AbortController,
  expectedClient: unknown,
  expectedAbortController: AbortController,
): boolean {
  return currentClient === expectedClient && currentAbortController === expectedAbortController;
}

function getState(session: ActiveSession): AntigravityState {
  const state = session._providerState as AntigravityState | null;
  if (!state) throw new Error("Antigravity session state is unavailable");
  return state;
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function numberValue(...values: unknown[]): number {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** `session/prompt` returns `usage` with camelCase token counts; plan usage has no dollar cost. */
export function antigravityUsage(result: any): { input: number; output: number; total: number } {
  const usage = asObject(result?.usage ?? result?._meta?.usage);
  const input = numberValue(usage.inputTokens, usage.input_tokens);
  const output = numberValue(usage.outputTokens, usage.output_tokens);
  return { input, output, total: numberValue(usage.totalTokens, usage.total_tokens, input + output) };
}

function controlsFrom(ctx: TurnContext): AntigravityControls {
  const controls = ctx.session._configOverrides.providerControls ?? ctx.opts.providerControls ?? ctx.profile?.providerControls;
  return asObject(asObject(controls).antigravity) as AntigravityControls;
}

function normalizedSet(values: Iterable<string>): Set<string> {
  return new Set(Array.from(values, (value) => value.toLowerCase()));
}

const ANTIGRAVITY_SHELL_TOOLS = new Set(["run_command"]);

export function needsApproval(policy: PermissionPolicy, toolName: string): boolean {
  return permissionPolicyNeedsApproval(policy, toolName, ANTIGRAVITY_SHELL_TOOLS);
}

export function toolDecision(ctx: TurnContext, toolName: string): "allow" | "ask" | "deny" {
  const lower = toolName.toLowerCase();
  const configuredTools = ctx.session._configOverrides.tools ?? ctx.opts.tools ?? ctx.profile?.tools;
  if (configuredTools?.length && !normalizedSet(configuredTools).has(lower)) return "deny";
  const disallowed = normalizedSet([
    ...(ctx.profile?.disallowedTools ?? []),
    ...(ctx.opts.disallowedTools ?? []),
    ...(ctx.session._configOverrides.disallowedTools ?? []),
  ]);
  const toolStates = ctx.session._configOverrides.toolStates ?? ctx.opts.toolStates;
  const disabled = Object.entries(toolStates ?? {}).some(([name, state]) => name.toLowerCase() === lower && state === "off");
  if (disallowed.has(lower) || disabled) return "deny";
  if (ctx.session.sessionApprovals.has(toolName)) return "allow";

  const policy: PermissionPolicy = ctx.opts.permissionPolicy ?? ctx.profile?.permissionPolicy ?? "bypass";
  return needsApproval(policy, toolName) ? "ask" : "allow";
}

function pickPermissionOption(options: any[], decision: "allow" | "deny", persistent: boolean): any | undefined {
  const wanted = decision === "allow"
    ? (persistent ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"])
    : (persistent ? ["reject_always", "reject_once"] : ["reject_once", "reject_always"]);
  for (const kind of wanted) {
    const option = options.find((candidate) => candidate?.kind === kind);
    if (option) return option;
  }
  return undefined;
}

function contentBlocks(content: MessageContent): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((block) => block.type === "image"
    ? { type: "image", data: block.source.data, mimeType: block.source.media_type }
    : { type: "text", text: block.text });
}

function resolveMcpValue(value: string): string | undefined {
  return value.startsWith("$") ? resolveSecret(value.slice(1)) : value;
}

function resolvedMcpEntries(
  entries: Record<string, string> | undefined,
  serverName: string,
): Array<{ name: string; value: string }> {
  const resolved: Array<{ name: string; value: string }> = [];
  for (const [name, configuredValue] of Object.entries(entries ?? {})) {
    const value = resolveMcpValue(configuredValue);
    if (value === undefined) {
      console.warn(`[antigravity] omitted unresolved MCP secret for server "${serverName}" field "${name}"`);
      continue;
    }
    resolved.push({ name, value });
  }
  return resolved;
}

function mcpServers(ctx: TurnContext): any[] {
  const cwd = ctx.session.cwd ?? ctx.opts.cwd;
  const merged = resolveMcpServers({
    cwd: ctx.session.projectRoot ?? cwd,
    profileName: ctx.opts.profile,
    profile: ctx.profile,
    sessionServers: ctx.opts.mcpServers,
  }).servers;
  return Object.entries(merged).map(([name, config]) => {
    if (config.type === "http" || config.type === "sse") {
      return {
        type: config.type,
        name,
        url: config.url,
        headers: resolvedMcpEntries(config.headers, name),
      };
    }
    const resolved = isAbsolute(config.command) ? config.command : (resolveCli(config.command) ?? config.command);
    return {
      type: "stdio",
      name,
      command: resolved,
      args: config.args ?? [],
      env: resolvedMcpEntries(config.env, name),
    };
  });
}

export function antigravityLaunchArgs(controls: AntigravityControls): string[] {
  return ["acp", ...(controls.sandbox ? ["--sandbox"] : [])];
}

/** ACP `session/new` / `session/load` metadata carrying the appended profile prompt. */
export function antigravitySessionMeta(promptText: string | undefined): Record<string, unknown> | undefined {
  return promptText ? { antigravity: { systemPrompt: { append: promptText } } } : undefined;
}

function toolNameFromCall(call: any): string {
  const explicit = call?.name ?? call?._meta?.toolName;
  if (typeof explicit === "string" && explicit) return explicit;
  const title = typeof call?.title === "string" ? call.title : "";
  return title || (typeof call?.kind === "string" && call.kind ? call.kind : "AntigravityTool");
}

/**
 * Antigravity names MCP tools `mcp_<server>_<tool>` and adds its own
 * `toolSummary` argument. Collapse the Modus move tool to `modus_submit` and drop
 * the summary so move tool-views and transcripts see the input the server got.
 */
export function normalizeAntigravityToolCall(toolCall: any): { name: string; input: Record<string, unknown> } {
  const rawName = toolNameFromCall(toolCall);
  const input = { ...asObject(toolCall?.rawInput ?? toolCall?.raw_input ?? toolCall?.args) };
  if (rawName.startsWith("mcp_")) delete input.toolSummary;
  const name = rawName.startsWith("mcp_") && rawName.endsWith("modus_submit") ? "modus_submit" : rawName;
  return { name, input };
}

function assistantEvent(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function thinkingEvent(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } };
}

/**
 * ACP streams thought and message chunks with no event that closes them, so the
 * round is finalized before the next tool call and at turn end.
 */
function flushAssistantRound(ctx: TurnContext, state: AntigravityState): void {
  if (state.thinking) ctx.emitEvent(thinkingEvent(state.thinking));
  if (state.text) ctx.emitEvent(assistantEvent(state.text));
  state.thinking = "";
  state.text = "";
}

function emitToolStart(ctx: TurnContext, state: AntigravityState, toolCall: any): ToolState {
  const id = String(toolCall.toolCallId ?? toolCall.tool_call_id ?? `antigravity-tool-${Date.now()}`);
  const existing = state.tools.get(id);
  if (existing) return existing;
  flushAssistantRound(ctx, state);
  const normalized = normalizeAntigravityToolCall(toolCall);
  const tool: ToolState = { id, name: normalized.name, input: normalized.input, resultEmitted: false };
  state.tools.set(id, tool);
  ctx.emitEvent({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name: tool.name, input: tool.input }] },
  });
  return tool;
}

/**
 * Antigravity sends tool output only for some tools: file edits carry a `diff`
 * content block, MCP calls carry nothing. Fall back to a plain status line.
 */
export function antigravityToolOutput(update: any): string | Array<Record<string, unknown>> {
  const raw = update?.rawOutput ?? update?.raw_output;
  if (raw != null && !(typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0)) {
    const content = claudeToolResultContent(raw);
    if (content !== "") return content;
  }
  const blocks = Array.isArray(update?.content) ? update.content : [];
  const diffs = blocks.filter((block: any) => block?.type === "diff");
  if (diffs.length) {
    return diffs.map((block: any) => `${block.path ?? "file"}\n${block.newText ?? ""}`).join("\n\n");
  }
  if (blocks.length) {
    const peeled = claudeToolResultContent(blocks);
    if (peeled !== "") return peeled;
  }
  if (raw != null) {
    const text = peelToolResultImages(raw).text;
    if (text) return text;
  }
  return stringify(update?.status === "failed" ? "tool call failed" : "tool call completed");
}

function handleUpdate(ctx: TurnContext, state: AntigravityState, params: any): void {
  const update = params?.update ?? params;
  const type = update?.sessionUpdate ?? update?.session_update;
  // Mode changes matter even between turns; everything else belongs to a turn
  // (session/load also replays history as updates, which must not re-render).
  if (type === "current_mode_update" && typeof update.currentModeId === "string") {
    ctx.notifyConfigChange({ providerControls: { antigravity: { ...controlsFrom(ctx), mode: update.currentModeId } } });
    return;
  }
  if (!state.turnActive) return;
  ctx.session.lastEventAt = Date.now();
  if (type === "agent_message_chunk") {
    const text = update?.content?.text;
    if (typeof text !== "string") return;
    state.text += text;
    state.turnText += text;
    ctx.session.lastAssistantText = state.turnText.slice(-200);
    ctx.emitEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      provider: "antigravity",
      fullText: state.text,
    });
    return;
  }
  if (type === "agent_thought_chunk") {
    const thinking = update?.content?.text;
    if (typeof thinking !== "string") return;
    state.thinking += thinking;
    ctx.emitEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
      provider: "antigravity",
      fullThinking: state.thinking,
    });
    return;
  }
  if (type === "tool_call" || type === "tool_call_update") {
    const tool = emitToolStart(ctx, state, update);
    const status = update.status;
    if (!tool.resultEmitted && (status === "completed" || status === "failed")) {
      tool.resultEmitted = true;
      ctx.emitEvent({
        type: "user",
        subtype: "tool_result",
        isSynthetic: true,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: tool.id,
            content: antigravityToolOutput(update),
            is_error: status === "failed",
          }],
        },
      });
    }
    return;
  }
  if (type === "plan") {
    ctx.emitEvent({ type: "system", subtype: "plan", plan: update.entries ?? update.plan ?? [] });
  }
}

function handlePermission(
  ctx: TurnContext,
  state: AntigravityState,
  client: GrokAcpClient,
  rpcId: JsonRpcId,
  params: any,
): void {
  if (params?.sessionId !== state.providerSessionId) {
    try { client.respond(rpcId, { outcome: { outcome: "cancelled" } }); } catch {}
    return;
  }
  const call = params?.toolCall ?? {};
  const { name: toolName, input } = normalizeAntigravityToolCall(call);
  const options = Array.isArray(params?.options) ? params.options : [];
  const decision = toolDecision(ctx, toolName);
  if (decision !== "ask") {
    const option = pickPermissionOption(options, decision, false);
    try {
      client.respond(rpcId, option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } });
    } catch {}
    return;
  }

  const requestId = `antigravity-permission-${String(rpcId)}`;
  state.pendingRpcPermissions.set(requestId, rpcId);
  ctx.session.pendingPermissions.set(requestId, {
    toolName,
    input,
    requestedAt: Date.now(),
    resolve: (response) => {
      state.pendingRpcPermissions.delete(requestId);
      ctx.session.pendingPermissions.delete(requestId);
      const persistent = response.behavior === "allow" && ctx.session.sessionApprovals.has(toolName);
      const option = pickPermissionOption(options, response.behavior, persistent);
      try {
        client.respond(rpcId, option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } });
      } catch {}
      ctx.emitEvent({ type: "system", subtype: "permission_resolved", requestId, behavior: response.behavior });
    },
  });
  ctx.emitEvent({
    type: "system",
    subtype: "permission_request",
    requestId,
    toolName,
    input,
    interactive: true,
  });
}

function recordSessionModels(state: AntigravityState, result: any): void {
  const models = result?.models;
  if (Array.isArray(models?.availableModels)) {
    state.availableModels = models.availableModels
      .filter((entry: any) => typeof entry?.modelId === "string")
      .map((entry: any) => ({ modelId: entry.modelId, name: typeof entry.name === "string" ? entry.name : undefined }));
  }
  if (typeof models?.currentModelId === "string") state.currentModelId = models.currentModelId;
}

async function connect(ctx: TurnContext, state: AntigravityState, resume: boolean): Promise<void> {
  if (state.client?.running && !state.restartBeforeNextTurn) return;
  if (state.client) {
    const previous = state.client;
    await previous.close();
    if (state.client === previous) state.client = null;
  }
  const cwd = ctx.session.cwd ?? ctx.opts.cwd ?? process.cwd();
  const controls = controlsFrom(ctx);
  const prompt = requireSupportedProfilePrompt(ANTIGRAVITY_CAPABILITIES, ctx.profile);
  const env = antigravityEnvironment(ctx.profile?.env);
  const client = new GrokAcpClient({
    executable: state.command.executable,
    args: [...state.command.prefixArgs, ...antigravityLaunchArgs(controls)],
    cwd,
    env,
    sensitiveValues: [env.GEMINI_API_KEY, env.GOOGLE_API_KEY],
    label: "Antigravity ACP",
  });
  state.client = client;
  state.restartBeforeNextTurn = false;
  client.onNotification((method, params) => {
    if (state.client !== client) return;
    if (method === "session/update") handleUpdate(ctx, state, params);
  });
  client.onRequest((id, method, params) => {
    if (state.client !== client) {
      try { client.respondError(id, -32000, "Provider client was replaced"); } catch {}
      return;
    }
    if (method === "session/request_permission") return handlePermission(ctx, state, client, id, params);
    client.respondError(id, -32601, `Unsupported client method: ${method}`);
  });
  let clientPid: number | null = null;
  client.onClose(() => {
    if (clientPid != null) ctx.session.osPids.delete(clientPid);
    if (state.client === client) {
      state.client = null;
      if (state.pid === clientPid) state.pid = null;
    }
  });
  client.start();
  clientPid = client.pid ?? null;
  state.pid = clientPid;
  if (clientPid != null) ctx.session.osPids.add(clientPid);

  // agy keeps its own Google sign-in; ACP lists auth methods even when signed
  // in, so Modus never calls `authenticate` and never drives an OAuth flow.
  await client.request("initialize", ANTIGRAVITY_INITIALIZE_PARAMS, 60_000);

  const resolvedServers = mcpServers(ctx);
  client.addSensitiveValues(resolvedServers.flatMap((server) => [
    ...(server.headers ?? []), ...(server.env ?? []),
  ].map((entry: { value: string }) => entry.value)));
  const meta = antigravitySessionMeta(prompt?.text);
  const sessionParams = {
    cwd,
    ...(ctx.session.additionalDirectories?.length ? { additionalDirectories: ctx.session.additionalDirectories } : {}),
    mcpServers: resolvedServers,
    ...(meta ? { _meta: meta } : {}),
  };
  let created: any;
  if (resume && state.providerSessionId) {
    created = await client.request("session/load", { ...sessionParams, sessionId: state.providerSessionId }, 60_000);
    if (created?.sessionId && created.sessionId !== state.providerSessionId) {
      throw new Error(`Antigravity refused resume target ${state.providerSessionId} and returned ${created.sessionId}`);
    }
  } else {
    created = await client.request("session/new", sessionParams, 60_000);
    const providerSessionId = created?.sessionId;
    if (typeof providerSessionId !== "string" || !providerSessionId) throw new Error("Antigravity did not return a session ID");
    state.providerSessionId = providerSessionId;
    ctx.setProviderSessionId(providerSessionId);
  }
  recordSessionModels(state, created);
  if (controls.mode && state.providerSessionId) {
    await client.request("session/set_mode", { sessionId: state.providerSessionId, modeId: controls.mode }, 30_000);
  }
}

/** Apply the requested model and thinking level before each turn. */
async function applyModel(client: GrokAcpClient, state: AntigravityState): Promise<void> {
  if (!state.providerSessionId) return;
  const requested = state.model ?? (state.effort ? state.currentModelId : undefined);
  if (!requested) return;
  const modelId = resolveAntigravityModelId(state.availableModels, requested, state.effort);
  if (!modelId) {
    const offered = state.availableModels.map((entry) => entry.modelId).join(", ");
    throw new Error(`Antigravity does not offer model "${requested}" on this account.${offered ? ` Available: ${offered}.` : ""}`);
  }
  if (modelId === state.currentModelId) return;
  await client.request("session/set_model", { sessionId: state.providerSessionId, modelId }, 30_000);
  state.currentModelId = modelId;
}

function emitInit(ctx: TurnContext, state: AntigravityState): void {
  const model = state.currentModelId ?? state.model ?? ctx.opts.model ?? ctx.profile?.model ?? "";
  ctx.emitEvent({
    type: "system",
    subtype: "init",
    // The Modus session id, not the ACP one: the UI rekeys a transcript when
    // init.session_id differs from its store key.
    session_id: ctx.session.sessionId,
    model,
    config: {
      provider: "antigravity",
      model,
      effort: state.effort ?? ctx.opts.effort ?? ctx.profile?.effort ?? "",
      maxTurns: ctx.session._configOverrides.maxTurns ?? ctx.opts.maxTurns,
      toolStates: ctx.session._configOverrides.toolStates ?? ctx.opts.toolStates ?? {},
      providerControls: ctx.session._configOverrides.providerControls ?? ctx.opts.providerControls ?? {},
    },
    cwd: ctx.session.cwd,
    additionalDirectories: ctx.session.additionalDirectories,
    loadProjectSettings: true,
  });
}

function emitTurnError(ctx: TurnContext, message: string): void {
  const { session } = ctx;
  session.status = "error";
  session.error = message;
  updateSessionStatus(session.sessionId, "error");
  ctx.emitEvent({
    type: "result",
    subtype: "error",
    error: message,
    harness_duration_ms: Date.now() - session.turnStartedAt,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    num_turns: 0,
    total_cost_usd: 0,
  });
  ctx.emitEvent({ type: "done" });
}

async function runTurn(
  ctx: TurnContext,
  state: AntigravityState,
  content: MessageContent,
  options: { resume: boolean },
  cleanupLegacyPlugin: ((executable: string) => Promise<void>) | undefined,
): Promise<void> {
  const { session } = ctx;
  const turnAbortController = state.abortController;
  let turnClient: GrokAcpClient | null = null;
  try {
    if (cleanupLegacyPlugin) await cleanupLegacyPlugin(state.command.executable);
    await connect(ctx, state, options.resume);
    turnClient = state.client;
    if (!turnClient) throw new Error("Antigravity client closed during connection");
    await applyModel(turnClient, state);
    // The harness keeps only a queue-time row; this is the message's transcript turn.
    ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content } });
    emitInit(ctx, state);
    state.turnActive = true;
    state.text = "";
    state.thinking = "";
    state.turnText = "";
    state.tools.clear();
    session.status = "running";
    updateSessionStatus(session.sessionId, "running");
    const result = await turnClient.request("session/prompt", {
      sessionId: state.providerSessionId,
      prompt: contentBlocks(content),
    }, 24 * 60 * 60 * 1_000);
    if (turnAbortController.signal.aborted || result?.stopReason === "cancelled") {
      flushAssistantRound(ctx, state);
      session.status = "idle";
      updateSessionStatus(session.sessionId, "idle");
      ctx.emitEvent({ type: "done" });
      return;
    }
    flushAssistantRound(ctx, state);
    if (state.tools.size === 0 && isAntigravityVerificationNotice(state.turnText)) {
      emitTurnError(ctx, ANTIGRAVITY_VERIFICATION_MESSAGE);
      return;
    }
    const usage = antigravityUsage(result);
    ctx.emitEvent({
      type: "result",
      subtype: "success",
      result: state.turnText,
      stop_reason: result?.stopReason,
      harness_duration_ms: Date.now() - session.turnStartedAt,
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.total,
      num_turns: 1,
      total_cost_usd: 0,
    });
    session.numTurns += 1;
    session.status = "idle";
    ctx.updateSessionDb({
      status: "idle",
      messageCount: (session.exchangeCount + 1) * 2,
      costUsd: session.costUsd,
      lastPrompt: session.preview,
      lastResponse: state.turnText.slice(0, 200),
    });
    ctx.emitEvent({ type: "done" });
  } catch (error) {
    if (turnAbortController.signal.aborted) {
      session.status = "idle";
      updateSessionStatus(session.sessionId, "idle");
      ctx.emitEvent({ type: "done" });
      return;
    }
    emitTurnError(ctx, error instanceof Error ? error.message : String(error));
    const failedClient = turnClient ?? state.client;
    await failedClient?.close();
  } finally {
    if (state.abortController === turnAbortController) state.turnActive = false;
  }

  if (!state.disposed && session.status === "idle" && session.pendingDispatch.length) {
    const next = session.pendingDispatch.shift()!.content;
    session.initialContent = next;
    session.preview = contentPreview(next);
    session.abortController = new AbortController();
    state.abortController = session.abortController;
    session.turnStartedAt = Date.now();
    void runTurn(ctx, state, next, { resume: true }, cleanupLegacyPlugin);
  }
}

/**
 * Names the usual cause (a PATH the running app has not picked up) and the
 * override that skips the search, since this string is the whole diagnosis.
 */
export const ANTIGRAVITY_CLI_MISSING =
  "Antigravity CLI (`agy`) was not found. Install it, run `agy` once to sign in with Google, "
  + "then restart Modus so it picks up the new PATH — or set ANTIGRAVITY_CLI_PATH to the executable's full path.";

/**
 * Fail the turn before it starts. `broadcastEvent` with `type: "error"` is what
 * the session manager persists; a pre-flight failure has no live subscriber yet.
 */
function markUnavailable(ctx: TurnContext, reason: string): void {
  const { session } = ctx;
  console.error(`[antigravity] ${reason}`);
  session.status = "error";
  session.error = reason;
  updateSessionStatus(session.sessionId, "error");
  ctx.broadcastEvent({ type: "error", error: reason });
  ctx.emitEvent({ type: "done" });
}

export function createAntigravityProvider(options?: {
  command?: AntigravityCommand;
  /** Test seam: exercise the not-found branch without depending on the host's PATH. */
  resolveCommand?: () => AntigravityCommand | null;
  /** Defaults to the real legacy-plugin check unless a fixed test command is injected. */
  cleanupLegacyPlugin?: (executable: string) => Promise<void>;
}): SessionProvider {
  const cleanupLegacyPlugin = options?.cleanupLegacyPlugin
    ?? (options?.command ? undefined : (executable: string) => disableLegacyModusPlugin(executable));
  return {
    capabilities: ANTIGRAVITY_CAPABILITIES,

    startTurn(ctx) {
      const command = options?.command ?? (options?.resolveCommand ?? resolveAntigravityCommand)();
      if (!command) {
        markUnavailable(ctx, ANTIGRAVITY_CLI_MISSING);
        return;
      }
      const existing = ctx.opts.sessionId ? getSession(ctx.opts.sessionId) : null;
      const resume = !!ctx.opts.sessionId && !!existing && (existing.message_count > 0 || getMaxSeq(ctx.opts.sessionId) > 0);
      if (resume && !ctx.session.providerSessionId) {
        markUnavailable(
          ctx,
          "This Modus session has no stored Antigravity session ID, so it cannot be resumed without losing context.",
        );
        return;
      }
      const state: AntigravityState = {
        client: null,
        pid: null,
        providerSessionId: resume ? ctx.session.providerSessionId : null,
        abortController: ctx.session.abortController,
        turnActive: false,
        disposed: false,
        text: "",
        thinking: "",
        turnText: "",
        tools: new Map(),
        pendingRpcPermissions: new Map(),
        availableModels: [],
        model: ctx.opts.model ?? ctx.profile?.model,
        effort: ctx.opts.effort ?? ctx.profile?.effort,
        restartBeforeNextTurn: false,
        command,
      };
      ctx.session._providerState = state;
      void runTurn(ctx, state, ctx.session.initialContent, { resume }, cleanupLegacyPlugin);
    },

    sendMessage(ctx, content) {
      const state = getState(ctx.session);
      if (state.turnActive || ctx.session.status === "starting" || ctx.session.status === "running") {
        ctx.session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
        return;
      }
      ctx.session.abortController = new AbortController();
      state.abortController = ctx.session.abortController;
      ctx.session.initialContent = content;
      ctx.session.preview = contentPreview(content);
      ctx.session.turnStartedAt = Date.now();
      void runTurn(ctx, state, content, { resume: true }, cleanupLegacyPlugin);
    },

    abort(session) {
      const state = getState(session);
      const client = state.client;
      const abortController = state.abortController;
      for (const requestId of state.pendingRpcPermissions.keys()) {
        session.pendingPermissions.get(requestId)?.resolve({ behavior: "deny", message: "Turn cancelled" });
      }
      try { abortController.abort(); } catch {}
      try { session.abortController.abort(); } catch {}
      if (state.providerSessionId) {
        try { client?.notify("session/cancel", { sessionId: state.providerSessionId }); } catch {}
      }
      const timer = setTimeout(() => {
        if (
          ownsAntigravityClientGeneration(state.client, state.abortController, client, abortController)
          && client?.running
        ) {
          void client.close(250);
        }
      }, 3_000);
      timer.unref?.();
    },

    updateConfig(session, config) {
      const state = getState(session);
      if (typeof config.model === "string") state.model = config.model || undefined;
      if (typeof config.effort === "string") state.effort = config.effort || undefined;
      if (config.providerControls || config.tools || config.disallowedTools || config.toolStates || config.maxTurns) {
        state.restartBeforeNextTurn = true;
      }
    },

    switchProfile(session, ctx) {
      const state = getState(session);
      state.model = ctx.opts.model ?? ctx.profile?.model ?? state.model;
      state.effort = ctx.opts.effort ?? ctx.profile?.effort ?? state.effort;
      state.restartBeforeNextTurn = true;
    },

    async dispose(session) {
      const state = session._providerState as AntigravityState | null;
      if (!state) return;
      state.disposed = true;
      for (const requestId of state.pendingRpcPermissions.keys()) {
        session.pendingPermissions.get(requestId)?.resolve({ behavior: "deny", message: "Session closed" });
      }
      try { state.abortController.abort(); } catch {}
      const client = state.client;
      if (state.providerSessionId) {
        try { client?.notify("session/cancel", { sessionId: state.providerSessionId }); } catch {}
      }
      await client?.close();
      session._providerState = null;
    },
  };
}
