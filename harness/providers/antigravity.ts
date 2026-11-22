import { readFileSync, statSync } from "fs";
import { extname, isAbsolute, resolve } from "path";
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
import {
  AntigravityTranscriptTail,
  agyWoke,
  antigravityTranscriptPath,
  backgroundTaskFinished,
  backgroundTaskStarted,
  backgroundTasksStopped,
  commandLineText,
  endsWithFinalResponse,
  isSystemMessage,
  timerSeconds,
} from "./antigravity-transcript";
import {
  decideTool,
  describeToolRestriction,
  emitProviderNotice,
  noticeToolDenied,
  toolRestriction,
  toolRestrictionConfig,
  type ToolDecision,
} from "./tool-restrictions";

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
  /** A background command Modus stopped waiting on; it no longer holds the turn open. */
  released?: boolean;
};

/** A task agy's record shows it moved to the background this turn. */
type BackgroundTask = {
  taskId: string;
  description: string;
  /** The `run_command` call it belongs to, when Modus could tell which. */
  toolId?: string;
  startedAt: number;
  /** A `schedule` timer's length; agy records no finish for a timer. */
  timerMs?: number;
  /** True for `TimerCondition: "any"` timers that cancel on any wake message. */
  cancelOnSystemMessage?: boolean;
  /** Long-running daemon command/cron (`IsDaemon: true`) that must not hold turns open. */
  daemon?: boolean;
  done: boolean;
  /** Modus stopped waiting on it at the hold limit. */
  released: boolean;
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
  /** Mode the live ACP session actually reports (`default`, `auto`, `accept-edits`, `plan`). */
  currentModeId?: string;
  /** Whether the running `agy acp` process was launched with `--sandbox`. */
  sandboxFlag: boolean;
  /** Whether Modus explicitly applied a mode override on this session. */
  modeOverrideApplied: boolean;
  model?: string;
  effort?: string;
  restartBeforeNextTurn: boolean;
  command: AntigravityCommand;
  /** Denials already explained in this turn's transcript. */
  noticedDenials: Set<string>;
  /** Tool calls in this turn that went through Modus approval. */
  askedToolIds: Set<string>;
  /** Restricted tools Antigravity ran without asking, already reported this session. */
  unaskedNoticed: Set<string>;
  sandboxFailureNoticed: boolean;
  /** Model rounds that ended in tool calls this turn, for `maxTurns`. */
  rounds: number;
  lastWasTool: boolean;
  maxTurnsReached: boolean;
  /** Mid-turn prompts in flight; the turn is not finished until they settle. */
  steering: Set<Promise<unknown>>;
  steerUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** Latest context-window metrics reported by ACP `usage_update` (agy 1.5.8+). */
  contextWindow?: number;
  contextTokensUsed?: number;
  /** The prompt has returned and the turn is waiting on agy's background work. */
  holding: boolean;
  /** agy 1.5.10+ streamed post-wake activity natively while held, so no wake prompt is needed. */
  streamedDuringHold: boolean;
  /** Timestamp of the latest streamed update received while holding. */
  lastHoldStreamAt: number;
  /** Transcript shows a final post-wake model reply during an unprompted hold stream. */
  holdFinalResponseSeen: boolean;
  /** The user spoke during the hold, so background commands no longer keep it open. */
  holdReleased: boolean;
  holdLimitMs: number;
  holdPollMs: number;
  /** Grace window to let agy 1.5.10+ start streaming natively before sending a wake prompt. */
  wakeGraceMs: number;
  /** Quiet window after an unprompted hold stream when transcript has no final step yet. */
  holdStreamSettleMs: number;
  /** How far agy's record may trail what it does: a timer's firing, or a command's background step. */
  transcriptLagMs: number;
  /** How often an idle session checks agy's record for work agy started on its own. */
  idleWatchMs: number;
  transcriptPath: (providerSessionId: string) => string;
  /** agy's step record from where the current turn began; see antigravity-transcript.ts. */
  transcript: AntigravityTranscriptTail | null;
  /** agy's background tasks this turn, by task id: its own ledger of what it is waiting on. */
  tasks: Map<string, BackgroundTask>;
  /** How many `run_command` calls with each command line agy's record shows this turn. */
  commandCalls: Map<string, number>;
  /** Recorded `schedule` calls this turn, in order, for daemon/TimerCondition metadata. */
  scheduleCalls: Array<{ daemon: boolean; cancelOnSystemMessage: boolean }>;
  /** Stops watching an idle session's record; set while a watch runs. */
  stopIdleWatch: (() => void) | null;
  cleanupLegacyPlugin: ((executable: string) => Promise<void>) | undefined;
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
export function antigravityUsage(result: any): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
} {
  const usage = asObject(result?.usage ?? result?._meta?.usage);
  const input = numberValue(usage.inputTokens, usage.input_tokens);
  const output = numberValue(usage.outputTokens, usage.output_tokens);
  const cacheRead = numberValue(usage.cachedReadTokens, usage.cache_read_tokens, usage.cacheReadInputTokens);
  const cacheWrite = numberValue(usage.cachedWriteTokens, usage.cache_write_tokens, usage.cacheCreationInputTokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: numberValue(usage.totalTokens, usage.total_tokens, input + output),
  };
}

export function isDaemonToolInput(input: Record<string, unknown>): boolean {
  return input.IsDaemon === true || input.IsDaemon === "true";
}

function controlsFrom(ctx: TurnContext): AntigravityControls {
  const controls = ctx.session._configOverrides.providerControls ?? ctx.opts.providerControls ?? ctx.profile?.providerControls;
  return asObject(asObject(controls).antigravity) as AntigravityControls;
}

const ANTIGRAVITY_SHELL_TOOLS = new Set(["run_command"]);

export function needsApproval(policy: PermissionPolicy, toolName: string): boolean {
  return permissionPolicyNeedsApproval(policy, toolName, ANTIGRAVITY_SHELL_TOOLS);
}

