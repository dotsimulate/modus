import { existsSync, realpathSync } from "fs";
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
import type { GrokAcpClient, JsonRpcId } from "./grok-build-acp";
import { MUSE_CODE_CAPABILITIES } from "./muse-code-capabilities";
import {
  createMuseClient,
  MUSE_INITIALIZE_PARAMS,
  museCodeEnvironment,
  museCommandId,
  resolveMuseCodeCommand,
  type MuseCommand,
} from "./muse-code-runtime";
import { requireSupportedProfilePrompt } from "./profile-prompt-delivery";
import { resolveCli } from "./resolve-cli";

type MuseClient = GrokAcpClient;

type ToolState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  resultEmitted: boolean;
};

/** Where an open streamed item's text begins, so `item/completed` can replace it. */
type OpenItem = {
  kind: string;
  roundOffset: number;
  turnOffset: number;
  summaryPart: number;
};

type TurnCompletion = {
  terminal: string;
  reason?: string;
  error?: { message?: string };
  usage?: { inputTokens?: number; outputTokens?: number };
};

type MuseState = {
  client: MuseClient | null;
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
  items: Map<string, OpenItem>;
  tools: Map<string, ToolState>;
  pendingApprovals: Map<string, string>;
  activeTurnId: string | null;
  completedTurns: Map<string, TurnCompletion>;
  turnWaiter: { turnId: string; resolve: (value: TurnCompletion) => void; reject: (error: Error) => void } | null;
  model?: string;
  appliedModel?: string;
  effort?: string;
  approvalMode?: string;
  restartBeforeNextTurn: boolean;
  command: MuseCommand;
};

const MUSE_SHELL_TOOLS = new Set(["shell"]);
const MUSE_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function getState(session: ActiveSession): MuseState {
  const state = session._providerState as MuseState | null;
  if (!state) throw new Error("Muse Code session state is unavailable");
  return state;
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function normalizedSet(values: Iterable<string>): Set<string> {
  return new Set(Array.from(values, (value) => value.toLowerCase()));
}

/** Modus effort names onto MSP's closed `ReasoningEffort` vocabulary. */
export function museReasoningEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  const mapped = effort === "off" ? "none" : effort;
  return MUSE_EFFORTS.has(mapped) ? mapped : undefined;
}

function toolRestrictions(ctx: TurnContext): boolean {
  const configuredTools = ctx.session._configOverrides.tools ?? ctx.opts.tools ?? ctx.profile?.tools;
  const toolStates = ctx.session._configOverrides.toolStates ?? ctx.opts.toolStates ?? {};
  return !!configuredTools?.length
    || !!ctx.profile?.disallowedTools?.length
    || !!ctx.opts.disallowedTools?.length
    || !!ctx.session._configOverrides.disallowedTools?.length
    || Object.values(toolStates).some((state) => state === "off");
}

function permissionPolicy(ctx: TurnContext): PermissionPolicy {
  return ctx.opts.permissionPolicy ?? ctx.profile?.permissionPolicy ?? "bypass";
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
  return permissionPolicyNeedsApproval(permissionPolicy(ctx), toolName, MUSE_SHELL_TOOLS) ? "ask" : "allow";
}

/**
 * MSP has no tool filter, so Modus enforces tool restrictions and its
 * permission policy by answering the host's approval requests. `allowAll` is
 * used only when there is nothing for Modus to enforce.
 */
export function museApprovalMode(ctx: TurnContext): "allowAll" | "promptUnmatched" {
  return permissionPolicy(ctx) === "bypass" && !toolRestrictions(ctx) ? "allowAll" : "promptUnmatched";
}

function pickChoice(choices: any[], decision: "allow" | "deny", persistent: boolean): any | undefined {
  const matches = (choice: any, decisions: string[], scope?: string) =>
    decisions.includes(choice?.decision) && (!scope || choice?.scope === scope);
  if (decision === "allow") {
    const scopes = persistent ? ["session", "once"] : ["once", "session"];
    for (const scope of scopes) {
      const choice = choices.find((candidate) => matches(candidate, ["approved", "approvedForSession"], scope));
      if (choice) return choice;
    }
    return choices.find((candidate) => matches(candidate, ["approved", "approvedForSession"]));
  }
  return choices.find((candidate) => matches(candidate, ["denied"], "once"))
    ?? choices.find((candidate) => matches(candidate, ["denied"]))
    ?? choices.find((candidate) => matches(candidate, ["abort"]));
}

