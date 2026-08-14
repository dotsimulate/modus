import {
  ApprovalMode,
  AuthType,
  Config,
  convertSessionToClientHistory,
  GeminiEventType,
  MCPServerConfig,
  MessageBusType,
  Scheduler,
  ToolConfirmationOutcome,
  type ConversationRecord,
  type GeminiClient,
  type ResumedSessionData,
  type ToolCallRequestInfo,
  type ToolConfirmationRequest,
  type CompletedToolCall,
} from "@google/gemini-cli-core";
import { CoreEvent, coreEvents } from "@google/gemini-cli-core/dist/src/utils/events.js";
import { join } from "path";

function supportedLegacyAuthType(): AuthType | null {
  if (process.env.GEMINI_API_KEY) return AuthType.USE_GEMINI;
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === "true") {
    const hasVertexCredentials = !!process.env.GOOGLE_API_KEY
      || !!((process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID) && process.env.GOOGLE_CLOUD_LOCATION);
    if (hasVertexCredentials) return AuthType.USE_VERTEX_AI;
  }
  if (process.env.CLOUD_SHELL === "true" || process.env.GEMINI_CLI_USE_COMPUTE_ADC === "true") {
    return AuthType.COMPUTE_ADC;
  }
  return null;
}
import { getSession, updateSessionStatus } from "../db";
import { getGlobalConfig, resolveProfilePrompt, type McpServerConfig, type PermissionPolicy, type Profile } from "../profiles";
import { resolveSecret } from "../secrets";
import { contentPreview, createPendingDispatchItem, type ActiveSession, type MessageContent } from "../session-manager";
import type { SessionProvider, TurnContext } from "./types";
import { GEMINI_CAPABILITIES } from "./gemini-cli-capabilities";

type GeminiState = {
  sessionId: string;
  model: string;
  config: Config | null;
  client: GeminiClient | null;
  abortController: AbortController;
  textBuffer: string;
  thinkingBuffer: string;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  actualModel?: string;
  availableTools: string[];
  toolCallCount: number;
};


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function contentToGeminiParts(content: MessageContent): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push({ text: block.text });
      continue;
    }
    if (block.type === "image" && block.source) {
      parts.push({
        inlineData: {
          mimeType: block.source.media_type,
          data: block.source.data,
        },
      });
    }
  }
  return parts;
}

