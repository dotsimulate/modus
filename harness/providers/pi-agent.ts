/**
 * PI Agent Provider — PI AgentSession execution backend.
 *
 * Replaces the stateless Vercel AI SDK direct-api provider with PI's full
 * agent framework: multi-turn state, tool use loop, compaction, retry.
 *
 * Supports: Anthropic, OpenAI, LiteLLM (OpenAI-compat), Ollama (OpenAI-compat).
 */

import type { Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  createCodingTools,
  AuthStorage,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ProviderCapabilities, SessionProvider, TurnContext } from "./types";
import type { ActiveSession, MessageContent } from "../session-manager";
import { getGlobalConfig, getProfile, type ProviderDefaults } from "../profiles";
import { updateSessionStatus } from "../db";
import { startMcpServers, stopMcpServers, type McpConnection } from "./mcp-bridge";
import { resolveSecret } from "../secrets";

// ── Provider Names ──

export type PiProviderName = "anthropic" | "openai" | "litellm" | "ollama" | "openrouter";

const DEFAULT_MODELS: Record<PiProviderName, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  litellm: "default",
  ollama: "default",
  openrouter: "anthropic/claude-sonnet-4.5",
};

const PI_TOOL_GROUPS = [
  { label: "files", tools: ["read", "write", "edit"] },
  { label: "search", tools: ["grep", "find", "ls"] },
  { label: "exec", tools: ["bash"] },
] as const;

function buildPiCapabilities(providerName: PiProviderName): ProviderCapabilities {
  return {
    name: providerName,
    label: providerName,
    family: "pi-agent",
    builtInTools: PI_TOOL_GROUPS.flatMap((group) => [...group.tools]),
    builtInToolGroups: PI_TOOL_GROUPS.map((group) => ({ label: group.label, tools: [...group.tools] })),
    builtInToolMode: "explicit",
    supportsMcp: true,
    mcpSupport: "full",
    nonToolSignals: ["streaming"],
    permissionModel: {
      mode: "none",
      interactive: false,
      summary: "PI providers do not expose harness-managed per-tool approval prompts.",
    },
    sessionMutability: {
      providerSwitchAfterStart: false,
      profileSwitch: "provider-locked",
      configApplies: "next-turn",
    },
  };
}

// ── Provider-specific state on session._providerState ──

type PiAgentState = {
  agentSession: AgentSession;
  unsubscribe: () => void;
  mcpConnections: McpConnection[];
};

function getState(session: ActiveSession): PiAgentState | null {
  return session._providerState as PiAgentState | null;
}

// ── OpenRouter Pricing ──

type CostRates = { input: number; output: number; cacheRead: number; cacheWrite: number };
const ZERO_COST: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type OpenRouterModelInfo = { cost: CostRates; contextLength: number };

// Cache keyed by model ID, populated lazily from OpenRouter's /api/v1/models
let openRouterModelCache: Map<string, OpenRouterModelInfo> | null = null;

async function fetchOpenRouterModelInfo(modelId: string): Promise<OpenRouterModelInfo> {
  const EMPTY: OpenRouterModelInfo = { cost: ZERO_COST, contextLength: 0 };
  if (openRouterModelCache) return openRouterModelCache.get(modelId) ?? EMPTY;

  try {
    const baseUrl = resolveSecret("OPENROUTER_BASE_URL") ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { data?: { id: string; context_length?: number; pricing?: Record<string, string> }[] };
    openRouterModelCache = new Map();
    for (const m of json.data ?? []) {
      // OpenRouter prices are per-token strings; PI SDK wants per-million-token numbers
      openRouterModelCache.set(m.id, {
        contextLength: m.context_length ?? 0,
        cost: m.pricing ? {
          input: parseFloat(m.pricing.prompt || "0") * 1_000_000,
          output: parseFloat(m.pricing.completion || "0") * 1_000_000,
          cacheRead: parseFloat(m.pricing.input_cache_read || "0") * 1_000_000,
          cacheWrite: parseFloat(m.pricing.input_cache_write || "0") * 1_000_000,
        } : ZERO_COST,
      });
    }
    console.log(`[pi-agent] Cached OpenRouter model info for ${openRouterModelCache.size} models`);
    return openRouterModelCache.get(modelId) ?? EMPTY;
  } catch (err) {
    console.error(`[pi-agent] Failed to fetch OpenRouter model info:`, err);
    openRouterModelCache = new Map(); // don't retry on failure
    return EMPTY;
  }
}

// ── Model Construction ──