/** The full decision, with the restriction that denied the tool when one did. */
export function antigravityToolDecision(ctx: TurnContext, toolName: string): ToolDecision {
  return decideTool(ctx.session, toolName, toolRestrictionConfig(ctx), {
    aliases: ANTIGRAVITY_CAPABILITIES.toolAliases,
    shellTools: ANTIGRAVITY_SHELL_TOOLS,
  });
}

export function toolDecision(ctx: TurnContext, toolName: string): "allow" | "ask" | "deny" {
  return antigravityToolDecision(ctx, toolName).decision;
}

/**
 * The user asked for the terminal sandbox, explicitly or through auto mode,
 * which turns it on. A command that asks to leave it is never answered from
 * the policy alone: Antigravity's own default is to pause for approval, and
 * Google's safety monitors flag sandbox escapes.
 */
export function sandboxRequested(controls: AntigravityControls, currentModeId?: string): boolean {
  return controls.sandbox === true || (controls.mode ?? currentModeId) === "auto";
}

export function requestsSandboxBypass(input: Record<string, unknown>): boolean {
  return input.BypassSandbox === true || input.BypassSandbox === "true";
}

/** `agy` reports a sandbox that cannot start as the command's own output. */
export function isSandboxStartFailure(output: unknown): boolean {
  const text = typeof output === "string" ? output : stringify(output);
  return /exebox:\s*creating sandbox/i.test(text);
}

export const ANTIGRAVITY_SANDBOX_FAILURE_NOTICE =
  "Antigravity's terminal sandbox failed to start on this machine, so every sandboxed command fails. "
  + "Auto mode and the sandbox control both turn it on; switch to default or accept-edits mode with the sandbox off to run commands. "
  + "Commands that ask to bypass the sandbox wait for your approval.";

/** HTTP MCP servers need `--process-per-session` (Antigravity ACP guide). */
export function antigravityLaunchArgs(controls: AntigravityControls, servers: Array<{ type?: string }> = []): string[] {
  const remoteMcp = servers.some((server) => server.type === "http" || server.type === "sse");
  return [
    "acp",
    ...(controls.sandbox ? ["--sandbox"] : []),
    ...(remoteMcp ? ["--process-per-session"] : []),
  ];
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
  countModelRound(ctx, state);
  return tool;
}

export function antigravityMaxTurns(ctx: TurnContext): number | undefined {
  const value = ctx.session._configOverrides.maxTurns ?? ctx.opts.maxTurns ?? ctx.profile?.maxTurns;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * ACP has no turn limit, so Modus counts model rounds the way the Gemini CLI
 * provider did: consecutive tool calls are one round, and a round that would
 * need another model call past `maxTurns` ends the turn with `error_max_turns`.
 */
function countModelRound(ctx: TurnContext, state: AntigravityState): void {
  // Calls already in flight when the cancel lands are not new rounds.
  if (state.maxTurnsReached) return;
  if (!state.lastWasTool) state.rounds += 1;
  state.lastWasTool = true;
  const limit = antigravityMaxTurns(ctx);
  if (!limit || state.maxTurnsReached || state.rounds < limit) return;
  state.maxTurnsReached = true;
  if (state.providerSessionId) {
    try { state.client?.notify("session/cancel", { sessionId: state.providerSessionId }); } catch {}
  }
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

const ANTIGRAVITY_IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Largest picture Modus copies into a transcript; the Claude API's own per-image limit. */
export const ANTIGRAVITY_IMAGE_READ_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * agy's `read_file` of a picture shows the model the image but sends the
 * client no content at all (agy 1.5.12), so the transcript had only a
 * completion line. The file agy just read is the image, so Modus loads it,
 * for image extensions only and up to the size limit.
 */
export function antigravityReadImage(
  input: Record<string, unknown>,
  cwd: string,
  limitBytes = ANTIGRAVITY_IMAGE_READ_LIMIT_BYTES,
): Record<string, unknown> | null {
  const requested = typeof input.Path === "string" ? input.Path.trim() : "";
  if (!requested) return null;
  const mediaType = ANTIGRAVITY_IMAGE_TYPES[extname(requested).toLowerCase()];
  if (!mediaType) return null;
  const path = isAbsolute(requested) ? requested : resolve(cwd, requested);
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size === 0 || stats.size > limitBytes) return null;
    return { type: "image", source: { type: "base64", media_type: mediaType, data: readFileSync(path).toString("base64") } };
  } catch {
    return null;
  }
}

/** A `read_file` result with the picture it read, when ACP carried none. */
function withReadImage(
  output: string | Array<Record<string, unknown>>,
  tool: ToolState,
  cwd: string,
): string | Array<Record<string, unknown>> {
  if (tool.name !== "read_file" || typeof output !== "string") return output;
  const image = antigravityReadImage(tool.input, cwd);
  if (!image) return output;
  return output && output !== "tool call completed" ? [{ type: "text", text: output }, image] : [image];
}

