import { isAbsolute } from "path";
import {
  contentPreview,
  createPendingDispatchItem,
  type ActiveSession,
  type MessageContent,
} from "../session-manager";
import { getMaxSeq, getSession, updateSessionStatus } from "../db";
import {
  getGlobalConfig,
  resolveProfilePrompt,
  type McpServerConfig,
  type PermissionPolicy,
} from "../profiles";
import type { SessionProvider, TurnContext } from "./types";
import { GrokAcpClient, type JsonRpcId } from "./grok-build-acp";
import { GROK_BUILD_CAPABILITIES, GROK_BUILD_TOOL_GROUPS } from "./grok-build-capabilities";
import {
  grokBuildEnvironment,
  resolveGrokBuildCommand,
  selectGrokBuildAuthMethod,
  type GrokCommand,
} from "./grok-build-runtime";
import { resolveSecret } from "../secrets";

type GrokBuildControls = {
  mode?: "default" | "auto" | "plan" | "always-approve";
  sandbox?: string;
  noMemory?: boolean;
  noSubagents?: boolean;
  disableWebSearch?: boolean;
};

type ToolState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  resultEmitted: boolean;
};

type GrokState = {
  client: GrokAcpClient | null;
  pid: number | null;
  providerSessionId: string | null;
  abortController: AbortController;
  turnActive: boolean;
  disposed: boolean;
  text: string;
  thinking: string;
  tools: Map<string, ToolState>;
  pendingRpcPermissions: Map<string, JsonRpcId>;
  model?: string;
  effort?: string;
  restartBeforeNextTurn: boolean;
  command: GrokCommand;
};

type Usage = {
  input: number;
  output: number;
  total: number;
  cost: number;
};

export function ownsGrokClientGeneration(
  currentClient: unknown,
  currentAbortController: AbortController,
  expectedClient: unknown,
  expectedAbortController: AbortController,
): boolean {
  return currentClient === expectedClient && currentAbortController === expectedAbortController;
}

const GROK_TOOLS = GROK_BUILD_TOOL_GROUPS.flatMap((group) => [...group.tools]);

function toolNameFromCall(call: any): string {
  const explicit = call?._meta?.toolName ?? call?._meta?.tool_name ?? call?.name;
  if (typeof explicit === "string" && explicit) return explicit;
  const title = typeof call?.title === "string" ? call.title : "";
  const titleLower = title.toLowerCase();
  const known = GROK_TOOLS.find((tool) => titleLower.includes(tool.toLowerCase()));
  return known ?? (typeof call?.kind === "string" && call.kind ? call.kind : title || "GrokTool");
}