function contentParts(content: MessageContent): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((block) => block.type === "image"
    ? { type: "image", base64Data: block.source.data, mediaType: block.source.media_type }
    : { type: "text", text: block.text });
}

function resolveMcpValues(
  entries: Record<string, string> | undefined,
  serverName: string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, configuredValue] of Object.entries(entries ?? {})) {
    const value = configuredValue.startsWith("$") ? resolveSecret(configuredValue.slice(1)) : configuredValue;
    if (value === undefined) {
      console.warn(`[muse-code] omitted unresolved MCP secret for server "${serverName}" field "${name}"`);
      continue;
    }
    resolved[name] = value;
  }
  return resolved;
}

/** Modus MCP config onto MSP's `SessionMcpServerConfig`, which has no SSE transport. */
export function museMcpServers(ctx: TurnContext): Record<string, Record<string, unknown>> {
  const cwd = ctx.session.cwd ?? ctx.opts.cwd;
  const merged = resolveMcpServers({
    cwd: ctx.session.projectRoot ?? cwd,
    profileName: ctx.opts.profile,
    profile: ctx.profile,
    sessionServers: ctx.opts.mcpServers,
  }).servers;
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, config] of Object.entries(merged)) {
    if (config.type === "sse") {
      console.warn(`[muse-code] skipped MCP server "${name}": Muse Code supports stdio and streamable HTTP, not SSE`);
      continue;
    }
    if (config.type === "http") {
      servers[name] = {
        transport: "streamableHttp",
        url: config.url,
        headers: resolveMcpValues(config.headers, name),
        mode: "optional",
      };
      continue;
    }
    servers[name] = {
      transport: "stdio",
      command: isAbsolute(config.command) ? config.command : (resolveCli(config.command) ?? config.command),
      args: config.args ?? [],
      env: resolveMcpValues(config.env, name),
      mode: "optional",
    };
  }
  return servers;
}

/** MSP wants canonical existing directories, the first one being the CWD. */
function workspaceRoots(cwd: string, additional: string[]): string[] {
  const roots: string[] = [];
  for (const dir of [cwd, ...additional]) {
    if (!existsSync(dir)) continue;
    const canonical = realpathSync(dir);
    if (!roots.includes(canonical)) roots.push(canonical);
  }
  return roots;
}

function assistantEvent(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function thinkingEvent(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } };
}

function flushAssistantRound(ctx: TurnContext, state: MuseState): void {
  if (state.thinking) ctx.emitEvent(thinkingEvent(state.thinking));
  if (state.text) ctx.emitEvent(assistantEvent(state.text));
  state.thinking = "";
  state.text = "";
  state.items.clear();
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "string" || !args) return asObject(args);
  try {
    return asObject(JSON.parse(args));
  } catch {
    // MSP passes model-authored arguments verbatim, which may be almost-JSON.
    return { arguments: args };
  }
}

function emitToolStart(ctx: TurnContext, state: MuseState, item: any): ToolState {
  const id = String(item.itemId);
  const existing = state.tools.get(id);
  if (existing) return existing;
  flushAssistantRound(ctx, state);
  const rawName = typeof item.tool === "string" && item.tool ? item.tool : "MuseTool";
  const tool: ToolState = {
    id,
    // Move tool-views claim `modus_submit`; MCP tools may arrive server-qualified.
    name: rawName.endsWith("modus_submit") ? "modus_submit" : rawName,
    input: parseArgs(item.args),
    resultEmitted: false,
  };
  state.tools.set(id, tool);
  ctx.emitEvent({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name: tool.name, input: tool.input }] },
  });
  return tool;
}

function openItem(state: MuseState, item: any): OpenItem {
  const id = String(item.itemId);
  let open = state.items.get(id);
  if (!open) {
    const reasoning = item.kind === "reasoning";
    open = {
      kind: String(item.kind),
      roundOffset: reasoning ? state.thinking.length : state.text.length,
      turnOffset: state.turnText.length,
      summaryPart: -1,
    };
    state.items.set(id, open);
  }
  return open;
}