function handleUpdate(ctx: TurnContext, state: AntigravityState, params: any): void {
  const update = params?.update ?? params;
  const type = update?.sessionUpdate ?? update?.session_update;
  // Mode and context-window updates matter even between turns; everything else
  // belongs to a turn (`session/load` also replays history as updates, which must not re-render).
  if (type === "current_mode_update" && typeof update.currentModeId === "string") {
    state.currentModeId = update.currentModeId;
    ctx.notifyConfigChange({ providerControls: { antigravity: { ...controlsFrom(ctx), mode: update.currentModeId } } });
    return;
  }
  if (type === "usage_update") {
    const size = numberValue(update?.size);
    if (size > 0) state.contextWindow = size;
    if (typeof update?.used === "number" && Number.isFinite(update.used) && update.used >= 0) {
      state.contextTokensUsed = update.used;
    }
    return;
  }
  if (!state.turnActive) return;
  ctx.session.lastEventAt = Date.now();
  if (type === "agent_message_chunk") {
    const text = update?.content?.text;
    if (typeof text !== "string") return;
    if (state.holding) {
      state.streamedDuringHold = true;
      state.lastHoldStreamAt = Date.now();
    }
    state.lastWasTool = false;
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
    if (state.holding) {
      state.streamedDuringHold = true;
      state.lastHoldStreamAt = Date.now();
    }
    state.lastWasTool = false;
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
    const callId = String(update.toolCallId ?? update.tool_call_id ?? "");
    const existed = !!callId && state.tools.has(callId);
    const tool = emitToolStart(ctx, state, update);
    if (state.holding && !existed) {
      state.streamedDuringHold = true;
      state.lastHoldStreamAt = Date.now();
    }
    const status = update.status;
    if (!tool.resultEmitted && (status === "completed" || status === "failed")) {
      if (state.holding && state.streamedDuringHold) state.lastHoldStreamAt = Date.now();
      tool.resultEmitted = true;
      const output = status === "completed"
        ? withReadImage(antigravityToolOutput(update), tool, ctx.session.cwd ?? ctx.opts.cwd ?? process.cwd())
        : antigravityToolOutput(update);
      ctx.emitEvent({
        type: "user",
        subtype: "tool_result",
        isSynthetic: true,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: tool.id,
            content: output,
            is_error: status === "failed",
          }],
        },
      });
      reportUnaskedRestrictedTool(ctx, state, tool);
      if (!state.sandboxFailureNoticed && tool.name === "run_command" && isSandboxStartFailure(output)) {
        state.sandboxFailureNoticed = true;
        emitProviderNotice(ctx, ANTIGRAVITY_SANDBOX_FAILURE_NOTICE);
      }
    }
    return;
  }
  if (type === "plan") {
    ctx.emitEvent({ type: "system", subtype: "plan", plan: update.entries ?? update.plan ?? [] });
  }
}

/**
 * Antigravity runs some tools without asking (reads, web search, MCP, and in
 * auto mode everything it judges safe), so a restriction Modus cannot enforce
 * on them must at least be visible. Reported once per tool per session.
 */
function reportUnaskedRestrictedTool(ctx: TurnContext, state: AntigravityState, tool: ToolState): void {
  if (state.askedToolIds.has(tool.id)) return;
  const restriction = toolRestriction(tool.name, toolRestrictionConfig(ctx), ANTIGRAVITY_CAPABILITIES.toolAliases);
  if (!restriction) return;
  const key = tool.name.toLowerCase();
  if (state.unaskedNoticed.has(key)) return;
  state.unaskedNoticed.add(key);
  const mode = controlsFrom(ctx).mode ?? state.currentModeId ?? "default";
  const blocked = describeToolRestriction(tool.name, restriction, ANTIGRAVITY_CAPABILITIES.toolAliases)
    .replace(/^Modus blocked `[^`]+`: /, "");
  const asks = ANTIGRAVITY_MODE_ASKS[mode];
  emitProviderNotice(
    ctx,
    `Antigravity ran \`${tool.name}\` without asking Modus, so this restriction could not stop it: ${blocked}`
      + (asks ? ` In ${mode} mode Antigravity only asks before ${asks}.` : ""),
  );
}

/** What each mode routes to Modus for approval, as measured against agy 1.5.7. */
const ANTIGRAVITY_MODE_ASKS: Partial<Record<string, string>> = {
  default: "commands and file edits",
  "accept-edits": "commands",
  auto: "commands it judges risky",
};

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
  if (state.holding) {
    state.streamedDuringHold = true;
    state.lastHoldStreamAt = Date.now();
  }
  const call = params?.toolCall ?? {};
  const { name: toolName, input } = normalizeAntigravityToolCall(call);
  const toolCallId = call.toolCallId ?? call.tool_call_id;
  if (toolCallId != null) state.askedToolIds.add(String(toolCallId));
  const options = Array.isArray(params?.options) ? params.options : [];
  const resolved = antigravityToolDecision(ctx, toolName);
  const sandboxEscape = requestsSandboxBypass(input) && sandboxRequested(controlsFrom(ctx), state.currentModeId);
  let decision = resolved.decision;
  if (resolved.decision === "deny") {
    noticeToolDenied(ctx, state.noticedDenials, toolName, resolved.restriction, ANTIGRAVITY_CAPABILITIES);
  } else if (sandboxEscape) {
    decision = "ask";
  }
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
      // A sandbox escape is approved once: "allow always" could become a
      // standing agy rule that lets later escapes skip the user.
      const persistent = response.behavior === "allow" && ctx.session.sessionApprovals.has(toolName) && !sandboxEscape;
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
    toolInput: input,
    ...(toolCallId != null ? { toolUseID: String(toolCallId) } : {}),
    interactive: false,
    decisionReason: sandboxEscape
      ? "Command requests running outside the terminal sandbox"
      : `${toolName} requires approval`,
  });
}

function recordSessionModels(ctx: TurnContext, state: AntigravityState, result: any): void {
  const models = result?.models;
  if (Array.isArray(models?.availableModels)) {
    state.availableModels = models.availableModels
      .filter((entry: any) => typeof entry?.modelId === "string")
      .map((entry: any) => ({ modelId: entry.modelId, name: typeof entry.name === "string" ? entry.name : undefined }));
  }
  if (typeof models?.currentModelId === "string") {
    state.currentModelId = models.currentModelId;
    if (!ctx.session.model) ctx.session.model = models.currentModelId;
  }
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
  const resolvedServers = mcpServers(ctx);
  const client = new GrokAcpClient({
    executable: state.command.executable,
    args: [...state.command.prefixArgs, ...antigravityLaunchArgs(controls, resolvedServers)],
    cwd,
    env,
    sensitiveValues: [env.GEMINI_API_KEY, env.GOOGLE_API_KEY],
    label: "Antigravity ACP",
  });
  state.client = client;
  state.sandboxFlag = !!controls.sandbox;
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
  const initResult = await client.request("initialize", ANTIGRAVITY_INITIALIZE_PARAMS, 60_000);
  const supportsResume = initResult?.agentCapabilities?.sessionCapabilities?.resume != null;

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
    const resumeParams = { ...sessionParams, sessionId: state.providerSessionId };
    if (supportsResume) {
      try {
        created = await client.request("session/resume", resumeParams, 60_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/method not found|unsupported|unknown method|-32601/i.test(message)) throw error;
        created = await client.request("session/load", resumeParams, 60_000);
      }
    } else {
      created = await client.request("session/load", resumeParams, 60_000);
    }
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
  recordSessionModels(ctx, state, created);
  if (typeof created?.modes?.currentModeId === "string") {
    state.currentModeId = created.modes.currentModeId;
  }
  if (controls.mode && state.providerSessionId) {
    await client.request("session/set_mode", { sessionId: state.providerSessionId, modeId: controls.mode }, 30_000);
    state.currentModeId = controls.mode;
    state.modeOverrideApplied = true;
  } else {
    state.modeOverrideApplied = false;
  }
}