function getState(session: ActiveSession): GrokState {
  const state = session._providerState as GrokState | null;
  if (!state) throw new Error("Grok Build session state is unavailable");
  return state;
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
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

function usageFrom(result: any): Usage {
  const meta = asObject(result?._meta);
  const usage = asObject(meta.usage ?? meta.modelUsage ?? result?.usage);
  const input = numberValue(usage.inputTokens, usage.input_tokens, usage.promptTokens, usage.prompt_tokens);
  const output = numberValue(usage.outputTokens, usage.output_tokens, usage.completionTokens, usage.completion_tokens);
  return {
    input,
    output,
    total: numberValue(usage.totalTokens, usage.total_tokens, input + output),
    cost: numberValue(usage.totalCostUsd, usage.total_cost_usd, usage.costUsd, usage.cost_usd, meta.totalCostUsd),
  };
}

function controlsFrom(ctx: TurnContext): GrokBuildControls {
  const controls = ctx.session._configOverrides.providerControls ?? ctx.opts.providerControls ?? ctx.profile?.providerControls;
  return asObject(asObject(controls).grokBuild) as GrokBuildControls;
}

function normalizedSet(values: Iterable<string>): Set<string> {
  return new Set(Array.from(values, (value) => value.toLowerCase()));
}

function toolDecision(ctx: TurnContext, toolName: string): "allow" | "ask" | "deny" {
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
  if (policy === "bypass") return "allow";
  if (policy === "ask") return "ask";
  if (normalizedSet(policy.requireApproval ?? []).has(lower)) return "ask";
  if (normalizedSet(policy.autoApprove ?? []).has(lower)) return "allow";
  return policy.default === "approve" ? "allow" : "ask";
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

export function resolveGrokBuildMcpValue(
  value: string,
  resolver: (name: string) => string | undefined = resolveSecret,
): string | undefined {
  return value.startsWith("$") ? resolver(value.slice(1)) : value;
}

function resolvedMcpEntries(
  entries: Record<string, string> | undefined,
  serverName: string,
): Array<{ name: string; value: string }> {
  const resolved: Array<{ name: string; value: string }> = [];
  for (const [name, configuredValue] of Object.entries(entries ?? {})) {
    const value = resolveGrokBuildMcpValue(configuredValue);
    if (value === undefined) {
      console.warn(`[grok-build] omitted unresolved MCP secret for server "${serverName}" field "${name}"`);
      continue;
    }
    resolved.push({ name, value });
  }
  return resolved;
}

function mcpServers(ctx: TurnContext): any[] {
  const cwd = ctx.session.cwd ?? ctx.opts.cwd;
  const merged: Record<string, McpServerConfig> = {
    ...(getGlobalConfig(cwd).mcpServers ?? {}),
    ...(ctx.profile?.mcpServers ?? {}),
    ...(ctx.opts.mcpServers as Record<string, McpServerConfig> | undefined ?? {}),
  };
  return Object.entries(merged).map(([name, config]) => {
    if (config.type === "http" || config.type === "sse") {
      return {
        type: config.type,
        name,
        url: config.url,
        headers: resolvedMcpEntries(config.headers, name),
      };
    }
    const resolved = isAbsolute(config.command) ? config.command : (Bun.which(config.command) ?? config.command);
    return {
      type: "stdio",
      name,
      command: resolved,
      args: config.args ?? [],
      env: resolvedMcpEntries(config.env, name),
    };
  });
}

function launchArgs(ctx: TurnContext, state: GrokState): string[] {
  const args = ["--no-auto-update"];
  const prompt = resolveProfilePrompt(ctx.profile);
  if (prompt?.text) args.push(prompt.mode === "custom" ? "--system-prompt-override" : "--rules", prompt.text);
  const effort = state.effort ?? ctx.opts.effort ?? ctx.profile?.effort;
  if (effort) args.push("--effort", effort === "off" ? "none" : effort);
  const maxTurns = ctx.session._configOverrides.maxTurns ?? ctx.opts.maxTurns ?? ctx.profile?.maxTurns;
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  const controls = controlsFrom(ctx);
  if (controls.sandbox) args.push("--sandbox", controls.sandbox);
  if (controls.noMemory) args.push("--no-memory");
  if (controls.noSubagents) args.push("--no-subagents");
  if (controls.disableWebSearch) args.push("--disable-web-search");
  if (controls.mode === "always-approve") args.push("--always-approve");

  const allowed = ctx.session._configOverrides.tools ?? ctx.opts.tools ?? ctx.profile?.tools;
  const denied = new Set([
    ...(ctx.profile?.disallowedTools ?? []),
    ...(ctx.opts.disallowedTools ?? []),
    ...(ctx.session._configOverrides.disallowedTools ?? []),
  ]);
  const toolStates = ctx.session._configOverrides.toolStates ?? ctx.opts.toolStates ?? {};
  for (const [name, toolState] of Object.entries(toolStates)) if (toolState === "off") denied.add(name);
  if (allowed?.length) {
    const allowSet = normalizedSet(allowed);
    for (const tool of GROK_TOOLS) if (!allowSet.has(tool.toLowerCase())) denied.add(tool);
  }
  if (allowed?.length) args.push("--tools", allowed.join(","));
  if (denied.size) args.push("--disallowed-tools", Array.from(denied).join(","));
  args.push("agent", "stdio");
  return args;
}

function assistantEvent(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function thinkingEvent(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } };
}

function emitToolStart(ctx: TurnContext, state: GrokState, toolCall: any): ToolState {
  const id = String(toolCall.toolCallId ?? toolCall.tool_call_id ?? `grok-tool-${Date.now()}`);
  const existing = state.tools.get(id);
  if (existing) return existing;
  const tool: ToolState = {
    id,
    name: toolNameFromCall(toolCall),
    input: asObject(toolCall.rawInput ?? toolCall.raw_input ?? toolCall.input),
    resultEmitted: false,
  };
  state.tools.set(id, tool);
  ctx.emitEvent({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name: tool.name, input: tool.input }] },
  });
  return tool;
}