function emitTextDelta(ctx: TurnContext, state: MuseState, text: string): void {
  state.text += text;
  state.turnText += text;
  ctx.session.lastAssistantText = state.turnText.slice(-200);
  ctx.emitEvent({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    provider: "muse-code",
    fullText: state.text,
  });
}

function emitThinkingDelta(ctx: TurnContext, state: MuseState, thinking: string): void {
  state.thinking += thinking;
  ctx.emitEvent({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
    provider: "muse-code",
    fullThinking: state.thinking,
  });
}

function handleDelta(ctx: TurnContext, state: MuseState, params: any): void {
  const open = state.items.get(String(params?.itemId));
  const delta = params?.delta;
  if (!open || typeof delta !== "string") return;
  const field = typeof params.field === "string" ? params.field : "text";
  if (open.kind === "agentMessage" && field === "text") {
    emitTextDelta(ctx, state, delta);
    return;
  }
  if (open.kind === "reasoning" && field.startsWith("summary.")) {
    const part = Number(field.slice("summary.".length));
    const separator = open.summaryPart >= 0 && part !== open.summaryPart ? "\n\n" : "";
    open.summaryPart = part;
    emitThinkingDelta(ctx, state, separator + delta);
  }
}

/** `item/completed` is authoritative: replace what the deltas accumulated. */
function handleCompleted(ctx: TurnContext, state: MuseState, item: any): void {
  if (item.kind === "agentMessage" && typeof item.text === "string") {
    const open = openItem(state, item);
    const streamed = state.text.slice(open.roundOffset);
    if (item.text.startsWith(streamed)) {
      const rest = item.text.slice(streamed.length);
      if (rest) emitTextDelta(ctx, state, rest);
    } else {
      state.text = state.text.slice(0, open.roundOffset) + item.text;
      state.turnText = state.turnText.slice(0, open.turnOffset) + item.text;
      ctx.session.lastAssistantText = state.turnText.slice(-200);
    }
    return;
  }
  if (item.kind === "reasoning") {
    const text = typeof item.text === "string" && item.text
      ? item.text
      : Array.isArray(item.summary) ? item.summary.join("\n\n") : "";
    if (!text) return;
    const open = openItem(state, item);
    const streamed = state.thinking.slice(open.roundOffset);
    if (text.startsWith(streamed)) {
      const rest = text.slice(streamed.length);
      if (rest) emitThinkingDelta(ctx, state, rest);
    } else {
      state.thinking = state.thinking.slice(0, open.roundOffset) + text;
    }
    return;
  }
  if (item.kind === "toolCall") {
    const tool = emitToolStart(ctx, state, item);
    if (tool.resultEmitted) return;
    tool.resultEmitted = true;
    const failed = item.status !== "completed";
    const output = typeof item.visibleOutput === "string" && item.visibleOutput
      ? item.visibleOutput
      : failed ? String(item.failureReason ?? item.status ?? "tool call failed") : "tool call completed";
    ctx.emitEvent({
      type: "user",
      subtype: "tool_result",
      isSynthetic: true,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: tool.id, content: output, is_error: failed }],
      },
    });
  }
}

function handleNotification(ctx: TurnContext, state: MuseState, method: string, params: any): void {
  if (params?.sessionId && params.sessionId !== state.providerSessionId) return;
  if (method === "turn/completed") {
    const turnId = String(params?.turnId ?? "");
    state.completedTurns.set(turnId, params);
    if (state.turnWaiter?.turnId === turnId) state.turnWaiter.resolve(params);
    return;
  }
  if (method === "approval/resolved") {
    const requestId = state.pendingApprovals.get(String(params?.approvalId));
    if (requestId) {
      // Decided elsewhere (policy, timeout, another client): retire the Modus prompt.
      state.pendingApprovals.delete(String(params.approvalId));
      ctx.session.pendingPermissions.delete(requestId);
      const approved = typeof params?.decision === "string" && params.decision.startsWith("approved");
      ctx.emitEvent({ type: "system", subtype: "permission_resolved", requestId, behavior: approved ? "allow" : "deny" });
    }
    return;
  }
  if (!state.turnActive) return;
  ctx.session.lastEventAt = Date.now();
  const item = asObject(params?.item);
  if (method === "item/started") {
    if (item.kind === "toolCall") emitToolStart(ctx, state, item);
    else if (item.kind === "agentMessage" || item.kind === "reasoning") openItem(state, item);
    return;
  }
  if (method === "item/delta") {
    handleDelta(ctx, state, params);
    return;
  }
  if (method === "item/completed") handleCompleted(ctx, state, item);
}