/** Apply the requested model and thinking level before each turn. */
async function applyModel(ctx: TurnContext, client: GrokAcpClient, state: AntigravityState): Promise<void> {
  if (!state.providerSessionId) return;
  const requested = state.model ?? ctx.profile?.model ?? (state.effort ? state.currentModelId : undefined);
  if (!requested) return;
  const modelId = resolveAntigravityModelId(state.availableModels, requested, state.effort);
  if (!modelId) {
    const offered = state.availableModels.map((entry) => entry.modelId).join(", ");
    throw new Error(`Antigravity does not offer model "${requested}" on this account.${offered ? ` Available: ${offered}.` : ""}`);
  }
  if (modelId === state.currentModelId) {
    ctx.session.model = modelId;
    return;
  }
  await client.request("session/set_model", { sessionId: state.providerSessionId, modelId }, 30_000);
  state.currentModelId = modelId;
  ctx.session.model = modelId;
}

/** Apply mode changes live via ACP without relaunching the `agy acp` process. */
async function applyMode(ctx: TurnContext, client: GrokAcpClient, state: AntigravityState): Promise<void> {
  if (!state.providerSessionId) return;
  const desired = controlsFrom(ctx).mode;
  if (desired) {
    if (desired === state.currentModeId) return;
    await client.request("session/set_mode", { sessionId: state.providerSessionId, modeId: desired }, 30_000);
    state.currentModeId = desired;
    state.modeOverrideApplied = true;
    return;
  }
  if (state.modeOverrideApplied && state.currentModeId && state.currentModeId !== "default") {
    await client.request("session/set_mode", { sessionId: state.providerSessionId, modeId: "default" }, 30_000);
    state.currentModeId = "default";
    state.modeOverrideApplied = false;
  }
}

function emitInit(ctx: TurnContext, state: AntigravityState): void {
  const model = state.currentModelId ?? state.model ?? ctx.opts.model ?? ctx.profile?.model ?? "";
  const baseControls = ctx.session._configOverrides.providerControls ?? ctx.opts.providerControls ?? ctx.profile?.providerControls ?? {};
  const agControls = asObject(asObject(baseControls).antigravity);
  const providerControls = state.currentModeId && !agControls.mode
    ? { ...baseControls, antigravity: { ...agControls, mode: state.currentModeId } }
    : baseControls;
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
      providerControls,
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
  // `type: "error"` is always promoted to durable storage and reconstructed on
  // reload (`event-persistence.ts`, `session-history.ts`); a `result/error`
  // with no assistant turn is dropped on reload.
  ctx.broadcastEvent({ type: "error", error: message });
  ctx.emitEvent({ type: "done" });
}