function outputFromTool(update: any): string {
  const raw = update.rawOutput ?? update.raw_output;
  if (raw != null) return stringify(raw);
  const content = Array.isArray(update.content) ? update.content : [];
  const parts = content.map((entry: any) => entry?.content?.text ?? entry?.text ?? entry?.content).filter(Boolean);
  return parts.length ? parts.map(stringify).join("\n") : stringify(update.status ?? "tool call completed");
}

function handleUpdate(ctx: TurnContext, state: GrokState, params: any): void {
  if (!state.turnActive) return;
  ctx.session.lastEventAt = Date.now();
  const update = params?.update ?? params;
  const type = update?.sessionUpdate ?? update?.session_update ?? update?.type;
  if (type === "agent_message_chunk") {
    const text = update?.content?.text;
    if (typeof text !== "string") return;
    state.text += text;
    ctx.session.lastAssistantText = state.text.slice(-200);
    ctx.broadcastEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      provider: "grok-build",
      fullText: state.text,
    });
    return;
  }
  if (type === "agent_thought_chunk") {
    const thinking = update?.content?.text;
    if (typeof thinking !== "string") return;
    state.thinking += thinking;
    ctx.broadcastEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
      provider: "grok-build",
      fullThinking: state.thinking,
    });
    return;
  }
  if (type === "tool_call" || type === "tool_call_update") {
    const tool = emitToolStart(ctx, state, update);
    const id = tool.id;
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
            tool_use_id: id,
            content: outputFromTool(update),
            is_error: status === "failed",
          }],
        },
      });
    }
    return;
  }
  if (type === "plan") {
    ctx.emitEvent({ type: "system", subtype: "plan", plan: update.entries ?? update.plan ?? [] });
    return;
  }
  if (type === "current_mode_update" && typeof update.currentModeId === "string") {
    ctx.notifyConfigChange({ providerControls: { grokBuild: { ...controlsFrom(ctx), mode: update.currentModeId } } });
  }
}