async function decideApproval(
  client: MuseClient,
  state: MuseState,
  params: any,
  choice: any | undefined,
): Promise<void> {
  if (!choice || !state.providerSessionId) return;
  try {
    await client.request("approval/decide", {
      sessionId: state.providerSessionId,
      commandId: museCommandId(),
      approvalId: params.approvalId,
      requirementId: params.currentRequirementId,
      choiceId: choice.choiceId,
    }, 30_000);
  } catch (error) {
    console.warn(`[muse-code] approval/decide failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function handleApproval(
  ctx: TurnContext,
  state: MuseState,
  client: MuseClient,
  rpcId: JsonRpcId,
  params: any,
): void {
  // The request is acknowledged on receipt; the decision is a separate command.
  try { client.respond(rpcId, {}); } catch {}
  if (params?.sessionId !== state.providerSessionId) return;
  const toolName = typeof params?.toolName === "string" ? params.toolName : "MuseTool";
  const input = parseArgs(params?.rawArgs);
  const choices = Array.isArray(params?.availableChoices) ? params.availableChoices : [];
  const decision = toolDecision(ctx, toolName);
  if (decision !== "ask") {
    void decideApproval(client, state, params, pickChoice(choices, decision, false));
    return;
  }

  const approvalId = String(params.approvalId);
  const requestId = `muse-approval-${approvalId}-${params.currentRequirementId?.sourceIndex ?? 0}`;
  state.pendingApprovals.set(approvalId, requestId);
  ctx.session.pendingPermissions.set(requestId, {
    toolName,
    input,
    requestedAt: Date.now(),
    resolve: (response) => {
      state.pendingApprovals.delete(approvalId);
      ctx.session.pendingPermissions.delete(requestId);
      const persistent = response.behavior === "allow" && ctx.session.sessionApprovals.has(toolName);
      void decideApproval(client, state, params, pickChoice(choices, response.behavior, persistent));
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

async function connect(ctx: TurnContext, state: MuseState, resume: boolean): Promise<void> {
  if (state.client?.running && !state.restartBeforeNextTurn) return;
  if (state.client) {
    const previous = state.client;
    await previous.close();
    if (state.client === previous) state.client = null;
  }
  const cwd = ctx.session.cwd ?? ctx.opts.cwd ?? process.cwd();
  const env = museCodeEnvironment(ctx.profile?.env);
  const client = createMuseClient(state.command, cwd, env);
  state.client = client;
  state.restartBeforeNextTurn = false;
  state.approvalMode = undefined;
  client.onNotification((method, params) => {
    if (state.client !== client) return;
    handleNotification(ctx, state, method, params);
  });
  client.onRequest((id, method, params) => {
    if (state.client !== client) {
      try { client.respondError(id, -32000, "Provider client was replaced"); } catch {}
      return;
    }
    if (method === "approval/request") return handleApproval(ctx, state, client, id, params);
    client.respondError(id, -32601, `Unsupported client method: ${method}`);
  });
  let clientPid: number | null = null;
  client.onClose((error) => {
    if (clientPid != null) ctx.session.osPids.delete(clientPid);
    if (state.client === client) {
      state.client = null;
      if (state.pid === clientPid) state.pid = null;
      state.turnWaiter?.reject(error ?? new Error("Muse Code host exited during the turn"));
    }
  });
  client.start();
  clientPid = client.pid ?? null;
  state.pid = clientPid;
  if (clientPid != null) ctx.session.osPids.add(clientPid);

  const initialized = await client.request("initialize", MUSE_INITIALIZE_PARAMS, 30_000);
  client.notify("initialized", undefined);
  const granted: string[] = Array.isArray(initialized?.grantedCapabilities) ? initialized.grantedCapabilities : [];
  const servers = museMcpServers(ctx);
  client.addSensitiveValues(Object.values(servers).flatMap((server) => [
    ...Object.values(asObject(server.headers)), ...Object.values(asObject(server.env)),
  ].map(String)));
  const hasServers = Object.keys(servers).length > 0;
  if (hasServers && !granted.includes("sessionMcp")) {
    console.warn("[muse-code] host did not grant sessionMcp; Modus MCP servers are unavailable in this session");
  }
  const config = hasServers && granted.includes("sessionMcp") ? { config: { mcpServers: servers } } : {};

  if (resume && state.providerSessionId) {
    const resumed = await client.request("session/resume", {
      commandId: museCommandId(),
      sessionId: state.providerSessionId,
      excludeItems: true,
      ...config,
    }, 60_000);
    state.appliedModel = typeof resumed?.session?.modelId === "string" ? resumed.session.modelId : undefined;
    state.approvalMode = resumed?.session?.approvalMode?.mode;
    return;
  }
  const roots = workspaceRoots(cwd, ctx.session.additionalDirectories ?? []);
  const approvalMode = museApprovalMode(ctx);
  const started = await client.request("session/start", {
    commandId: museCommandId(),
    workspaceRoot: roots[0] ?? cwd,
    ...(roots.length > 1 ? { workspaceRoots: roots } : {}),
    ...(state.model ? { modelId: state.model } : {}),
    approvalMode,
    ...config,
  }, 60_000);
  const providerSessionId = started?.session?.sessionId;
  if (typeof providerSessionId !== "string" || !providerSessionId) throw new Error("Muse Code did not return a session ID");
  state.providerSessionId = providerSessionId;
  state.appliedModel = typeof started.session.modelId === "string" ? started.session.modelId : state.model;
  state.approvalMode = approvalMode;
  ctx.setProviderSessionId(providerSessionId);
}

/** Model and approval mode are session commands, so they apply without a restart. */
async function applySessionSettings(ctx: TurnContext, state: MuseState, client: MuseClient): Promise<void> {
  const sessionId = state.providerSessionId!;
  if (state.model && state.model !== state.appliedModel) {
    await client.request("session/setModel", {
      commandId: museCommandId(),
      sessionId,
      model: { modelId: state.model },
    }, 30_000);
    state.appliedModel = state.model;
  }
  const approvalMode = museApprovalMode(ctx);
  if (approvalMode !== state.approvalMode) {
    await client.request("session/setApprovalMode", { commandId: museCommandId(), sessionId, mode: approvalMode }, 30_000);
    state.approvalMode = approvalMode;
  }
}

function emitInit(ctx: TurnContext, state: MuseState): void {
  ctx.emitEvent({
    type: "system",
    subtype: "init",
    // The Modus session id, not Muse's: the UI rekeys the transcript when they differ.
    session_id: ctx.session.sessionId,
    model: state.model ?? state.appliedModel ?? "",
    config: {
      provider: "muse-code",
      model: state.model ?? state.appliedModel ?? "",
      effort: state.effort ?? "",
      maxTurns: ctx.session._configOverrides.maxTurns ?? ctx.opts.maxTurns,
      toolStates: ctx.session._configOverrides.toolStates ?? ctx.opts.toolStates ?? {},
      providerControls: ctx.session._configOverrides.providerControls ?? ctx.opts.providerControls ?? {},
    },
    cwd: ctx.session.cwd,
    additionalDirectories: ctx.session.additionalDirectories,
    loadProjectSettings: true,
  });
}

function waitForTurn(state: MuseState, turnId: string): Promise<TurnCompletion> {
  const done = state.completedTurns.get(turnId);
  if (done) return Promise.resolve(done);
  return new Promise((resolve, reject) => {
    state.turnWaiter = { turnId, resolve, reject };
  });
}

function finishIdle(ctx: TurnContext): void {
  ctx.session.status = "idle";
  updateSessionStatus(ctx.session.sessionId, "idle");
  ctx.emitEvent({ type: "done" });
}

async function runTurn(
  ctx: TurnContext,
  state: MuseState,
  content: MessageContent,
  options: { resume: boolean },
): Promise<void> {
  const { session } = ctx;
  const turnAbortController = state.abortController;
  let turnClient: MuseClient | null = null;
  try {
    await connect(ctx, state, options.resume);
    turnClient = state.client;
    if (!turnClient || !state.providerSessionId) throw new Error("Muse Code host closed during connection");
    await applySessionSettings(ctx, state, turnClient);
    // The harness keeps only a queue-time row; this is the message's transcript turn.
    ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content } });
    emitInit(ctx, state);
    state.turnActive = true;
    state.text = "";
    state.thinking = "";
    state.turnText = "";
    state.items.clear();
    state.tools.clear();
    state.completedTurns.clear();
    session.status = "running";
    updateSessionStatus(session.sessionId, "running");

    // A fresh turn's id is its commandId, so the waiter is armed before the ack:
    // events that share a stdout chunk with the ack are handled before it resolves.
    const commandId = museCommandId();
    state.activeTurnId = commandId;
    const effort = museReasoningEffort(state.effort);
    const ack = await turnClient.request("turn/start", {
      commandId,
      sessionId: state.providerSessionId,
      input: contentParts(content),
      ...(effort ? { reasoningEffort: effort } : {}),
    }, 60_000);
    const turnId = typeof ack?.turnId === "string" ? ack.turnId : commandId;
    state.activeTurnId = turnId;
    const completion = await waitForTurn(state, turnId);
    state.turnWaiter = null;

    if (turnAbortController.signal.aborted || completion.terminal === "cancelled") {
      flushAssistantRound(ctx, state);
      finishIdle(ctx);
      return;
    }
    if (completion.terminal !== "completed") {
      flushAssistantRound(ctx, state);
      throw new Error(completion.error?.message ?? completion.reason ?? `Muse Code turn ended: ${completion.terminal}`);
    }
    flushAssistantRound(ctx, state);
    const input = completion.usage?.inputTokens ?? 0;
    const output = completion.usage?.outputTokens ?? 0;
    ctx.emitEvent({
      type: "result",
      subtype: "success",
      result: state.turnText,
      stop_reason: completion.terminal,
      harness_duration_ms: Date.now() - session.turnStartedAt,
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      num_turns: 1,
      // MSP reports no per-turn cost; subscription turns have none to report.
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
    state.turnWaiter = null;
    if (turnAbortController.signal.aborted) {
      finishIdle(ctx);
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
    // A failed turn leaves the session usable; a broken connection, or one that
    // never loaded a session, is torn down so the next turn reconnects.
    if (!turnClient?.running || !state.providerSessionId) await (turnClient ?? state.client)?.close();
  } finally {
    if (state.abortController === turnAbortController) {
      state.turnActive = false;
      state.activeTurnId = null;
    }
  }

  if (!state.disposed && session.status === "idle" && session.pendingDispatch.length) {
    const next = session.pendingDispatch.shift()!.content;
    session.initialContent = next;
    session.preview = contentPreview(next);
    session.abortController = new AbortController();
    state.abortController = session.abortController;
    session.turnStartedAt = Date.now();
    void runTurn(ctx, state, next, { resume: true });
  }
}

/**
 * A missing CLI is usually a stale PATH rather than a missing install: an
 * installer appends its directory to the persisted user PATH, which a running
 * Modus does not see until it restarts.
 */
export const MUSE_CODE_CLI_MISSING =
  "Muse Code CLI (`muse`) was not found. Install it and sign in with your Meta Model API account, "
  + "then restart Modus so it picks up the new PATH — or set MODUS_MUSE_CLI to the executable's full path.";

/** `type: "error"` is promoted to a persisted system message; see grok-build.ts. */
function markMuseCodeUnavailable(ctx: TurnContext, reason: string): void {
  const { session } = ctx;
  console.error(`[muse-code] ${reason}`);
  session.status = "error";
  session.error = reason;
  updateSessionStatus(session.sessionId, "error");
  ctx.broadcastEvent({ type: "error", error: reason });
  ctx.emitEvent({ type: "done" });
}

function denyPendingApprovals(session: ActiveSession, state: MuseState, message: string): void {
  for (const requestId of [...state.pendingApprovals.values()]) {
    session.pendingPermissions.get(requestId)?.resolve({ behavior: "deny", message });
  }
}

/** `expectedTurnId` makes the host refuse input aimed at a turn that already ended. */
async function steerTurn(state: MuseState, content: MessageContent): Promise<boolean> {
  const client = state.client;
  if (!client?.running || !state.turnActive || !state.activeTurnId || !state.providerSessionId
    || state.abortController.signal.aborted) return false;
  try {
    const ack = await client.request("turn/steer", {
      commandId: museCommandId(),
      sessionId: state.providerSessionId,
      expectedTurnId: state.activeTurnId,
      input: contentParts(content),
    }, 30_000);
    return ack?.status === "accepted";
  } catch {
    return false;
  }
}

export function createMuseCodeProvider(options?: {
  command?: MuseCommand;
  /** Test seam: exercise the not-found branch without depending on the host's PATH. */
  resolveCommand?: () => MuseCommand | null;
}): SessionProvider {
  return {
    capabilities: MUSE_CODE_CAPABILITIES,

    startTurn(ctx) {
      const command = options?.command ?? (options?.resolveCommand ?? resolveMuseCodeCommand)();
      if (!command) {
        markMuseCodeUnavailable(ctx, MUSE_CODE_CLI_MISSING);
        return;
      }
      try {
        requireSupportedProfilePrompt(MUSE_CODE_CAPABILITIES, ctx.profile);
      } catch (error) {
        markMuseCodeUnavailable(ctx, error instanceof Error ? error.message : String(error));
        return;
      }
      const existing = ctx.opts.sessionId ? getSession(ctx.opts.sessionId) : null;
      const resume = !!ctx.opts.sessionId && !!existing && (existing.message_count > 0 || getMaxSeq(ctx.opts.sessionId) > 0);
      if (resume && !ctx.session.providerSessionId) {
        markMuseCodeUnavailable(
          ctx,
          "This Modus session has no stored Muse Code session ID, so it cannot be resumed without losing context.",
        );
        return;
      }
      const state: MuseState = {
        client: null,
        pid: null,
        providerSessionId: resume ? ctx.session.providerSessionId : null,
        abortController: ctx.session.abortController,
        turnActive: false,
        disposed: false,
        text: "",
        thinking: "",
        turnText: "",
        items: new Map(),
        tools: new Map(),
        pendingApprovals: new Map(),
        activeTurnId: null,
        completedTurns: new Map(),
        turnWaiter: null,
        model: ctx.opts.model ?? ctx.profile?.model,
        effort: ctx.opts.effort ?? ctx.profile?.effort,
        restartBeforeNextTurn: false,
        command,
      };
      ctx.session._providerState = state;
      void runTurn(ctx, state, ctx.session.initialContent, { resume });
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
      void runTurn(ctx, state, content, { resume: true });
    },

    steerMessage(ctx, content) {
      return steerTurn(getState(ctx.session), content);
    },

    abort(session) {
      const state = getState(session);
      const client = state.client;
      const abortController = state.abortController;
      denyPendingApprovals(session, state, "Turn cancelled");
      try { abortController.abort(); } catch {}
      try { session.abortController.abort(); } catch {}
      if (state.providerSessionId && state.activeTurnId && client?.running) {
        client.request("turn/cancel", {
          commandId: museCommandId(),
          sessionId: state.providerSessionId,
          turnId: state.activeTurnId,
        }, 10_000).catch(() => {});
      }
      const timer = setTimeout(() => {
        // Still waiting on the host after a cancel: stop waiting and drop the
        // process; the next turn resumes the durable Muse session.
        if (state.client === client && state.abortController === abortController && state.turnActive) {
          state.turnWaiter?.reject(new Error("Muse Code did not confirm the cancel"));
          void client?.close(250);
        }
      }, 5_000);
      timer.unref?.();
    },

    updateConfig(session, config) {
      const state = getState(session);
      if (typeof config.model === "string") state.model = config.model || undefined;
      if (typeof config.effort === "string") state.effort = config.effort || undefined;
    },

    switchProfile(session, ctx) {
      const state = getState(session);
      state.model = ctx.opts.model ?? ctx.profile?.model ?? state.model;
      state.effort = ctx.opts.effort ?? ctx.profile?.effort ?? state.effort;
      // MCP servers are fixed when the session loads, so reload it for the new profile.
      state.restartBeforeNextTurn = true;
    },

    async dispose(session) {
      const state = session._providerState as MuseState | null;
      if (!state) return;
      state.disposed = true;
      denyPendingApprovals(session, state, "Session closed");
      try { state.abortController.abort(); } catch {}
      const client = state.client;
      if (state.providerSessionId && state.activeTurnId && client?.running) {
        client.request("turn/cancel", {
          commandId: museCommandId(),
          sessionId: state.providerSessionId,
          turnId: state.activeTurnId,
        }, 5_000).catch(() => {});
      }
      await client?.close();
      session._providerState = null;
    },
  };
}