function finishTurn(
  ctx: TurnContext,
  state: AntigravityState,
  subtype: "success" | "error_max_turns",
  result: any,
): void {
  const { session } = ctx;
  const usage = antigravityUsage(result);
  const cacheRead = usage.cacheRead + state.steerUsage.cacheRead;
  const cacheWrite = usage.cacheWrite + state.steerUsage.cacheWrite;
  ctx.emitEvent({
    type: "result",
    subtype,
    result: state.turnText,
    stop_reason: subtype === "error_max_turns" ? "max_turns" : result?.stopReason,
    harness_duration_ms: Date.now() - session.turnStartedAt,
    input_tokens: usage.input + state.steerUsage.input,
    output_tokens: usage.output + state.steerUsage.output,
    ...(cacheRead > 0 ? { cache_read_tokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
    ...(state.contextWindow ? { context_window: state.contextWindow } : {}),
    ...(state.contextTokensUsed != null ? { context_tokens_used: state.contextTokensUsed } : {}),
    total_tokens: usage.total + state.steerUsage.total,
    // Model calls, as Claude counts them: one per tool batch, plus the final
    // reply unless the limit cut the turn off before it.
    num_turns: subtype === "error_max_turns" ? state.rounds : state.rounds + 1,
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
}

/**
 * Antigravity steers a running turn when a second `session/prompt` arrives
 * during it (Antigravity ACP guide: "sending a prompt while a turn runs steers
 * that turn"). The request only settles when that turn ends, so acceptance is
 * the absence of an immediate rejection: a refusal inside the grace window
 * falls back to the queue, and the turn waits for the steer before finishing.
 */
export const ANTIGRAVITY_STEER_REJECTION_WINDOW_MS = 1_500;

async function steerTurn(ctx: TurnContext, state: AntigravityState, content: MessageContent): Promise<boolean> {
  const client = state.client;
  if (!state.turnActive || state.disposed || !client?.running || !state.providerSessionId) return false;
  // agy answers the steer when its run ends, which is the end of the hold.
  if (state.holding) state.holdReleased = true;
  const sentAt = Date.now();
  const request = client.request("session/prompt", {
    sessionId: state.providerSessionId,
    prompt: contentBlocks(content),
  }, 24 * 60 * 60 * 1_000);
  // Tracked from the moment it is sent, so a turn that ends inside the grace
  // window still waits for it and keeps the steered reply.
  const tracked: Promise<void> = request.then(
    (result) => {
      const usage = antigravityUsage(result);
      state.steerUsage.input += usage.input;
      state.steerUsage.output += usage.output;
      state.steerUsage.cacheRead += usage.cacheRead;
      state.steerUsage.cacheWrite += usage.cacheWrite;
      state.steerUsage.total += usage.total;
    },
    (error) => {
      // An early refusal falls back to the queue; only a late one is news.
      if (Date.now() - sentAt < ANTIGRAVITY_STEER_REJECTION_WINDOW_MS || !state.turnActive) return;
      emitProviderNotice(ctx, `Antigravity did not take the steered message: ${error instanceof Error ? error.message : String(error)}`);
    },
  ).finally(() => { state.steering.delete(tracked); });
  state.steering.add(tracked);
  const early = await Promise.race([
    request.then(() => "settled" as const, () => "rejected" as const),
    Bun.sleep(ANTIGRAVITY_STEER_REJECTION_WINDOW_MS).then(() => "pending" as const),
  ]);
  return early !== "rejected";
}

/**
 * `run_command` moves a command to the background after `WaitMsBeforeAsync`,
 * and `schedule` sets a timer the same way; agy can end its reply while either
 * runs. When one finishes, agy wakes and works on, but with no prompt open it
 * streams nothing and its approvals wait (see antigravity-transcript.ts). So a
 * turn whose reply leaves background work stays open, held on agy's own record
 * of the tasks it started and finished. When that record shows agy woke, Modus
 * sends a prompt, which reconnects the stream and joins the run agy already
 * started. That prompt returns when agy's run ends, which ends the turn.
 */
export const ANTIGRAVITY_HOLD_LIMIT_MS = 30 * 60_000;
const HOLD_POLL_MS = 500;
const WAKE_GRACE_MS = 250;
const HOLD_STREAM_SETTLE_MS = 2_000;
/** agy writes a step when the step completes, so its record trails what it does. */
const TRANSCRIPT_LAG_MS = 10_000;
const IDLE_WATCH_MS = 2_000;

/** What Modus sends when agy wakes; agy folds it into the run it already started. */
export const ANTIGRAVITY_WAKE_PROMPT = "Your background command finished. Carry on with what you were doing.";

export const ANTIGRAVITY_EXITED_DURING_HOLD =
  "Antigravity exited while it still had background work running, so whatever it would have done next is lost.";

function backgroundCommands(state: AntigravityState): ToolState[] {
  return [...state.tools.values()].filter((tool) =>
    ANTIGRAVITY_SHELL_TOOLS.has(tool.name) && !tool.resultEmitted && !tool.released && !isDaemonToolInput(tool.input));
}

function unquoteRecordedArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || trimmed === "true" || trimmed === "false") {
    try { return JSON.parse(trimmed); } catch {}
  }
  return trimmed;
}

function commandName(tool: ToolState): string {
  return commandLineText(tool.input.CommandLine) || tool.name;
}

function commandNames(tools: ToolState[]): string {
  return tools.map((tool) => `\`${commandName(tool)}\``).join(", ");
}

function minutes(ms: number): string {
  const value = Math.max(1, Math.round(ms / 60_000));
  return `${value} minute${value === 1 ? "" : "s"}`;
}

function beginTurnState(state: AntigravityState): void {
  state.text = "";
  state.thinking = "";
  state.turnText = "";
  state.tools.clear();
  state.noticedDenials.clear();
  state.askedToolIds.clear();
  state.rounds = 0;
  state.lastWasTool = false;
  state.maxTurnsReached = false;
  state.steerUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  state.holding = false;
  state.streamedDuringHold = false;
  state.lastHoldStreamAt = 0;
  state.holdFinalResponseSeen = false;
  state.holdReleased = false;
  state.tasks.clear();
  state.commandCalls.clear();
  state.scheduleCalls = [];
  state.transcript = state.providerSessionId
    ? new AntigravityTranscriptTail(state.transcriptPath(state.providerSessionId))
    : null;
}

/**
 * The `run_command` call a background task belongs to. agy's record lists each
 * call's command line, so the task of the nth call with a command line belongs
 * to the nth such call Modus saw. The description must match the whole command
 * line; when the record shows no call for it, the first untied match is used.
 */
function tieTaskToCommand(state: AntigravityState, description: string): string | undefined {
  const tied = new Set([...state.tasks.values()].map((task) => task.toolId));
  const matches = [...state.tools.values()].filter((tool) =>
    ANTIGRAVITY_SHELL_TOOLS.has(tool.name) && commandLineText(tool.input.CommandLine) === description);
  const nth = state.commandCalls.get(description) ?? 0;
  const byOrder = nth > 0 ? matches[nth - 1] : undefined;
  if (byOrder && !tied.has(byOrder.id)) return byOrder.id;
  return matches.find((tool) => !tied.has(tool.id))?.id;
}

/**
 * Read agy's new steps into the turn's task ledger. A finish becomes a call's
 * result only for the call its task is tied to, and only when ACP has not
 * already reported that call; a finish Modus cannot tie is nobody's result.
 * Also reports whether agy started working on its own after `since`.
 */
function readTranscript(ctx: TurnContext, state: AntigravityState, since: number): { woke: boolean; finished: ToolState[] } {
  const steps = state.transcript?.read() ?? [];
  const finished: ToolState[] = [];
  for (const step of steps) {
    for (const call of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
      const name = String(call?.name ?? "");
      if (ANTIGRAVITY_SHELL_TOOLS.has(name)) {
        const line = commandLineText(asObject(call?.args).CommandLine);
        state.commandCalls.set(line, (state.commandCalls.get(line) ?? 0) + 1);
      } else if (name === "schedule") {
        const args = asObject(call?.args);
        const rawDaemon = unquoteRecordedArg(args.IsDaemon);
        const rawCondition = unquoteRecordedArg(args.TimerCondition);
        state.scheduleCalls.push({
          daemon: rawDaemon === true || rawDaemon === "true",
          cancelOnSystemMessage: rawCondition === "any",
        });
      }
    }
    const started = backgroundTaskStarted(step);
    if (started && !state.tasks.has(started.taskId)) {
      const seconds = timerSeconds(started.description);
      const isScheduleTask = seconds !== null || /^Cron:/i.test(started.description);
      const scheduleMeta = isScheduleTask ? state.scheduleCalls.shift() : undefined;
      const toolId = isScheduleTask ? undefined : tieTaskToCommand(state, started.description);
      const tiedTool = toolId ? state.tools.get(toolId) : undefined;
      state.tasks.set(started.taskId, {
        taskId: started.taskId,
        description: started.description,
        toolId,
        startedAt: typeof step.created_at === "string" ? Date.parse(step.created_at) : NaN,
        ...(seconds === null ? {} : { timerMs: seconds * 1_000 }),
        cancelOnSystemMessage: isScheduleTask ? (scheduleMeta ? scheduleMeta.cancelOnSystemMessage : true) : false,
        daemon: isScheduleTask
          ? !!scheduleMeta?.daemon
          : (tiedTool ? isDaemonToolInput(tiedTool.input) : false),
        done: false,
        released: false,
      });
    }
    if (isSystemMessage(step)) {
      state.holdFinalResponseSeen = false;
      // Only timers configured with `TimerCondition: "any"` cancel on any wake message;
      // timers with default `"never"` keep running until their own deadline.
      for (const task of state.tasks.values()) {
        if (task.timerMs !== undefined && task.cancelOnSystemMessage) task.done = true;
      }
      if (backgroundTasksStopped(step)) {
        for (const task of state.tasks.values()) task.done = true;
        for (const tool of backgroundCommands(state)) tool.released = true;
      }
    }
    const done = backgroundTaskFinished(step);
    if (!done) continue;
    const task = state.tasks.get(done.taskId);
    if (task) task.done = true;
    const tool = task?.toolId ? state.tools.get(task.toolId) : undefined;
    if (!tool || tool.resultEmitted) continue;
    tool.resultEmitted = true;
    flushAssistantRound(ctx, state);
    ctx.emitEvent({
      type: "user",
      subtype: "tool_result",
      isSynthetic: true,
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: tool.id,
          content: done.output || (done.canceled ? "Command canceled." : "Command finished."),
          is_error: done.canceled,
        }],
      },
    });
    finished.push(tool);
  }
  if (state.holding && state.streamedDuringHold && endsWithFinalResponse(steps)) {
    state.holdFinalResponseSeen = true;
  }
  return { woke: agyWoke(steps, since), finished };
}