function handlePermission(
  ctx: TurnContext,
  state: GrokState,
  client: GrokAcpClient,
  rpcId: JsonRpcId,
  params: any,
): void {
  if (params?.sessionId !== state.providerSessionId) {
    try { client.respond(rpcId, { outcome: { outcome: "cancelled" } }); } catch {}
    return;
  }
  const call = params?.toolCall ?? {};
  const toolName = toolNameFromCall(call);
  const input = asObject(call.rawInput ?? call.raw_input ?? call.input);
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

  const requestId = `grok-permission-${String(rpcId)}`;
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

async function connect(ctx: TurnContext, state: GrokState, resume: boolean): Promise<void> {
  if (state.client?.running && !state.restartBeforeNextTurn) return;
  if (state.client) {
    const previous = state.client;
    await previous.close();
    if (state.client === previous) state.client = null;
  }
  const cwd = ctx.session.cwd ?? ctx.opts.cwd ?? process.cwd();
  const effectiveEnv = grokBuildEnvironment(ctx.profile?.env);
  const client = new GrokAcpClient({
    executable: state.command.executable,
    args: [...state.command.prefixArgs, ...launchArgs(ctx, state)],
    cwd,
    env: effectiveEnv,
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

  const initialized = await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "Modus", version: "1" },
    _meta: { clientIdentifier: "modus" },
  }, 30_000);
  const authMethods = Array.isArray(initialized?.authMethods) ? initialized.authMethods : [];
  if (authMethods.length) {
    const preferred = selectGrokBuildAuthMethod(initialized, effectiveEnv);
    if (!preferred) {
      throw new Error("Grok Build is not signed in. Run `grok login` (free account login is supported) or set XAI_API_KEY.");
    }
    await client.request("authenticate", { methodId: preferred, _meta: { headless: true } }, 60_000);
  }

  const controls = controlsFrom(ctx);
  const model = state.model ?? ctx.opts.model ?? ctx.profile?.model;
  const sessionParams = {
    cwd,
    additionalDirectories: ctx.session.additionalDirectories,
    mcpServers: mcpServers(ctx),
    _meta: {
      ...(model ? { modelId: model } : {}),
      ...(controls.mode === "always-approve" ? { yoloMode: true } : {}),
      ...(controls.mode === "auto" ? { autoMode: true } : {}),
    },
  };
  let created: any;
  if (resume && state.providerSessionId) {
    created = await client.request("session/load", { ...sessionParams, sessionId: state.providerSessionId }, 60_000);
    if (created?.sessionId && created.sessionId !== state.providerSessionId) {
      throw new Error(`Grok Build refused resume target ${state.providerSessionId} and returned ${created.sessionId}`);
    }
  } else {
    created = await client.request("session/new", sessionParams, 60_000);
    const providerSessionId = created?.sessionId;
    if (typeof providerSessionId !== "string" || !providerSessionId) throw new Error("Grok Build did not return a session ID");
    state.providerSessionId = providerSessionId;
    ctx.setProviderSessionId(providerSessionId);
  }
  if (controls.mode === "plan" && state.providerSessionId) {
    await client.request("session/set_mode", { sessionId: state.providerSessionId, modeId: "plan" }, 30_000);
  }
}

function emitInit(ctx: TurnContext, state: GrokState): void {
  ctx.emitEvent({
    type: "system",
    subtype: "init",
    session_id: state.providerSessionId,
    model: state.model ?? ctx.opts.model ?? ctx.profile?.model ?? "",
    config: {
      provider: "grok-build",
      model: state.model ?? ctx.opts.model ?? ctx.profile?.model ?? "",
      effort: state.effort ?? ctx.opts.effort ?? ctx.profile?.effort ?? "",
      maxTurns: ctx.session._configOverrides.maxTurns ?? ctx.opts.maxTurns,
      toolStates: ctx.session._configOverrides.toolStates ?? ctx.opts.toolStates ?? {},
      providerControls: ctx.session._configOverrides.providerControls ?? ctx.opts.providerControls ?? {},
    },
    cwd: ctx.session.cwd,
    additionalDirectories: ctx.session.additionalDirectories,
    loadProjectSettings: ctx.opts.loadProjectSettings ?? ctx.profile?.loadProjectSettings ?? false,
  });
}

