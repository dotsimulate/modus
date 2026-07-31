/**
 * PI model construction â€” the shared seam between agent sessions, one-shot
 * calls, model listing, health checks, and friendly diagnostics.
 */

import type { Model } from "@mariozechner/pi-ai";
import { getGlobalConfig } from "../profiles";
import { resolveSecret } from "../secrets";
import {
  providerBaseUrlName,
  type ProviderDefinition,
} from "./provider-definition";
import { getProviderDefinition } from "./provider-definitions";

export type CostRates = { input: number; output: number; cacheRead: number; cacheWrite: number };
export const ZERO_COST: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function requirePiProviderDefinition(provider: string): ProviderDefinition {
  const definition = getProviderDefinition(provider);
  if (!definition || definition.kind !== "pi") {
    throw new Error(
      `Unknown PI provider "${provider}". Definitions load from the built-in registry, `
      + `<MODUS_HOME>/providers, and enabled plugins' .modus/providers directories.`,
    );
  }
  return definition;
}

export function defaultPiModel(provider: string): string {
  return requirePiProviderDefinition(provider).defaultModel ?? "default";
}

export function resolvePiBaseUrl(provider: string): string {
  const definition = requirePiProviderDefinition(provider);
  const overrideName = providerBaseUrlName(definition.name);
  return resolveSecret(overrideName)
    ?? process.env[overrideName]
    ?? definition.baseUrl;
}

/**
 * Resolve the API key named by a definition. Returns undefined when a local or
 * otherwise unauthenticated endpoint deliberately omits a value.
 */
export function resolvePiApiKey(provider: string): string | undefined {
  const definition = requirePiProviderDefinition(provider);
  if (!definition.apiKeyName) return undefined;
  return resolveSecret(definition.apiKeyName)
    ?? process.env[definition.apiKeyName]
    ?? undefined;
}

export function buildPiModel(
  provider: string,
  modelId: string,
  profile?: any,
  cost?: CostRates,
  contextLengthFromApi?: number,
): Model<any> {
  const definition = requirePiProviderDefinition(provider);
  const baseUrl = resolvePiBaseUrl(provider);
  const globalDefaults = getGlobalConfig().providerDefaults;
  const providerDefaults = globalDefaults?.[provider] ?? globalDefaults?.[definition.name];

  return {
    id: modelId,
    name: modelId,
    api: definition.api,
    provider,
    baseUrl,
    reasoning: definition.reasoning ?? false,
    input: definition.input ?? ["text", "image"],
    cost: cost ?? definition.cost ?? ZERO_COST,
    contextWindow:
      profile?.contextWindow
      ?? providerDefaults?.contextWindow
      ?? contextLengthFromApi
      ?? definition.contextWindow
      ?? 128000,
    maxTokens:
      profile?.maxOutputTokens
      ?? providerDefaults?.maxOutputTokens
      ?? definition.maxOutputTokens
      ?? 8192,
    ...(definition.headers ? { headers: definition.headers } : {}),
    ...(definition.compat ? { compat: definition.compat } : {}),
  } as Model<any>;
}