type HeldWork = { tasks: BackgroundTask[]; commands: ToolState[] };

/**
 * What keeps a held turn open: non-daemon tasks agy started and has not
 * finished, timers until their deadline, and non-daemon commands agy's record
 * does not account for. With no record, ACP is all Modus has; with one, a
 * command it does not show in the background is waited on only for as long as
 * the record can trail.
 */
function heldWork(state: AntigravityState, holdStartedAt: number): HeldWork {
  const now = Date.now();
  const tasks = [...state.tasks.values()].filter((task) => !task.done && !task.released && !task.daemon
    && (task.timerMs === undefined || !Number.isFinite(task.startedAt)
      || now < task.startedAt + task.timerMs + state.transcriptLagMs));
  const tied = new Set([...state.tasks.values()].map((task) => task.toolId));
  const untied = backgroundCommands(state).filter((tool) => !tied.has(tool.id));
  const recordShowsAll = !!state.transcript?.exists && now - holdStartedAt >= state.transcriptLagMs;
  return { tasks, commands: recordShowsAll ? [] : untied };
}

function heldNames(state: AntigravityState, held: HeldWork): string {
  const names = [
    ...held.tasks.map((task) => {
      const tool = task.toolId ? state.tools.get(task.toolId) : undefined;
      return tool ? commandName(tool) : task.description;
    }),
    ...held.commands.map(commandName),
  ];
  return names.map((name) => `\`${name}\``).join(", ");
}

/** Reconnect agy's stream to the run it started on its own. The reply belongs to this turn. */
function promptAfterWake(ctx: TurnContext, state: AntigravityState, client: GrokAcpClient, finished: ToolState[]): void {
  flushAssistantRound(ctx, state);
  const what = finished.length ? `${commandNames(finished)} finished in the background` : "Background work finished";
  emitProviderNotice(
    ctx,
    `${what} and Antigravity started working again. It only reports progress and asks for approvals while a prompt is open, `
      + `so Modus sent it one: "${ANTIGRAVITY_WAKE_PROMPT}"`,
    "info",
  );
  const request = client.request("session/prompt", {
    sessionId: state.providerSessionId,
    prompt: contentBlocks(ANTIGRAVITY_WAKE_PROMPT),
  }, 24 * 60 * 60 * 1_000);
  const tracked: Promise<void> = request.then(
    (result) => {
      const usage = antigravityUsage(result);
      state.steerUsage.input += usage.input;
      state.steerUsage.output += usage.output;
      state.steerUsage.cacheRead += usage.cacheRead;
      state.steerUsage.cacheWrite += usage.cacheWrite;
      state.steerUsage.total += usage.total;
    },
    (error) => {
      if (!state.turnActive) return;
      emitProviderNotice(ctx, `Antigravity did not take Modus's prompt after its background work: ${error instanceof Error ? error.message : String(error)}`);
    },
  ).finally(() => { state.steering.delete(tracked); });
  state.steering.add(tracked);
}

type HoldOutcome = "settled" | "woke" | "released" | "limit" | "stopped" | "exited";

/**
 * Wait on agy's background work after a prompt returned. Ends when agy wakes
 * (letting agy 1.5.10+ stream natively if it does, or prompting older agy to
 * reconnect the stream), when nothing is left running, when the user stops the
 * turn or sends a message, or at the hold limit.
 */