async function runTurn(
  ctx: TurnContext,
  state: GrokState,
  content: MessageContent,
  options: { resume: boolean; skipPromptPersist: boolean },
): Promise<void> {
  const { session } = ctx;
  const turnAbortController = state.abortController;
  let turnClient: GrokAcpClient | null = null;
  try {
    await connect(ctx, state, options.resume);
    turnClient = state.client;
    if (!turnClient) throw new Error("Grok Build client closed during connection");
    if (state.model && state.providerSessionId) {
      await turnClient.request("session/set_model", { sessionId: state.providerSessionId, modelId: state.model }, 30_000);
    }
    if (!options.skipPromptPersist) {
      ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content } });
      emitInit(ctx, state);
    }
    state.turnActive = true;
    state.text = "";
    state.thinking = "";
    state.tools.clear();
    session.status = "running";
    updateSessionStatus(session.sessionId, "running");
    const result = await turnClient.request("session/prompt", {
      sessionId: state.providerSessionId,
      prompt: contentBlocks(content),
      _meta: {
        ...(state.effort ? { reasoningEffort: state.effort === "off" ? "none" : state.effort } : {}),
      },
    }, 24 * 60 * 60 * 1_000);
    if (turnAbortController.signal.aborted) {
      session.status = "idle";
      updateSessionStatus(session.sessionId, "idle");
      ctx.emitEvent({ type: "done" });
      return;
    }
    if (state.thinking) ctx.emitEvent(thinkingEvent(state.thinking));
    if (state.text) ctx.emitEvent(assistantEvent(state.text));
    const usage = usageFrom(result);
    ctx.emitEvent({
      type: "result",
      subtype: "success",
      result: state.text,
      stop_reason: result?.stopReason,
      harness_duration_ms: Date.now() - session.turnStartedAt,
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.total,
      num_turns: 1,
      total_cost_usd: usage.cost,
    });
    session.costUsd += usage.cost;
    session.numTurns += 1;
    session.status = "idle";
    ctx.updateSessionDb({
      status: "idle",
      messageCount: (session.exchangeCount + 1) * 2,
      costUsd: session.costUsd,
      lastPrompt: session.preview,
      lastResponse: state.text.slice(0, 200),
    });
  } catch (error) {
    if (turnAbortController.signal.aborted) {
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
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      num_turns: 0,
      total_cost_usd: 0,
    });
    ctx.emitEvent({ type: "done" });
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
    void runTurn(ctx, state, next, { resume: true, skipPromptPersist: true });
  }
}

export function createGrokBuildProvider(options?: { command?: GrokCommand }): SessionProvider {
  return {
    capabilities: GROK_BUILD_CAPABILITIES,

    startTurn(ctx) {
      const command = options?.command ?? resolveGrokBuildCommand();
      if (!command) {
        ctx.session.status = "error";
        ctx.session.error = "Grok Build CLI was not found. Install it, then run `grok login` or set XAI_API_KEY.";
        updateSessionStatus(ctx.session.sessionId, "error");
        ctx.emitEvent({ type: "result", subtype: "error", error: ctx.session.error, total_cost_usd: 0 });
        ctx.emitEvent({ type: "done" });
        return;
      }
      const existing = ctx.opts.sessionId ? getSession(ctx.opts.sessionId) : null;
      const resume = !!ctx.opts.sessionId && !!existing && (existing.message_count > 0 || getMaxSeq(ctx.opts.sessionId) > 0);
      if (resume && !ctx.session.providerSessionId) {
        ctx.session.status = "error";
        ctx.session.error = "This Modus session has no stored Grok Build session ID, so it cannot be resumed without losing context.";
        updateSessionStatus(ctx.session.sessionId, "error");
        ctx.emitEvent({ type: "result", subtype: "error", error: ctx.session.error, total_cost_usd: 0 });
        ctx.emitEvent({ type: "done" });
        return;
      }
      const state: GrokState = {
        client: null,
        pid: null,
        providerSessionId: resume ? ctx.session.providerSessionId : null,
        abortController: ctx.session.abortController,
        turnActive: false,
        disposed: false,
        text: "",
        thinking: "",
        tools: new Map(),
        pendingRpcPermissions: new Map(),
        model: ctx.opts.model ?? ctx.profile?.model,
        effort: ctx.opts.effort ?? ctx.profile?.effort,
        restartBeforeNextTurn: false,
        command,
      };
      ctx.session._providerState = state;
      void runTurn(ctx, state, ctx.session.initialContent, { resume, skipPromptPersist: false });
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
      void runTurn(ctx, state, content, { resume: true, skipPromptPersist: true });
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
          ownsGrokClientGeneration(state.client, state.abortController, client, abortController)
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
      const state = session._providerState as GrokState | null;
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