function buildModel(provider: PiProviderName, modelId: string, profile?: any, cost?: CostRates, contextLengthFromApi?: number): Model<any> {
  // Known providers: use PI's built-in model registry
  if (provider === "anthropic" || provider === "openai") {
    try {
      return getModel(provider as any, modelId as any);
    } catch {
      // Unknown model ID for known provider — construct manually
      const api = provider === "anthropic" ? "anthropic-messages" : "openai-completions";
      return {
        id: modelId,
        name: modelId,
        api,
        provider,
        baseUrl: provider === "anthropic"
          ? "https://api.anthropic.com"
          : "https://api.openai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: profile?.contextWindow ?? 200000,
        maxTokens: profile?.maxOutputTokens ?? (provider === "anthropic" ? 8192 : 0),
        compat: provider === "openai" ? {} : undefined,
      } as Model<any>;
    }
  }

  // OpenAI-compat providers (litellm, ollama, openrouter)
  const baseUrlEnv = provider === "litellm" 
    ? "LITELLM_BASE_URL" 
    : provider === "ollama"
    ? "OLLAMA_BASE_URL"
    : "OPENROUTER_BASE_URL";
  const defaultUrl = provider === "litellm"
    ? "http://localhost:4000/v1"
    : provider === "ollama"
    ? "http://localhost:11434/v1"
    : "https://openrouter.ai/api/v1";
  const baseUrl = resolveSecret(baseUrlEnv) ?? process.env[baseUrlEnv] ?? defaultUrl;
  const providerDefaults = getGlobalConfig().providerDefaults?.[provider];

  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: cost ?? ZERO_COST,
    contextWindow: profile?.contextWindow ?? providerDefaults?.contextWindow ?? contextLengthFromApi ?? 128000,
    maxTokens: profile?.maxOutputTokens ?? providerDefaults?.maxOutputTokens ?? 8192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: provider === "litellm" || provider === "openrouter",
      maxTokensField: "max_tokens",
    },
  } as Model<any>;
}

// ── Auth Storage Setup ──

function buildAuthStorage(provider: PiProviderName): AuthStorage {
  const auth = AuthStorage.inMemory();

  // Resolve API key from harness secrets for the provider
  const envMap: Record<PiProviderName, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    litellm: "LITELLM_API_KEY",
    ollama: "OLLAMA_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };

  const envVar = envMap[provider];
  const key = resolveSecret(envVar) ?? process.env[envVar];

  // setRuntimeApiKey is the highest priority in PI's auth chain —
  // bypasses env var lookup (which doesn't know litellm/ollama)
  auth.setRuntimeApiKey(provider, key || "unused");

  return auth;
}

// ── Friendly Errors (ported from direct-api.ts) ──