async function holdForBackgroundWork(
  ctx: TurnContext,
  state: AntigravityState,
  turnAbortController: AbortController,
  client: GrokAcpClient,
): Promise<HoldOutcome> {
  const since = Date.now();
  state.holding = true;
  state.streamedDuringHold = false;
  state.lastHoldStreamAt = 0;
  state.holdFinalResponseSeen = false;
  try {
    // Brings the ledger up to date before naming what is held, and catches a wake as the prompt returned.
    const first = readTranscript(ctx, state, since);
    let woke = first.woke;
    let wakeDetectedAt: number | null = null;
    const running = backgroundCommands(state);
    // agy wakes whenever a background task finishes. The finish can reach Modus
    // over ACP before agy records the wake step, so a command this hold waits
    // on finishing is itself the wake, whichever path reported it.
    const finished = () => [...first.finished, ...running.filter((tool) => tool.resultEmitted)];
    const held = heldWork(state, since);
    if (!woke && (held.tasks.length || held.commands.length)) {
      flushAssistantRound(ctx, state);
      emitProviderNotice(
        ctx,
        `Antigravity is still running ${heldNames(state, held)} in the background and picks the work back up when it finishes, `
          + `so this turn stays open until then, for up to ${minutes(state.holdLimitMs)}. Stop the turn or send a message to end it sooner.`,
        "info",
      );
    }
    const openNonDaemonTools = () => [...state.tools.values()].some((tool) =>
      !tool.resultEmitted && !tool.released && !isDaemonToolInput(tool.input));
    for (;;) {
      if (turnAbortController.signal.aborted || state.disposed || state.maxTurnsReached) return "stopped";
      if (state.client !== client || !client.running) return "exited";
      if (ctx.session.pendingDispatch.length) state.holdReleased = true;
      if (state.holdReleased) return "released";
      const left = heldWork(state, since);
      if (state.streamedDuringHold) {
        // agy 1.5.10+ streams post-wake work without needing a synthetic prompt.
        // Settle once all tasks, tools, and approvals are done and the reply completes.
        const idleAfterStream = !left.tasks.length && !left.commands.length
          && !openNonDaemonTools()
          && !state.pendingRpcPermissions.size && !state.steering.size;
        if (idleAfterStream && (state.holdFinalResponseSeen || Date.now() - state.lastHoldStreamAt >= state.holdStreamSettleMs)) {
          return "settled";
        }
      } else if (woke || running.some((tool) => tool.resultEmitted)) {
        wakeDetectedAt ??= Date.now();
        if (Date.now() - wakeDetectedAt >= state.wakeGraceMs) {
          promptAfterWake(ctx, state, client, finished());
          return "woke";
        }
      } else if (!left.tasks.length && !left.commands.length && !state.pendingRpcPermissions.size && !state.steering.size) {
        return "settled";
      }
      if (Date.now() - since >= state.holdLimitMs) {
        for (const task of left.tasks) task.released = true;
        for (const tool of backgroundCommands(state)) tool.released = true;
        flushAssistantRound(ctx, state);
        emitProviderNotice(
          ctx,
          `Modus stopped waiting on ${heldNames(state, left)} after ${minutes(state.holdLimitMs)}. `
            + "If Antigravity picks the work back up later, Modus opens a new turn for it.",
          "info",
        );
        return "limit";
      }
      await Bun.sleep(state.holdPollMs);
      woke = readTranscript(ctx, state, since).woke || woke;
    }
  } finally {
    state.holding = false;
  }
}

/**
 * agy can wake after its turn has ended: a command Modus stopped waiting on
 * finishes, or a task finishes that agy's record showed late. That work streams
 * nowhere until a prompt opens, so an idle session keeps reading agy's record,
 * and when agy wakes Modus opens a turn whose prompt joins the run.
 */
function watchAfterTurn(ctx: TurnContext, state: AntigravityState, client: GrokAcpClient): void {
  const transcript = state.transcript;
  state.stopIdleWatch?.();
  if (!transcript || state.disposed) return;
  const since = Date.now();
  const timer = setInterval(() => {
    if (state.disposed || state.turnActive || state.transcript !== transcript || state.client !== client || !client.running) {
      stop();
      return;
    }
    if (ctx.session.status !== "idle" || ctx.session.pendingDispatch.length) return;
    if (!agyWoke(transcript.read(), since)) return;
    stop();
    openWakeTurn(ctx, state);
  }, state.idleWatchMs);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    if (state.stopIdleWatch === stop) state.stopIdleWatch = null;
  };
  state.stopIdleWatch = stop;
}

function openWakeTurn(ctx: TurnContext, state: AntigravityState): void {
  const { session } = ctx;
  session.abortController = new AbortController();
  state.abortController = session.abortController;
  session.status = "starting";
  updateSessionStatus(session.sessionId, "starting");
  session.turnStartedAt = Date.now();
  void runTurn(ctx, state, ANTIGRAVITY_WAKE_PROMPT, { resume: true, wake: true });
}

/** Everything after the prompt returns, including background work it left running. */
async function concludeTurn(
  ctx: TurnContext,
  state: AntigravityState,
  turnAbortController: AbortController,
  client: GrokAcpClient,
  result: any,
): Promise<void> {
  const { session } = ctx;
  const stopped = () => turnAbortController.signal.aborted || result?.stopReason === "cancelled";
  for (;;) {
    // A steered message or Modus's wake prompt can outlive the prompt it
    // joined; its reply belongs to this turn, so keep collecting until it settles.
    while (state.steering.size) await Promise.allSettled([...state.steering]);
    if (stopped() || state.maxTurnsReached || state.disposed) break;
    // Settles at once when agy's record and ACP show nothing left running.
    const outcome = await holdForBackgroundWork(ctx, state, turnAbortController, client);
    if (outcome === "exited") {
      flushAssistantRound(ctx, state);
      emitTurnError(ctx, ANTIGRAVITY_EXITED_DURING_HOLD);
      return;
    }
    if (outcome === "released" && state.steering.size > 0) {
      // The user steered during the hold; await the steered prompt and re-check
      // whether it left new background work running.
      state.holdReleased = false;
      continue;
    }
    if (outcome !== "woke") break;
  }
  while (state.steering.size) await Promise.allSettled([...state.steering]);
  if (state.maxTurnsReached && !turnAbortController.signal.aborted) {
    flushAssistantRound(ctx, state);
    finishTurn(ctx, state, "error_max_turns", result);
    return;
  }
  if (stopped()) {
    flushAssistantRound(ctx, state);
    session.status = "idle";
    updateSessionStatus(session.sessionId, "idle");
    ctx.emitEvent({ type: "done" });
    return;
  }
  if (state.tools.size === 0 && isAntigravityVerificationNotice(state.turnText)) {
    state.thinking = "";
    state.text = "";
    emitTurnError(ctx, ANTIGRAVITY_VERIFICATION_MESSAGE);
    return;
  }
  flushAssistantRound(ctx, state);
  finishTurn(ctx, state, "success", result);
  watchAfterTurn(ctx, state, client);
}

