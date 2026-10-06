/**
 * Provider Models — fetch available models from each provider's API.
 */

import { readCodexModelsCache } from "./codex-model-cache";
import { resolveSecret } from "../secrets";
import { fetchCursorModels } from "./cursor-runtime";
import { getGlobalConfig } from "../profiles";
import { probeGrokBuildModels } from "./grok-build-runtime";
import { getProviderDefinition } from "./provider-definitions";
import { removedProviderMigrationError } from "./provider-definition";
import { resolvePiApiKey, resolvePiBaseUrl } from "./pi-model";

export type ProviderModelInfo = {
  id: string;
  owned_by?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  contextSource?: "api" | "provider-default" | "fallback";
};

type ModelInfo = ProviderModelInfo;

const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-fable-5-1", owned_by: "anthropic", contextWindow: 1_000_000, maxOutputTokens: 128_000, contextSource: "provider-default" },
  { id: "claude-fable-5", owned_by: "anthropic", contextWindow: 1_000_000, maxOutputTokens: 128_000, contextSource: "provider-default" },
  { id: "claude-opus-5-5", owned_by: "anthropic", contextWindow: 1_000_000, maxOutputTokens: 128_000, contextSource: "provider-default" },
  { id: "claude-opus-5", owned_by: "anthropic", contextWindow: 1_000_000, maxOutputTokens: 128_000, contextSource: "provider-default" },
  { id: "claude-sonnet-5", owned_by: "anthropic", contextWindow: 1_000_000, maxOutputTokens: 128_000, contextSource: "provider-default" },
  { id: "default", owned_by: "anthropic", contextSource: "provider-default" },
  { id: "best", owned_by: "anthropic", contextSource: "provider-default" },
  { id: "opus", owned_by: "anthropic", contextSource: "provider-default" },
  { id: "sonnet", owned_by: "anthropic", contextSource: "provider-default" },
  { id: "haiku", owned_by: "anthropic", contextSource: "provider-default" },
  { id: "opus[1m]", owned_by: "anthropic", contextWindow: 1_000_000, contextSource: "provider-default" },
  { id: "sonnet[1m]", owned_by: "anthropic", contextWindow: 1_000_000, contextSource: "provider-default" },
  { id: "opusplan", owned_by: "anthropic", contextSource: "provider-default" },
  { id: "claude-opus-4-8[1m]", owned_by: "anthropic", contextWindow: 1_000_000, maxOutputTokens: 128_000, contextSource: "provider-default" },
  { id: "claude-opus-4-8", owned_by: "anthropic", contextWindow: 1_000_000, maxOutputTokens: 128_000, contextSource: "provider-default" },
  { id: "claude-opus-4-7[1m]", owned_by: "anthropic", contextWindow: 1_000_000, contextSource: "provider-default" },
  { id: "claude-opus-4-7", owned_by: "anthropic" },
  { id: "claude-opus-4-6[1m]", owned_by: "anthropic" },
  { id: "claude-opus-4-6", owned_by: "anthropic" },
  { id: "claude-sonnet-4-6[1m]", owned_by: "anthropic" },
  { id: "claude-sonnet-4-6", owned_by: "anthropic" },
  { id: "claude-haiku-4-5", owned_by: "anthropic" },
];

const GROK_BUILD_FALLBACK_MODELS: ModelInfo[] = [
  { id: "grok-4.5", owned_by: "xai", contextSource: "provider-default" },
];

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function contextWindowFromModel(raw: any): number | undefined {
  return positiveNumber(raw?.contextWindow)
    ?? positiveNumber(raw?.context_window)
    ?? positiveNumber(raw?.context_length)
    ?? positiveNumber(raw?.max_context_tokens)
    ?? positiveNumber(raw?.max_input_tokens)
    ?? positiveNumber(raw?.max_tokens);
}

function maxOutputTokensFromModel(raw: any): number | undefined {
  return positiveNumber(raw?.maxOutputTokens)
    ?? positiveNumber(raw?.max_output_tokens)
    ?? positiveNumber(raw?.max_completion_tokens)
    ?? positiveNumber(raw?.top_provider?.max_completion_tokens);
}

function withProviderDefaults(provider: string, model: ModelInfo): ModelInfo {
  const defaults = getGlobalConfig().providerDefaults?.[provider];
  const contextWindow = defaults?.contextWindow ?? model.contextWindow;
  const maxOutputTokens = defaults?.maxOutputTokens ?? model.maxOutputTokens;
  return {
    ...model,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    contextSource: defaults?.contextWindow
      ? "provider-default"
      : model.contextWindow
        ? "api"
        : model.contextSource,
  };
}

function getBaseURL(provider: string): {
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
} {
  const definition = getProviderDefinition(provider);
  if (definition?.kind === "pi") {
    return {
      url: resolvePiBaseUrl(provider),
      apiKey: resolvePiApiKey(provider),
      headers: definition.headers,
    };
  }
  if (provider === "openai") {
    return {
      url: "https://api.openai.com/v1",
      apiKey: resolveSecret("OPENAI_API_KEY") ?? process.env.OPENAI_API_KEY ?? "",
    };
  }
  throw new Error(`No model list for provider: ${provider}`);
}

export async function fetchProviderModels(provider: string): Promise<ModelInfo[]> {
  const migrationError = removedProviderMigrationError(provider);
  if (migrationError) throw migrationError;
  // Static list for claude-code
  if (provider === "claude-code" || provider === "claude-code-pty") {
    return CLAUDE_MODELS;
  }

  // Read from Codex CLI's local cache (~/.codex/models_cache.json)
  if (provider === "codex") {
    return readCodexModelsCache();
  }

  if (provider === "grok-build") {
    try {
      const models = await probeGrokBuildModels();
      return models.length ? models : GROK_BUILD_FALLBACK_MODELS;
    } catch {
      return GROK_BUILD_FALLBACK_MODELS;
    }
  }

  // Cursor: shell out to cursor-agent models and parse output
  if (provider === "cursor") {
    return fetchCursorModels();
  }

  const { url, apiKey, headers } = getBaseURL(provider);
  const modelsUrl = url.replace(/\/+$/, "") + "/models";

  const res = await fetch(modelsUrl, {
    headers: {
      ...(headers ?? {}),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${provider}: ${res.status} — ${body.slice(0, 200)}`);
  }

  const json: unknown = await res.json();
  const data = Array.isArray(json)
    ? json
    : (json && typeof json === "object" && "data" in json && Array.isArray(json.data))
      ? json.data
      : [];
  return data
    .map((m: any) => {
      const id = m.id ?? m.name;
      if (!id) return null;
      const contextWindow = contextWindowFromModel(m);
      const maxOutputTokens = maxOutputTokensFromModel(m);
      return withProviderDefaults(provider, {
        id,
        owned_by: m.owned_by,
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      });
    })
    .filter((m): m is ModelInfo => !!m);
}