function buildGeminiTextInput(content: MessageContent, ctx: TurnContext): string {
  const prompt = resolveProfilePrompt(ctx.profile);
  const userInput = contentToString(content);
  if (!prompt?.text) return userInput;

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

function buildGeminiRequest(content: MessageContent, ctx: TurnContext): Array<Record<string, unknown>> {
  const parts = contentToGeminiParts(content);
  const text = buildGeminiTextInput(content, ctx);
  const nonTextParts = parts.filter((part) => !("text" in part));
  if (text || nonTextParts.length === 0) {
    nonTextParts.push({ text });
  }
  return nonTextParts;
}

function resolveMcpValue(value: string, serverName: string): string {
  if (!value.startsWith("$")) return value;
  const resolved = resolveSecret(value.slice(1));
  if (resolved !== undefined) return resolved;
  console.warn(`[gemini-cli] Missing secret ${value} for MCP server "${serverName}"`);
  return "";
}

function toGeminiMcpServer(serverName: string, server: McpServerConfig): MCPServerConfig {
  if ("command" in server) {
    const env = server.env
      ? Object.fromEntries(
          Object.entries(server.env)
            .map(([key, value]) => [key, resolveMcpValue(value, serverName)])
            .filter(([, value]) => value !== ""),
        )
      : undefined;
    return new MCPServerConfig(server.command, server.args, env);
  }

  if (server.type === "http") {
    return new MCPServerConfig(undefined, undefined, undefined, undefined, undefined, server.url, server.headers, undefined, "http");
  }

  return new MCPServerConfig(undefined, undefined, undefined, undefined, server.url, undefined, server.headers, undefined, "sse");
}

function buildGeminiMcpServers(ctx: TurnContext, profileDef: Profile | undefined): Record<string, MCPServerConfig> | undefined {
  const globalConfig = getGlobalConfig(ctx.session.cwd);
  const mergedMcp = {
    ...(globalConfig.mcpServers ?? {}),
    ...(profileDef?.mcpServers ?? {}),
    ...(ctx.opts.mcpServers as Record<string, any> ?? {}),
  };

  if (Object.keys(mergedMcp).length === 0) return undefined;

  return Object.fromEntries(
    Object.entries(mergedMcp).map(([name, server]) => [name, toGeminiMcpServer(name, server)]),
  );
}

function approvalModeForPolicy(policy: PermissionPolicy | undefined): ApprovalMode {
  if (!policy || policy === "bypass") return ApprovalMode.YOLO;
  if (policy === "ask") return ApprovalMode.DEFAULT;
  return policy.default === "approve" ? ApprovalMode.AUTO_EDIT : ApprovalMode.DEFAULT;
}

function resolveGeminiToolConfig(
  profileDef: Profile | undefined,
  opts: {
    tools?: string[];
    disallowedTools?: string[];
    toolStates?: Record<string, string>;
  },
): {
  allowedTools?: string[];
  excludeTools?: string[];
} {
  let allowed = opts.tools?.length
    ? new Set(opts.tools)
    : profileDef?.tools?.length
      ? new Set(profileDef.tools)
      : null;

  const excluded = new Set<string>([
    ...(profileDef?.disallowedTools ?? []),
    ...(opts.disallowedTools ?? []),
  ]);

  for (const [tool, state] of Object.entries(opts.toolStates ?? {})) {
    if (state === "off") {
      excluded.add(tool);
      allowed?.delete(tool);
      continue;
    }
    if (state === "on") {
      if (!allowed) allowed = new Set<string>();
      allowed.add(tool);
      excluded.delete(tool);
    }
  }

  return {
    ...(allowed && allowed.size > 0 ? { allowedTools: [...allowed] } : {}),
    ...(excluded.size > 0 ? { excludeTools: [...excluded] } : {}),
  };
}

function createAssistantEvent(text: string, thinking: string) {
  const content: Array<Record<string, unknown>> = [];
  if (thinking) content.push({ type: "thinking", thinking });
  if (text) content.push({ type: "text", text });
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
  };
}

function flushAssistantBuffer(ctx: TurnContext, state: GeminiState) {
  if (!state.textBuffer && !state.thinkingBuffer) return;
  ctx.emitEvent(createAssistantEvent(state.textBuffer, state.thinkingBuffer));
  ctx.session.lastAssistantText = state.textBuffer.slice(-200);
  state.textBuffer = "";
  state.thinkingBuffer = "";
}

function isTurnAborted(session: ActiveSession, state: GeminiState): boolean {
  return state.abortController.signal.aborted || session.abortController.signal.aborted;
}

function shouldMintGeminiSessionId(session: ActiveSession, options: { isResume: boolean }): boolean {
  if (options.isResume) return false;
  if (UUID_RE.test(session.sessionId)) return false;
  return true;
}

function formatThoughtDelta(value: { subject?: string; description?: string }): string {
  const subject = value.subject?.trim();
  const description = value.description?.trim();
  if (subject && description) return `${subject}: ${description}\n\n`;
  if (subject) return `${subject}\n\n`;
  if (description) return `${description}\n\n`;
  return "";
}

function stringifyToolPart(part: Record<string, any>): string | null {
  if (typeof part.text === "string" && part.text) return part.text;
  const response = part.functionResponse?.response;
  if (typeof response?.output === "string" && response.output) return response.output;
  if (response?.output !== undefined) return JSON.stringify(response.output, null, 2);
  if (response?.error !== undefined) return typeof response.error === "string"
    ? response.error
    : JSON.stringify(response.error, null, 2);
  return null;
}

