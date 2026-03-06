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
import type { SessionProvider, TurnContext } from "./types";
import type { ActiveSession, MessageContent } from "../session-manager";
import { getGlobalConfig } from "../profiles";
import { startMcpServers, stopMcpServers, type McpConnection } from "./mcp-bridge";
import { resolveSecret } from "../secrets";

// ── Provider Names ──

export type PiProviderName = "anthropic" | "openai" | "litellm" | "ollama";

const DEFAULT_MODELS: Record<PiProviderName, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  litellm: "default",
  ollama: "default",
};

// ── Provider-specific state on session._providerState ──

type PiAgentState = {
  agentSession: AgentSession;
  unsubscribe: () => void;
  mcpConnections: McpConnection[];
};

function getState(session: ActiveSession): PiAgentState | null {
  return session._providerState as PiAgentState | null;
}

// ── Model Construction ──

function buildModel(provider: PiProviderName, modelId: string, profile?: any): Model<any> {
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
        contextWindow: profile?.contextWindow ?? 128000,
        maxTokens: profile?.maxOutputTokens ?? (provider === "anthropic" ? 8192 : 0),
        compat: provider === "openai" ? {} : undefined,
      } as Model<any>;
    }
  }

  // OpenAI-compat providers (litellm, ollama)
  const baseUrlEnv = provider === "litellm" ? "LITELLM_BASE_URL" : "OLLAMA_BASE_URL";
  const defaultUrl = provider === "litellm"
    ? "http://localhost:4000/v1"
    : "http://localhost:11434/v1";
  const baseUrl = resolveSecret(baseUrlEnv) ?? process.env[baseUrlEnv] ?? defaultUrl;

  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: profile?.contextWindow ?? 128000,
    maxTokens: profile?.maxOutputTokens ?? 0,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: provider === "litellm",
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

function contentToText(content: MessageContent): string {
  if (typeof content === "string") return content;
  const textBlock = (content as any[]).find((b: any) => b.type === "text");
  return textBlock?.text ?? "";
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
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: ame.delta },
          },
        });
      } else if (ame.type === "thinking_delta") {
        session.lastEventAt = Date.now();
        ctx.emitEvent({
          type: "stream_event",
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
      const resultText = typeof event.result === "string"
        ? event.result
        : JSON.stringify(event.result);
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
      const messages = (event as any).messages ?? [];
      const lastAssistant = [...messages].reverse().find(
        (m: any) => m.role === "assistant",
      );

      const resultText = lastAssistant
        ? (lastAssistant.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("")
        : session.lastAssistantText;

      // Don't emit assistant event — text already streamed via text_delta,
      // tool calls already emitted via tool_execution_start/end.

      // Extract usage from last assistant message
      const usage = lastAssistant?.usage;
      const inputTokens = usage?.input ?? 0;
      const outputTokens = usage?.output ?? 0;
      const costTotal = usage?.cost?.total ?? 0;

      const durationMs = Date.now() - session.turnStartedAt;
      session.numTurns++;
      session.costUsd += costTotal;

      ctx.emitEvent({
        type: "result",
        subtype: "success",
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

      // Flush queued messages
      if (session.pendingMessages.length > 0) {
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
          state.agentSession.sendUserMessage(contentToText(next), {
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

    case "auto_compaction_start":
    case "auto_compaction_end":
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
    async startTurn(ctx: TurnContext) {
      const { session, opts, profile } = ctx;
      const modelId = session.model || DEFAULT_MODELS[providerName] || "default";
      const cwd = session.cwd ?? process.cwd();

      try {
        const model = buildModel(providerName, modelId, profile);
        const authStorage = buildAuthStorage(providerName);
        const sessionManager = SessionManager.inMemory(cwd);
        const settingsManager = SettingsManager.inMemory();

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

        // MCP tools: merge global + profile (same as claude-code provider)
        const globalConfig = getGlobalConfig();
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

        // Disable auto-compaction and auto-retry — we manage lifecycle ourselves,
        // and these can cause runaway LLM call loops with local models
        agentSession.setAutoCompactionEnabled(false);
        agentSession.setAutoRetryEnabled(false);

        // Apply tool allowlist from profile
        if (profile?.tools && profile.tools.length > 0) {
          agentSession.setActiveToolsByName(profile.tools);
        }

        // Log final active tools the LLM sees
        console.log(`[pi-agent] Active tools for LLM: ${agentSession.getActiveToolNames().join(", ")}`);

        // Subscribe to events and translate
        const unsubscribe = agentSession.subscribe((event: AgentSessionEvent) => {
          try {
            translateEvents(event, ctx, providerName);
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
        await agentSession.prompt(contentToText(session.initialContent));
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

      state.agentSession.sendUserMessage(contentToText(content)).catch((err: any) => {
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