function getProviderUrl(provider: string): string {
  if (provider === "litellm") {
    const url = resolveSecret("LITELLM_BASE_URL") ?? process.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1";
    return url.replace(/^https?:\/\//, "").replace(/\/v1\/?$/, "");
  }
  if (provider === "ollama") {
    const url = resolveSecret("OLLAMA_BASE_URL") ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
    return url.replace(/^https?:\/\//, "").replace(/\/v1\/?$/, "");
  }
  if (provider === "openrouter") {
    const url = resolveSecret("OPENROUTER_BASE_URL") ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
    return url.replace(/^https?:\/\//, "").replace(/\/v1\/?$/, "");
  }
  return "";
}

function friendlyError(err: any, provider: string): string {
  const parts: string[] = [];
  let cur = err;
  while (cur) {
    if (cur.message) parts.push(String(cur.message));
    if (cur.responseBody) parts.push(String(cur.responseBody));
    if (cur.data?.error?.message) parts.push(String(cur.data.error.message));
    cur = cur.cause;
  }
  const raw = String(err?.message ?? err);
  const full = parts.join(" ");

  if (full.includes("ConnectionRefused") || full.includes("Unable to connect") || full.includes("ECONNREFUSED")) {
    const hint = getProviderUrl(provider);
    return `Cannot connect to ${provider}${hint ? ` (${hint})` : ""}. Is the service running?`;
  }
  if (full.includes("Invalid model name") || full.includes("does not exist") || full.includes("model_not_found")) {
    return `${provider}: invalid model name. Check your provider's model list.`;
  }
  if (full.includes("401") || full.includes("Unauthorized")) {
    return `${provider}: authentication failed. Check your API key.`;
  }
  if (full.includes("404") || full.includes("not_found") || full.includes("Not Found")) {
    return `${provider}: resource not found (404). Check model and server config.`;
  }
  if (full.includes("429") || full.includes("rate limit")) {
    return `${provider}: rate limited. Try again shortly.`;
  }
  const core = raw.replace(/^.*?Error:\s*/, "").slice(0, 200);
  return `${provider}: ${core}`;
}

// ── Content Helpers ──

/** Convert harness MessageContent to PI's native content format */
function contentToPi(content: MessageContent): any {
  if (typeof content === "string") return content;
  return (content as any[]).map((block: any) => {
    if (block.type === "text") return { type: "text" as const, text: block.text };
    if (block.type === "image" && block.source) {
      return { type: "image" as const, data: block.source.data, mimeType: block.source.media_type };
    }
    return { type: "text" as const, text: "" };
  });
}

/** Extract text and images from MessageContent for PI's prompt() signature */
function contentToPiPrompt(content: MessageContent): { text: string; images?: { type: "image"; data: string; mimeType: string }[] } {
  if (typeof content === "string") return { text: content };
  const blocks = content as any[];
  const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  const images = blocks
    .filter((b: any) => b.type === "image" && b.source)
    .map((b: any) => ({ type: "image" as const, data: b.source.data, mimeType: b.source.media_type }));
  return { text, images: images.length > 0 ? images : undefined };
}

// ── Event Translation ──

function translateEvents(
  event: AgentSessionEvent,
  ctx: TurnContext,
  providerName: PiProviderName,
) {
  const { session } = ctx;
  const ame = "assistantMessageEvent" in event ? (event as any).assistantMessageEvent : null;

  switch (event.type) {
    case "message_update": {
      if (!ame) break;

      if (ame.type === "text_delta") {
        session.lastAssistantText = (session.lastAssistantText + ame.delta).slice(-200);
        session.lastEventAt = Date.now();
        ctx.emitEvent({
          type: "stream_event",
          subtype: "content_block_delta",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: ame.delta },
          },
        });
      } else if (ame.type === "thinking_delta") {
        session.lastEventAt = Date.now();
        ctx.emitEvent({
          type: "stream_event",
          subtype: "content_block_delta",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: ame.delta },
          },
        });
      }
      break;
    }

    case "tool_execution_start": {
      session.lastEventAt = Date.now();
      ctx.emitEvent({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: event.toolCallId,
            name: event.toolName,
            input: event.args ?? {},
          }],
        },
      });
      break;
    }

    case "tool_execution_end": {
      session.lastEventAt = Date.now();
      // event.result is AgentToolResult { content: [{type:"text",text:"..."},...], details }
      const raw = event.result;
      const resultText = raw?.content
        ?.filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("") || JSON.stringify(raw);
      ctx.emitEvent({
        type: "user",
        isSynthetic: true,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: event.toolCallId,
            content: resultText,
            is_error: event.isError,
          }],
        },
      });
      break;
    }

    case "agent_end": {
      // If session was paused at a tool boundary, the abort was intentional —
      // don't transition to idle/done. Session stays paused until resumed.
      if (session.status === "paused") break;

      // If session was already stopped/interrupted by the user, don't process further.
      // stopSession() sets status to "idle" before calling abort, so agent_end
      // arrives after the session is already cleaned up.
      if (session.abortController.signal.aborted) {
        session.pendingMessages = [];
        break;
      }

      const messages = (event as any).messages ?? [];
      const lastAssistant = [...messages].reverse().find(
        (m: any) => m.role === "assistant",
      );
      const stopReason = lastAssistant?.stopReason;
      const wasAborted = stopReason === "aborted";
      const wasError = stopReason === "error";

      const resultText = lastAssistant
        ? (lastAssistant.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("")
        : session.lastAssistantText;

      // Extract usage from last assistant message
      const usage = lastAssistant?.usage;
      const inputTokens = usage?.input ?? 0;
      const outputTokens = usage?.output ?? 0;
      const costTotal = usage?.cost?.total ?? 0;

      const durationMs = Date.now() - session.turnStartedAt;
      session.numTurns++;
      session.costUsd += costTotal;

      if (wasError) {
        const errorMsg = lastAssistant?.errorMessage ?? "Unknown error";
        const message = friendlyError({ message: errorMsg }, providerName);
        ctx.emitEvent({ type: "result", subtype: "error", error: message });
        session.status = "error";
        session.error = message;
        ctx.updateSessionDb({ status: "error" });
      } else {
        ctx.emitEvent({
          type: "result",
          subtype: wasAborted ? "interrupted" : "success",
          result: resultText,
          harness_duration_ms: durationMs,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          num_turns: session.numTurns,
          total_cost_usd: session.costUsd,
        });

        session.status = "idle";
        ctx.updateSessionDb({
          status: "idle",
          messageCount: session.numTurns * 2,
          costUsd: session.costUsd,
          lastResponse: resultText.slice(0, 200),
        });
      }

      // Flush queued messages (only if not aborted/errored)
      if (!wasAborted && !wasError && session.pendingMessages.length > 0) {
        const next = session.pendingMessages.shift()!;
        session.status = "running";
        session.turnStartedAt = Date.now();
        ctx.emitEvent({
          type: "user",
          subtype: "prompt",
          message: { role: "user", content: next },
        });
        const state = getState(session);
        if (state) {
          state.agentSession.sendUserMessage(contentToPi(next), {
            deliverAs: "followUp",
          });
        }
      }
      break;
    }

    case "turn_start": {
      session.lastEventAt = Date.now();
      break;
    }

    case "auto_compaction_start": {
      console.log(`[pi-agent] ${session.sessionId}: ${event.type}`);
      ctx.emitEvent({
        type: "system",
        subtype: "compacting",
        provider: "pi-agent",
        reason: (event as any).reason,
      });
      break;
    }

    case "auto_compaction_end": {
      const e = event as any;
      console.log(`[pi-agent] ${session.sessionId}: ${event.type} result=${e.result}`);
      if (e.result === "error" || e.errorMessage) {
        ctx.emitEvent({
          type: "system",
          subtype: "compact_error",
          provider: "pi-agent",
          error: e.errorMessage ?? "compaction failed",
        });
      } else {
        ctx.emitEvent({
          type: "system",
          subtype: "compact_complete",
          provider: "pi-agent",
          trigger: e.reason ?? "auto",
          will_retry: !!e.willRetry,
        });
      }
      break;
    }

    case "auto_retry_start":
    case "auto_retry_end": {
      console.log(`[pi-agent] ${session.sessionId}: ${event.type}`);
      break;
    }
  }
}