function stringifyToolResult(parts: Array<Record<string, any>> | undefined): string {
  if (!parts?.length) return "";
  const chunks = parts
    .map((part) => stringifyToolPart(part))
    .filter((part): part is string => !!part);
  return chunks.length > 0 ? chunks.join("\n\n") : JSON.stringify(parts, null, 2);
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return fallback;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === "AbortError" || candidate.message === "The operation was aborted.";
}

function emitGeminiProviderMessage(
  ctx: TurnContext,
  content: string,
  severity: "info" | "warning" | "error" = "info",
) {
  const text = content.trim();
  if (!text) return;
  ctx.emitEvent({
    type: "system",
    subtype: "provider_message",
    severity,
    content: severity === "info" ? text : `${severity}: ${text}`,
  });
}

function describeToolCall(toolCall: { name?: unknown; args?: unknown } | undefined): string {
  const name = typeof toolCall?.name === "string" && toolCall.name ? toolCall.name : "unknown_tool";
  const args = toolCall?.args;
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.command === "string" && record.command.trim()) {
      return `${name} (${record.command.trim().slice(0, 120)})`;
    }
    if (typeof record.path === "string" && record.path.trim()) {
      return `${name} (${record.path.trim().slice(0, 120)})`;
    }
  }
  return name;
}

function formatRetryDelay(delayMs: number | undefined): string {
  if (!Number.isFinite(delayMs)) return "unknown delay";
  if (delayMs! >= 1000) return `${(delayMs! / 1000).toFixed(delayMs! >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(delayMs!)}ms`;
}

function formatFeedbackMessage(message: string, error?: unknown): string {
  const detail = extractErrorMessage(error, "").trim();
  if (!detail || detail === message) return message;
  return `${message}\n${detail}`;
}

async function loadResumedSessionData(config: Config, sessionId: string): Promise<ResumedSessionData | null> {
  const chatFiles = await config.storage.listProjectChatFiles();
  for (const chatFile of chatFiles) {
    const conversation = await config.storage.loadProjectTempFile<ConversationRecord>(chatFile.filePath);
    if (conversation?.sessionId !== sessionId) continue;
    return {
      conversation,
      filePath: join(config.storage.getProjectTempDir(), chatFile.filePath),
    };
  }
  return null;
}