function dispatchQueued(ctx: TurnContext, state: AntigravityState): void {
  const { session } = ctx;
  if (state.disposed || session.status !== "idle" || !session.pendingDispatch.length) return;
  const next = session.pendingDispatch.shift()!.content;
  session.initialContent = next;
  session.preview = contentPreview(next);
  session.abortController = new AbortController();
  state.abortController = session.abortController;
  session.status = "starting";
  updateSessionStatus(session.sessionId, "starting");
  session.turnStartedAt = Date.now();
  void runTurn(ctx, state, next, { resume: true });
}

async function runTurn(
  ctx: TurnContext,
  state: AntigravityState,
  content: MessageContent,
  options: { resume: boolean; wake?: boolean },
): Promise<void> {
  const { session } = ctx;
  const turnAbortController = state.abortController;
  let turnClient: GrokAcpClient | null = null;
  state.stopIdleWatch?.();
  try {
    if (state.cleanupLegacyPlugin) await state.cleanupLegacyPlugin(state.command.executable);
    await connect(ctx, state, options.resume);
    turnClient = state.client;
    if (!turnClient) throw new Error("Antigravity client closed during connection");
    await applyModel(ctx, turnClient, state);
    await applyMode(ctx, turnClient, state);
    if (options.wake) {
      emitProviderNotice(
        ctx,
        "Antigravity started working again after the last turn ended. It only reports progress and asks for approvals "
          + "while a prompt is open, so Modus opened this turn with one.",
        "info",
      );
    } else {
      // The harness keeps only a queue-time row; this is the message's transcript turn.
      // Synthesized wake continuations are not user prompts (see docs/providers.md).
      ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content } });
    }
    emitInit(ctx, state);
    beginTurnState(state);
    state.turnActive = true;
    session.status = "running";
    updateSessionStatus(session.sessionId, "running");
    const result = await turnClient.request("session/prompt", {
      sessionId: state.providerSessionId,
      prompt: contentBlocks(content),
    }, 24 * 60 * 60 * 1_000);
    await concludeTurn(ctx, state, turnAbortController, turnClient, result);
  } catch (error) {
    if (turnAbortController.signal.aborted) {
      flushAssistantRound(ctx, state);
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

  dispatchQueued(ctx, state);
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
  /** Test seams: how long a turn waits on background commands, and how often it checks. */
  holdLimitMs?: number;
  holdPollMs?: number;
  wakeGraceMs?: number;
  holdStreamSettleMs?: number;
  /** Test seams: how far agy's record may trail it, and how often an idle session reads it. */
  transcriptLagMs?: number;
  idleWatchMs?: number;
  /** Test seam: where agy keeps a conversation's step record. */
  transcriptPath?: (providerSessionId: string) => string;
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
        sandboxFlag: false,
        modeOverrideApplied: false,
        model: ctx.opts.model ?? ctx.profile?.model,
        effort: ctx.opts.effort ?? ctx.profile?.effort,
        restartBeforeNextTurn: false,
        command,
        noticedDenials: new Set(),
        askedToolIds: new Set(),
        unaskedNoticed: new Set(),
        sandboxFailureNoticed: false,
        rounds: 0,
        lastWasTool: false,
        maxTurnsReached: false,
        steering: new Set(),
        steerUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        holding: false,
        streamedDuringHold: false,
        lastHoldStreamAt: 0,
        holdFinalResponseSeen: false,
        holdReleased: false,
        holdLimitMs: options?.holdLimitMs ?? ANTIGRAVITY_HOLD_LIMIT_MS,
        holdPollMs: options?.holdPollMs ?? HOLD_POLL_MS,
        wakeGraceMs: options?.wakeGraceMs ?? WAKE_GRACE_MS,
        holdStreamSettleMs: options?.holdStreamSettleMs ?? HOLD_STREAM_SETTLE_MS,
        transcriptLagMs: options?.transcriptLagMs ?? TRANSCRIPT_LAG_MS,
        idleWatchMs: options?.idleWatchMs ?? IDLE_WATCH_MS,
        transcriptPath: options?.transcriptPath ?? ((id) => antigravityTranscriptPath(id)),
        transcript: null,
        tasks: new Map(),
        commandCalls: new Map(),
        scheduleCalls: [],
        stopIdleWatch: null,
        cleanupLegacyPlugin,
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
      ctx.session.status = "starting";
      updateSessionStatus(ctx.session.sessionId, "starting");
      ctx.session.turnStartedAt = Date.now();
      void runTurn(ctx, state, content, { resume: true });
    },

    steerMessage(ctx, content) {
      return steerTurn(ctx, getState(ctx.session), content);
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
      // Tools, tool states, maxTurns, permission policy, and ACP mode apply
      // without relaunching agy (`session/set_mode` runs before the next turn).
      // Only launch flags (--sandbox) and workspace roots require a respawn.
      if (config.providerControls !== undefined) {
        const nextSandbox = Boolean(asObject(asObject(config.providerControls).antigravity).sandbox);
        if (nextSandbox !== state.sandboxFlag) state.restartBeforeNextTurn = true;
      }
      if (config.additionalDirectories !== undefined || config.cwd !== undefined) {
        state.restartBeforeNextTurn = true;
      }
    },

    switchProfile(session, ctx) {
      const state = getState(session);
      state.model = ctx.opts.model ?? ctx.profile?.model;
      state.effort = ctx.opts.effort ?? ctx.profile?.effort;
      state.restartBeforeNextTurn = true;
    },

    async dispose(session) {
      const state = session._providerState as AntigravityState | null;
      if (!state) return;
      state.disposed = true;
      state.stopIdleWatch?.();
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