// ── Provider Factory ──

export function createPiAgentProvider(providerName: PiProviderName): SessionProvider {
  return {
    capabilities: buildPiCapabilities(providerName),
    async startTurn(ctx: TurnContext) {
      const { session, opts, profile } = ctx;
      const modelId = session.model || DEFAULT_MODELS[providerName] || "default";
      const cwd = session.cwd ?? process.cwd();

      // Rekey from temp ses- to a real UUID (PI has no external backend to provide one)
      const realId = crypto.randomUUID();
      ctx.rekeySession(realId);

      // Provider owns init events — emit user prompt + system init
      ctx.emitEvent({
        type: "user",
        subtype: "prompt",
        message: { role: "user", content: session.initialContent },
      });
      ctx.emitEvent({
        type: "system",
        subtype: "init",
        session_id: realId,
        model: session.model,
        provider: providerName,
        config: {
          provider: opts.provider ?? "",
          model: opts.model ?? "",
          effort: opts.effort ?? "",
          maxTurns: opts.maxTurns,
          toolStates: opts.toolStates ?? {},
          providerControls: opts.providerControls ?? {},
        },
        cwd: session.cwd,
        loadProjectSettings: opts.loadProjectSettings ?? profile?.loadProjectSettings ?? true,
        tools: [],
      });
      session.status = "running";

      try {
        const orInfo = providerName === "openrouter"
          ? await fetchOpenRouterModelInfo(modelId)
          : null;
        const model = buildModel(providerName, modelId, profile, orInfo?.cost, orInfo?.contextLength || undefined);
        const authStorage = buildAuthStorage(providerName);
        const sessionManager = SessionManager.inMemory(cwd);
        const providerDefaults = getGlobalConfig(session.cwd).providerDefaults?.[providerName];
        // reserveTokens = tokens held back for the model's response before compaction triggers.
        // Default: match model.maxTokens (output budget), minimum 4096.
        // This prevents early compaction on large-context models (was 16384 flat, which caused
        // compaction at 50% fill on 32k-window models).
        const defaultReserveTokens = Math.max(4096, model.maxTokens ?? 4096);
        const compaction = {
          enabled: profile?.compaction?.enabled ?? providerDefaults?.compaction?.enabled ?? true,
          reserveTokens: profile?.compaction?.reserveTokens ?? providerDefaults?.compaction?.reserveTokens ?? defaultReserveTokens,
          keepRecentTokens: profile?.compaction?.keepRecentTokens ?? providerDefaults?.compaction?.keepRecentTokens ?? 20000,
        };
        const settingsManager = SettingsManager.inMemory({ compaction });

        // Resource loader with our profile prompt
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          settingsManager,
          systemPrompt: profile?.prompt,
          noExtensions: true,
          noSkills: false,
          noPromptTemplates: true,
          noThemes: true,
        });
        await resourceLoader.reload();

        // MCP tools: merge global + project-local + profile
        const globalConfig = getGlobalConfig(session.cwd);
        const mergedMcp = {
          ...(globalConfig.mcpServers ?? {}),
          ...(profile?.mcpServers ?? {}),
        };
        console.log(`[pi-agent] MCP servers to connect: ${Object.keys(mergedMcp).join(", ") || "(none)"}`);

        let mcpConnections: McpConnection[] = [];
        let mcpTools: import("@mariozechner/pi-coding-agent").ToolDefinition[] = [];
        if (Object.keys(mergedMcp).length > 0) {
          const mcp = await startMcpServers(mergedMcp);
          mcpConnections = mcp.connections;
          mcpTools = mcp.tools;
          console.log(`[pi-agent] MCP tools registered: ${mcpTools.map(t => t.name).join(", ") || "(none)"}`);
        }

        // Built-in coding tools
        const tools = createCodingTools(cwd);
        console.log(`[pi-agent] Built-in tools: ${tools.map((t: any) => t.name).join(", ")}`);

        const { session: agentSession } = await createAgentSession({
          cwd,
          model,
          authStorage,
          sessionManager,
          settingsManager,
          resourceLoader,
          tools,
          customTools: mcpTools.length > 0 ? mcpTools : undefined,
        });

        // Configure compaction based on provider type
        if (providerName === "anthropic" || providerName === "openai") {
          // Cloud providers: enable auto-compaction, disable auto-retry
          agentSession.setAutoRetryEnabled(false);
        } else {
          // Local models (litellm/ollama): enable threshold compaction, no retry
          // Overflow compaction uses the same (slow) local model to generate summaries
          // which can hang — but threshold compaction fires proactively at 75% usage
          // so overflow should rarely happen if contextWindow matches the server's -c flag
          agentSession.setAutoRetryEnabled(false);
        }

        // Apply tool allowlist from profile
        if (profile?.tools && profile.tools.length > 0) {
          agentSession.setActiveToolsByName(profile.tools);
        }

        // Log final active tools the LLM sees
        console.log(`[pi-agent] Active tools for LLM: ${agentSession.getActiveToolNames().join(", ")}`);

        // Subscribe to events and translate
        // Accumulate streamed text/thinking so we can emit assembled assistant
        // events — the permanent record that survives stream_event pruning.
        let accText = "";
        let accThinking = "";
        const flushAssembled = () => {
          if (!accText && !accThinking) return;
          const content: any[] = [];
          if (accThinking) content.push({ type: "thinking", thinking: accThinking });
          if (accText) content.push({ type: "text", text: accText });
          ctx.emitEvent({
            type: "assistant",
            message: { role: "assistant", content },
          });
          accText = "";
          accThinking = "";
        };

        const unsubscribe = agentSession.subscribe((event: AgentSessionEvent) => {
          try {
            // ── Pause gate ──
            // PI doesn't expose a blocking hook in its tool loop, so we abort
            // the agent at the tool boundary. On resume, the turn is lost — the
            // user sends the next message to continue.
            if (event.type === "tool_execution_start" && session.pauseRequested) {
              session.pauseRequested = false;
              session.status = "paused";
              updateSessionStatus(session.sessionId, "paused");
              flushAssembled();
              ctx.emitEvent({
                type: "system",
                subtype: "paused",
                data: { toolName: event.toolName, input: event.args ?? {} },
              });
              // Abort the agent — turn is interrupted at this tool boundary
              agentSession.abort().catch(() => {});
              return;
            }

            // Flush accumulated text before tool calls and turn end
            if (event.type === "tool_execution_start") {
              flushAssembled();
            }
            if (event.type === "agent_end" && !session.abortController.signal.aborted) {
              flushAssembled();
            }

            translateEvents(event, ctx, providerName);

            // Accumulate after translateEvents so stream_events emit first
            if (event.type === "message_update") {
              const ame = (event as any).assistantMessageEvent;
              if (ame?.type === "text_delta" && ame.delta) accText += ame.delta;
              if (ame?.type === "thinking_delta" && ame.delta) accThinking += ame.delta;
            }
          } catch (err) {
            console.error(`[pi-agent] event translation error:`, err);
          }
        });

        // Store state on session
        session._providerState = {
          agentSession,
          unsubscribe,
          mcpConnections,
        } satisfies PiAgentState;

        // Send the initial prompt
        session.status = "running";
        session.turnStartedAt = Date.now();
        const { text: promptText, images: promptImages } = contentToPiPrompt(session.initialContent);
        await agentSession.prompt(promptText, promptImages ? { images: promptImages } : undefined);
      } catch (err: any) {
        const message = friendlyError(err, providerName);
        console.error(`[pi-agent] ${session.sessionId}: ${message}`);
        ctx.emitEvent({ type: "result", subtype: "error", error: message });
        session.status = "error";
        session.error = message;
        ctx.updateSessionDb({ status: "error" });
      }
    },

    sendMessage(ctx: TurnContext, content: MessageContent) {
      const { session } = ctx;
      const state = getState(session);

      if (!state) {
        // Session not yet initialized — queue
        session.pendingMessages.push(content);
        return;
      }

      if (session.status === "running" || session.status === "starting") {
        // Streaming — queue as follow-up
        session.pendingMessages.push(content);
        return;
      }

      // Idle — send directly
      session.abortController = new AbortController();
      session.status = "running";
      session.turnStartedAt = Date.now();

      ctx.emitEvent({
        type: "user",
        subtype: "prompt",
        message: { role: "user", content },
      });

      state.agentSession.sendUserMessage(contentToPi(content)).catch((err: any) => {
        const message = friendlyError(err, providerName);
        console.error(`[pi-agent] ${session.sessionId}: ${message}`);
        ctx.emitEvent({ type: "result", subtype: "error", error: message });
        session.status = "error";
        session.error = message;
        ctx.updateSessionDb({ status: "error" });
      });
    },

    abort(session: ActiveSession) {
      const state = getState(session);
      if (state) {
        state.agentSession.abort().catch(() => {});
      }
      session.abortController.abort();
    },

    updateConfig(session: ActiveSession, config: Record<string, any>) {
      const state = getState(session);
      if (!state) return;

      let activeTools = state.agentSession.getActiveToolNames();
      const profileTools = getProfile(session.profile ?? "", session.cwd)?.tools;
      if (Array.isArray(config.tools)) {
        activeTools = config.tools.length > 0
          ? config.tools
          : (Array.isArray(profileTools) && profileTools.length > 0 ? profileTools : activeTools);
      } else if (Array.isArray(config.disallowedTools) && config.disallowedTools.length > 0) {
        activeTools = activeTools.filter((tool) => !config.disallowedTools.includes(tool));
      } else if (Array.isArray(config.disallowedTools)) {
        activeTools = Array.isArray(profileTools) && profileTools.length > 0 ? profileTools : activeTools;
      }
      state.agentSession.setActiveToolsByName(activeTools);
    },

    async dispose(session: ActiveSession) {
      await disposePiAgent(session);
    },

    switchProfile(session: ActiveSession, ctx: TurnContext, _contextMode: string) {
      const state = getState(session);
      if (!state) return;

      const profileDef = ctx.profile;

      // Model swap via setModel
      const newModelId = ctx.opts.model || DEFAULT_MODELS[providerName] || "default";
      const cachedInfo = providerName === "openrouter" && openRouterModelCache
        ? openRouterModelCache.get(newModelId)
        : undefined;
      const newModel = buildModel(providerName, newModelId, profileDef, cachedInfo?.cost, cachedInfo?.contextLength || undefined);
      state.agentSession.setModel(newModel);

      // System prompt via agent reach-through
      if (profileDef?.prompt) {
        (state.agentSession as any).agent?.setSystemPrompt?.(profileDef.prompt);
      }

      // Tools swap
      const rawTools = ctx.opts.tools ?? profileDef?.tools ?? undefined;
      if (Array.isArray(rawTools) && rawTools.length > 0) {
        state.agentSession.setActiveToolsByName(rawTools);
      }
    },
  };
}

/**
 * Clean up PI agent state when session is fully done.
 * Called by session-manager on archive/cleanup.
 */
export async function disposePiAgent(session: ActiveSession): Promise<void> {
  const state = getState(session);
  if (!state) return;
  state.unsubscribe();
  state.agentSession.dispose();
  await stopMcpServers(state.mcpConnections);
  session._providerState = null;
}