async function createGeminiRuntime(
  ctx: TurnContext,
  state: GeminiState,
  options: { isResume: boolean },
) {
  const { session, opts, profile: profileDef } = ctx;
  const model = opts.model ?? profileDef?.model ?? state.model ?? "auto-gemini-3";
  state.model = model;

  const toolConfig = resolveGeminiToolConfig(profileDef, {
    tools: opts.tools,
    disallowedTools: opts.disallowedTools,
    toolStates: opts.toolStates,
  });

  const config = new Config({
    sessionId: session.sessionId,
    targetDir: session.cwd ?? process.cwd(),
    cwd: session.cwd ?? process.cwd(),
    debugMode: false,
    interactive: true,
    noBrowser: true,
    model,
    approvalMode: approvalModeForPolicy(opts.permissionPolicy ?? profileDef?.permissionPolicy),
    maxSessionTurns: opts.maxTurns ?? profileDef?.maxTurns,
    mcpServers: buildGeminiMcpServers(ctx, profileDef),
    ...toolConfig,
  });

  const cleanupFns: Array<() => void> = [];
  const cleanup = () => {
    while (cleanupFns.length > 0) {
      try {
        cleanupFns.pop()?.();
      } catch {
        // Ignore cleanup failures from third-party emitters.
      }
    }
  };

  try {
    // Suppress gemini-cli-core experiment/hook spam during init
    const _origLog = console.log;
    const _origWarn = console.warn;
    console.log = (...args: any[]) => {
      const msg = String(args[0] ?? "");
      if (msg.includes("experimentIds") || msg.includes("Experiments loaded") ||
          msg.includes("Hook registry") || msg.includes("Hook system") ||
          msg.includes(".geminiignore") || msg.includes("flagId") ||
          msg.includes("Loaded cached credentials")) return;
      _origLog(...args);
    };
    console.warn = (...args: any[]) => {
      const msg = String(args[0] ?? "");
      if (msg.includes(".geminiignore") || msg.includes("Ignore file not found")) return;
      _origWarn(...args);
    };
    await config.initialize();
    console.log = _origLog;
    console.warn = _origWarn;

    const policy: PermissionPolicy = opts.permissionPolicy ?? profileDef?.permissionPolicy ?? "bypass";
    const isBypass = policy === "bypass";
    const messageBus = config.getMessageBus();

    const onToolConfirmationRequest = async (request: ToolConfirmationRequest) => {
      const toolName = request.toolCall?.name ?? "unknown_tool";
      const correlationId = request.correlationId;

      if (isBypass) {
        await messageBus.publish({
          type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
          correlationId,
          confirmed: true,
          outcome: ToolConfirmationOutcome.ProceedOnce,
        });
        return;
      }

      const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      ctx.emitEvent({
        type: "system",
        subtype: "permission_request",
        requestId,
        toolName,
        toolInput: request.toolCall?.args ?? {},
        interactive: false,
        decisionReason: `${toolName} requires approval`,
      });

      const result = await new Promise<{ behavior: "allow" | "deny"; message?: string }>((resolve) => {
        session.pendingPermissions.set(requestId, {
          resolve,
          toolName,
          input: request.toolCall?.args ?? {},
          requestedAt: Date.now(),
        });
      });

      ctx.emitEvent({
        type: "system",
        subtype: "permission_resolved",
        requestId,
        behavior: result.behavior,
      });
      session.pendingPermissions.delete(requestId);

      if (result.behavior === "deny") {
        await messageBus.publish({
          type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
          correlationId,
          confirmed: false,
          outcome: ToolConfirmationOutcome.Cancel,
        });
      } else {
        await messageBus.publish({
          type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
          correlationId,
          confirmed: true,
          outcome: ToolConfirmationOutcome.ProceedOnce,
        });
      }
    };

    const onToolPolicyRejection = (message: { toolCall?: { name?: unknown; args?: unknown } }) => {
      emitGeminiProviderMessage(
        ctx,
        `Gemini policy rejected ${describeToolCall(message.toolCall)}.`,
        "warning",
      );
    };

    const onMessageBusError = (error: unknown) => {
      emitGeminiProviderMessage(
        ctx,
        extractErrorMessage(error, "Gemini message bus failed."),
        "error",
      );
    };

    const onUserFeedback = (payload: { severity: "info" | "warning" | "error"; message: string; error?: unknown }) => {
      emitGeminiProviderMessage(ctx, formatFeedbackMessage(payload.message, payload.error), payload.severity);
    };

    const onRetryAttempt = (payload: { attempt: number; maxAttempts: number; delayMs: number; error?: string; model: string }) => {
      const detail = payload.error ? `: ${payload.error}` : "";
      emitGeminiProviderMessage(
        ctx,
        `Gemini retry ${payload.attempt}/${payload.maxAttempts} (${payload.model})${detail}. Retrying in ${formatRetryDelay(payload.delayMs)}.`,
        "warning",
      );
    };

    const onOauthDisplayMessage = (message: string) => {
      emitGeminiProviderMessage(ctx, message, "info");
    };

    messageBus.subscribe(MessageBusType.TOOL_CONFIRMATION_REQUEST, onToolConfirmationRequest);
    messageBus.subscribe(MessageBusType.TOOL_POLICY_REJECTION, onToolPolicyRejection as never);
    messageBus.on("error", onMessageBusError);
    cleanupFns.push(() => messageBus.unsubscribe(MessageBusType.TOOL_CONFIRMATION_REQUEST, onToolConfirmationRequest));
    cleanupFns.push(() => messageBus.unsubscribe(MessageBusType.TOOL_POLICY_REJECTION, onToolPolicyRejection as never));
    cleanupFns.push(() => messageBus.off("error", onMessageBusError));

    coreEvents.on(CoreEvent.UserFeedback, onUserFeedback);
    coreEvents.on(CoreEvent.RetryAttempt, onRetryAttempt);
    coreEvents.on(CoreEvent.OauthDisplayMessage, onOauthDisplayMessage);
    cleanupFns.push(() => coreEvents.off(CoreEvent.UserFeedback, onUserFeedback));
    cleanupFns.push(() => coreEvents.off(CoreEvent.RetryAttempt, onRetryAttempt));
    cleanupFns.push(() => coreEvents.off(CoreEvent.OauthDisplayMessage, onOauthDisplayMessage));

    const authType = supportedLegacyAuthType();
    if (!authType) {
      throw new Error("The hidden legacy Gemini CLI provider does not reuse Gemini CLI OAuth. Configure GEMINI_API_KEY, an explicit Vertex AI environment, or compute ADC; use the public `antigravity` provider for Google AI plans.");
    }
    await config.refreshAuth(authType);

    const client = config.getGeminiClient();
    if (options.isResume) {
      const resumed = await loadResumedSessionData(config, state.sessionId);
      if (!resumed) {
        throw new Error(`Gemini native session ${state.sessionId} could not be resumed from local Gemini history; refusing to start a context-free replacement.`);
      }
      await client.resumeChat(convertSessionToClientHistory(resumed.conversation.messages), resumed);
    } else if (!client.isInitialized()) {
      await client.initialize();
    }

    state.config = config;
    state.client = client;
    state.availableTools = config.getToolRegistry().getAllToolNames();

    return { client, model, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function runTurn(
  ctx: TurnContext,
  state: GeminiState,
  content: MessageContent,
  options: { isResume: boolean; skipPromptPersist: boolean },
) {
  const { session, profile: profileDef } = ctx;
  if (shouldMintGeminiSessionId(session, options)) {
    const realId = crypto.randomUUID();
    ctx.setProviderSessionId(realId);
    ctx.rekeySession(realId);
    state.sessionId = realId;
  } else if (state.sessionId) {
    ctx.setProviderSessionId(state.sessionId);
  }
  state.textBuffer = "";
  state.thinkingBuffer = "";
  state.actualModel = undefined;
  state.availableTools = [];
  state.toolCallCount = 0;
  state.thinkingStartedAt = undefined;
  state.thinkingDurationMs = undefined;

  let finalized = false;
  let queuedNext: MessageContent | null = null;
  let cleanupRuntimeListeners: (() => void) | undefined;

  const finalizeSuccess = (usageMetadata: Record<string, any> | undefined) => {
    if (finalized) return;
    if (isTurnAborted(session, state)) {
      finalized = true;
      state.textBuffer = "";
      state.thinkingBuffer = "";
      return;
    }

    finalized = true;
    flushAssistantBuffer(ctx, state);

    const inputTokens = typeof usageMetadata?.promptTokenCount === "number" ? usageMetadata.promptTokenCount : 0;
    const outputTokens = typeof usageMetadata?.candidatesTokenCount === "number" ? usageMetadata.candidatesTokenCount : 0;
    const totalTokens = typeof usageMetadata?.totalTokenCount === "number"
      ? usageMetadata.totalTokenCount
      : inputTokens + outputTokens;
    const durationMs = Date.now() - session.turnStartedAt;
    const modelName = state.actualModel ?? state.model;

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
      tool_calls: state.toolCallCount,
      ...(state.thinkingDurationMs != null ? { thinking_duration_ms: state.thinkingDurationMs } : {}),
      modelUsage: {
        [modelName]: {
          inputTokens,
          outputTokens,
        },
      },
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

    if (session.pendingDispatch.length > 0) {
      queuedNext = session.pendingDispatch.shift()!.content;
    }
  };

  const finalizeError = (message: string) => {
    if (finalized) return;
    if (isTurnAborted(session, state)) {
      finalized = true;
      state.textBuffer = "";
      state.thinkingBuffer = "";
      return;
    }

    finalized = true;
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
      ...(state.thinkingDurationMs != null ? { thinking_duration_ms: state.thinkingDurationMs } : {}),
    });
    updateSessionStatus(session.sessionId, "error");
    ctx.emitEvent({ type: "done" });
  };

  const finalizeMaxTurns = () => {
    if (finalized) return;
    finalized = true;
    flushAssistantBuffer(ctx, state);
    ctx.emitEvent({
      type: "result",
      subtype: "error_max_turns",
      result: session.lastAssistantText || "",
      harness_duration_ms: Date.now() - session.turnStartedAt,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      num_turns: 1,
      total_cost_usd: 0,
      ...(state.thinkingDurationMs != null ? { thinking_duration_ms: state.thinkingDurationMs } : {}),
    });
    session.numTurns += 1;
    session.status = "idle";
    ctx.updateSessionDb({
      status: "idle",
      messageCount: session.numTurns * 2,
      costUsd: session.costUsd,
      lastPrompt: session.preview,
      lastResponse: session.lastAssistantText.slice(0, 200),
    });
  };

  try {
    const runtime = await createGeminiRuntime(ctx, state, { isResume: options.isResume });
    const { client, model } = runtime;
    cleanupRuntimeListeners = runtime.cleanup;

    session.status = "running";
    updateSessionStatus(session.sessionId, "running");

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
      session_id: session.sessionId,
      model,
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
      tools: state.availableTools,
    });

    const promptId = `${session.sessionId}-${Date.now()}`;
    const displayContent = contentToGeminiParts(content);
    let currentRequest: Array<Record<string, unknown>> = buildGeminiRequest(content, ctx);
    const maxRounds = ctx.opts.maxTurns ?? profileDef?.maxTurns ?? 25;
    let lastUsageMetadata: Record<string, any> | undefined;

    // ── Agentic loop: model call → tool execution → feed results → repeat ──
    for (let round = 0; round < maxRounds && !finalized && !isTurnAborted(session, state); round++) {
      const pendingCalls: ToolCallRequestInfo[] = [];

      for await (const event of client.sendMessageStream(
        currentRequest,
        state.abortController.signal,
        promptId,
        maxRounds - round,
        false,
        round === 0 ? displayContent : undefined,
      )) {
        if (isTurnAborted(session, state)) break;
        session.lastEventAt = Date.now();

        switch (event.type) {
          case GeminiEventType.ModelInfo:
            state.actualModel = event.value;
            break;

          case GeminiEventType.Thought: {
            const delta = formatThoughtDelta(event.value);
            if (!delta) break;
            state.thinkingStartedAt ??= Date.now();
            state.thinkingBuffer += delta;
            ctx.broadcastEvent({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "thinking_delta", thinking: delta },
              },
              provider: "gemini-cli",
            });
            break;
          }

          case GeminiEventType.Content: {
            if (event.value) {
              if (state.thinkingStartedAt && state.thinkingDurationMs == null) {
                state.thinkingDurationMs = Date.now() - state.thinkingStartedAt;
              }
              state.textBuffer += event.value;
              session.lastAssistantText = state.textBuffer.slice(-200);
              ctx.broadcastEvent({
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: event.value },
                },
                provider: "gemini-cli",
                fullText: state.textBuffer,
              });
            }
            break;
          }

          case GeminiEventType.ToolCallRequest:
            state.toolCallCount += 1;
            flushAssistantBuffer(ctx, state);
            pendingCalls.push(event.value as ToolCallRequestInfo);
            ctx.emitEvent({
              type: "assistant",
              message: {
                role: "assistant",
                content: [{
                  type: "tool_use",
                  id: event.value.callId,
                  name: event.value.name,
                  input: event.value.args ?? {},
                }],
              },
            });
            break;

          case GeminiEventType.ToolCallResponse: {
            // Core-emitted tool response (if core ever handles execution internally)
            const resultText = stringifyToolResult(event.value.responseParts as Array<Record<string, any>> | undefined);
            const errorText = event.value.error ? extractErrorMessage(event.value.error, "Gemini tool call failed") : "";
            ctx.emitEvent({
              type: "user",
              subtype: "tool_result",
              isSynthetic: true,
              message: {
                role: "user",
                content: [{
                  type: "tool_result",
                  tool_use_id: event.value.callId,
                  content: resultText || errorText || "tool call completed",
                  is_error: !!event.value.error,
                }],
              },
            });
            break;
          }

          case GeminiEventType.Finished:
            lastUsageMetadata = event.value.usageMetadata as Record<string, any> | undefined;
            break;

          case GeminiEventType.MaxSessionTurns:
            finalizeMaxTurns();
            break;

          case GeminiEventType.ContextWindowWillOverflow:
            finalizeError(
              `Gemini rejected the turn because it would exceed the remaining context window (${event.value.estimatedRequestTokenCount} requested, ${event.value.remainingTokenCount} remaining).`,
            );
            break;

          case GeminiEventType.LoopDetected:
            finalizeError("Gemini stopped because it detected a loop.");
            break;

          case GeminiEventType.AgentExecutionStopped:
          case GeminiEventType.AgentExecutionBlocked:
            finalizeError(event.value.systemMessage ?? event.value.reason ?? "Gemini execution was stopped.");
            break;

          case GeminiEventType.InvalidStream:
            finalizeError("Gemini returned an invalid stream.");
            break;

          case GeminiEventType.Error:
            finalizeError(extractErrorMessage((event.value as { error?: unknown } | undefined)?.error, "Gemini CLI turn failed"));
            break;

          case GeminiEventType.UserCancelled:
            if (!isTurnAborted(session, state)) {
              finalizeError("Gemini turn was cancelled.");
            }
            break;

          case GeminiEventType.Retry:
          case GeminiEventType.ChatCompressed:
          case GeminiEventType.Citation:
          case GeminiEventType.ToolCallConfirmation:
            break;
        }
      }

      // Stream ended for this round — decide what to do
      if (finalized || isTurnAborted(session, state)) break;

      // No pending tool calls → model is done
      if (pendingCalls.length === 0) {
        finalizeSuccess(lastUsageMetadata);
        break;
      }

      // ── Execute pending tool calls via Scheduler ──
      const scheduler = new Scheduler({
        config: state.config!,
        messageBus: state.config!.getMessageBus(),
        getPreferredEditor: () => undefined,
        schedulerId: `gemini-${session.sessionId}-${round}`,
      });

      try {
        const completed: CompletedToolCall[] = await scheduler.schedule(pendingCalls, state.abortController.signal);

        const responseParts: Array<Record<string, unknown>> = [];
        for (const call of completed) {
          const resultParts = call.response?.responseParts as Array<Record<string, any>> | undefined;
          const callError = call.response?.error;
          const errorMsg = callError ? extractErrorMessage(callError, "Tool call failed") : "";
          const resultText = stringifyToolResult(resultParts);

          // Emit tool result to harness UI
          ctx.emitEvent({
            type: "user",
            subtype: "tool_result",
            isSynthetic: true,
            message: {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: call.request.callId,
                content: resultText || errorMsg || "tool call completed",
                is_error: call.status === "error" || call.status === "cancelled",
              }],
            },
          });

          // Collect functionResponse parts for next model round
          if (resultParts?.length) {
            responseParts.push(...resultParts);
          } else {
            responseParts.push({
              functionResponse: {
                name: call.request.name,
                id: call.request.callId,
                response: { error: errorMsg || "Tool call produced no output" },
              },
            });
          }
        }

        // Record tool calls on chat for session history persistence
        try {
          client.getChat().recordCompletedToolCalls(
            state.actualModel ?? state.model,
            completed as any[],
          );
        } catch { /* recording is best-effort */ }

        // Feed tool results back as the next request
        currentRequest = responseParts;
      } finally {
        scheduler.dispose();
      }
    }

    if (!finalized && !isTurnAborted(session, state)) {
      finalizeMaxTurns();
    }
  } catch (error) {
    if (isTurnAborted(session, state) || isAbortError(error)) {
      return;
    }
    finalizeError(extractErrorMessage(error, "Gemini provider failed to start."));
  } finally {
    cleanupRuntimeListeners?.();
    try {
      state.client?.dispose();
    } catch {
      // Nothing to do — provider state should not survive a failed cleanup.
    }
    state.client = null;
    state.config = null;
  }

  if (queuedNext && !isTurnAborted(session, state)) {
    session.initialContent = queuedNext;
    session.preview = contentPreview(queuedNext);
    session.abortController = new AbortController();
    state.abortController = session.abortController;
    session.status = "running";
    session.turnStartedAt = Date.now();

    runTurn(ctx, state, queuedNext, { isResume: true, skipPromptPersist: true }).catch((err) => {
      console.error(`[gemini-cli] pending turn error for ${session.sessionId}:`, err);
      session.status = "error";
      session.error = String(err);
      updateSessionStatus(session.sessionId, "error");
      ctx.broadcastEvent({ type: "error", error: String(err) });
      ctx.emitEvent({ type: "done" });
    });
  }
}

