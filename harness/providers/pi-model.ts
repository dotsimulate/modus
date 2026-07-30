/**
 * PI model construction — the shared seam between the agentic PI provider and
 * one-shot model calls.
 *
 * `pi-agent.ts` builds a full `AgentSession` (tools, multi-turn state, MCP).
 * A one-shot completion (`model-oneshot.ts`) needs none of that, but it needs
 * the *same* model object: same baseUrl resolution from secrets, same
 * providerDefaults, same OpenAI-compat flags. Duplicating that resolution is
 * how a one-shot silently talks to a different endpoint than a session would.
 *
 * Lifted verbatim out of pi-agent.ts so both callers share one definition.
 * Deliberately does NOT import pi-coding-agent, the session manager, or the
 * provider registry — a one-shot must not pull the agent framework in.
 */

import type { Model } from "@mariozechner/pi-ai";
import { getGlobalConfig } from "../profiles";
import { resolveSecret } from "../secrets";

export type PiProviderName = "litellm" | "ollama" | "openrouter";

export const DEFAULT_PI_MODELS: Record<PiProviderName, string> = {
  litellm: "default",
  ollama: "default",
  openrouter: "anthropic/claude-sonnet-4.5",
};

export type CostRates = { input: number; output: number; cacheRead: number; cacheWrite: number };
export const ZERO_COST: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Env/secret name holding the base URL for each OpenAI-compat PI provider. */
const BASE_URL_ENV: Record<PiProviderName, string> = {
  litellm: "LITELLM_BASE_URL",
  ollama: "OLLAMA_BASE_URL",
  openrouter: "OPENROUTER_BASE_URL",
};

const DEFAULT_BASE_URL: Record<PiProviderName, string> = {
  litellm: "http://localhost:4000/v1",
  ollama: "http://localhost:11434/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/** Env/secret name holding the API key for each PI provider. */
const API_KEY_ENV: Record<PiProviderName, string> = {
  litellm: "LITELLM_API_KEY",
  ollama: "OLLAMA_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function resolvePiBaseUrl(provider: PiProviderName): string {
  const envVar = BASE_URL_ENV[provider];
  return resolveSecret(envVar) ?? process.env[envVar] ?? DEFAULT_BASE_URL[provider];
}

/**
 * Resolve the API key for a PI provider. Returns undefined when none is
 * configured, which is normal for a local Ollama or an unauthenticated LiteLLM —
 * callers substitute a placeholder rather than failing, matching what
 * `buildAuthStorage` does for the agentic path.
 */
export function resolvePiApiKey(provider: PiProviderName): string | undefined {
  const envVar = API_KEY_ENV[provider];
  return resolveSecret(envVar) ?? process.env[envVar] ?? undefined;
}

export function buildPiModel(
  provider: PiProviderName,
  modelId: string,
  profile?: any,
  cost?: CostRates,
  contextLengthFromApi?: number,
): Model<any> {
  // OpenAI-compat providers (litellm, ollama, openrouter)
  const baseUrl = resolvePiBaseUrl(provider);
  const providerDefaults = getGlobalConfig().providerDefaults?.[provider];

  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: provider,
    baseUrl,
    reasoning: false,
    input: ["text", "image"],
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