export function createGeminiCliProvider(): SessionProvider {
  return {
    capabilities: GEMINI_CAPABILITIES,

    startTurn(ctx: TurnContext) {
      const { session, opts, profile: profileDef } = ctx;
      const isResume = !!opts.sessionId && !!getSession(opts.sessionId);
      const state: GeminiState = {
        sessionId: isResume ? (session.providerSessionId ?? opts.sessionId!) : session.sessionId,
        model: opts.model ?? profileDef?.model ?? "auto-gemini-3",
        config: null,
        client: null,
        abortController: session.abortController,
        textBuffer: "",
        thinkingBuffer: "",
        availableTools: [],
        toolCallCount: 0,
      };
      session._providerState = state;

      runTurn(ctx, state, session.initialContent, { isResume, skipPromptPersist: false }).catch((err) => {
        console.error(`[gemini-cli] startTurn error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
      });
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);

      // session-manager uses a temporary "starting" status while handing an
      // idle follow-up to the provider so SSE clients do not disconnect. Once
      // Gemini has a persisted session ID, that synthetic state should start
      // a new turn rather than being treated as an already-running turn.
      if (session.status === "running" || (session.status === "starting" && state.sessionId === session.tempId)) {
        session.pendingDispatch.push(createPendingDispatchItem(content, "next_turn", "sdk"));
        return;
      }

      session.abortController = new AbortController();
      state.abortController = session.abortController;
      session.initialContent = content;
      session.preview = contentPreview(content);
      session.status = "running";
      session.turnStartedAt = Date.now();
      updateSessionStatus(session.sessionId, "running");

      runTurn(ctx, state, content, { isResume: true, skipPromptPersist: true }).catch((err) => {
        console.error(`[gemini-cli] sendMessage error for ${session.sessionId}:`, err);
        session.status = "error";
        session.error = String(err);
        updateSessionStatus(session.sessionId, "error");
        ctx.broadcastEvent({ type: "error", error: String(err) });
        ctx.emitEvent({ type: "done" });
      });
    },

    abort(session: ActiveSession) {
      const state = getState(session);
      state.textBuffer = "";
      state.thinkingBuffer = "";
      try { state.abortController.abort(); } catch { /* AbortError from inflight operations */ }
      try { session.abortController.abort(); } catch { /* AbortError from inflight operations */ }
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      if (typeof config.model === "string" && config.model) {
        state.model = config.model;
      }
    },

    async dispose(session: ActiveSession) {
      const state = getState(session);
      try { state.abortController.abort(); } catch { /* AbortError from inflight operations */ }
      try {
        state.client?.dispose();
      } catch {
        // Ignore cleanup failures during session disposal.
      }
      state.client = null;
      state.config = null;
      session._providerState = null;
    },

    switchProfile(session: ActiveSession, ctx: TurnContext) {
      const state = getState(session);
      state.model = ctx.opts.model ?? ctx.profile?.model ?? state.model;
    },
  };
}
