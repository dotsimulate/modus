/**
 * Data-only provider definitions.
 *
 * This module is intentionally a pure leaf: profile validation imports the
 * provider name registry, which imports these definitions. Pulling filesystem,
 * profile, secret, or database modules in here would make validation acquire
 * unrelated runtime side effects.
 */

import { z } from "zod";

export const KNOWN_PI_APIS = [
  "openai-completions",
  "mistral-conversations",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
] as const;

export const STANDALONE_PROVIDER_NAMES = [
  "claude-code",
  "claude-code-pty",
  "codex",
  "cursor",
  "grok-build",
  "opencode",
] as const;

/**
 * Reachable by name, kept out of the pickers.
 *
 * `gemini-cli` is here because its free OAuth tier is gone and Modus refuses to
 * reuse those credentials. `antigravity` is here for a different reason: Google's
 * terms forbid "using third party software, tools, or services to access the
 * Service", and enforcement has suspended paid accounts across Antigravity,
 * Gemini CLI, and Code Assist at once. Modus only spawns the user's own signed-in
 * `agy` binary and never touches its credentials, so the provider still works for
 * anyone who configures it deliberately — but the risk lands on their Google
 * account, so it is not offered as a peer of the others.
 */
export const HIDDEN_LEGACY_PROVIDER_NAMES = ["gemini-cli", "antigravity"] as const;

const CostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
}).strict();

const CompatSchema = z.object({
  supportsStore: z.boolean().optional(),
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoningEffort: z.boolean().optional(),
  supportsUsageInStreaming: z.boolean().optional(),
  maxTokensField: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
}).strict();

const HealthSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
}).strict();

/**
 * Live per-model cost and context-window metadata.
 *
 * `source` names the *response shape* to parse, not the vendor — any gateway
 * that serves an OpenRouter-compatible model list (`data[].pricing.prompt`,
 * `.completion`, `.input_cache_read`, `.input_cache_write` as per-token strings,
 * plus `context_length`) can use `"openrouter"`. Omit the whole block and the
 * definition's static `cost` and `contextWindow` are used as-is.
 */
const PricingSchema = z.object({
  source: z.literal("openrouter"),
  /** Defaults to `<resolved baseUrl>/models`. */
  url: z.string().url().optional(),
}).strict();

const ProviderDefinitionObjectSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must match /^[a-z0-9][a-z0-9-]*$/"),
  label: z.string().min(1).optional(),
  kind: z.literal("pi"),
  api: z.enum(KNOWN_PI_APIS),
  baseUrl: z.string().url(),
  apiKeyName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment-style secret name").optional(),
  /**
   * Whether an unset `apiKeyName` secret makes the provider misconfigured.
   * Defaults to true: naming a secret normally declares it as required. Set
   * false for an endpoint that accepts unauthenticated local requests but can
   * optionally take a key — a local LiteLLM, Ollama, vLLM, or llama.cpp.
   */
  apiKeyRequired: z.boolean().optional(),
  defaultModel: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  cost: CostSchema.optional(),
  compat: CompatSchema.optional(),
  health: HealthSchema.optional(),
  pricing: PricingSchema.optional(),
  apiKey: z.unknown().optional().superRefine((value, ctx) => {
    if (value !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "inline apiKey is not allowed; store credentials in Modus secrets and set apiKeyName",
      });
    }
  }),
}).strict();

export const ProviderDefinitionSchema = ProviderDefinitionObjectSchema.superRefine((definition, ctx) => {
  if (
    definition.compat !== undefined
    && definition.api !== "openai-completions"
    && definition.api !== "openai-responses"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["compat"],
      message: `compat is only valid for openai-completions or openai-responses, not ${definition.api}`,
    });
  }
});

type ParsedProviderDefinition = z.infer<typeof ProviderDefinitionSchema>;
export type ProviderDefinition = Omit<ParsedProviderDefinition, "apiKey">;

const OPENAI_COMPAT_NAME = "openai-compat";
const PROVIDER_ALIASES = {
  litellm: OPENAI_COMPAT_NAME,
} as const satisfies Record<string, string>;

export const BUILT_IN_PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    name: OPENAI_COMPAT_NAME,
    label: "OpenAI-compatible",
    kind: "pi",
    api: "openai-completions",
    baseUrl: "http://localhost:4000/v1",
    apiKeyName: "LITELLM_API_KEY",
    // A local LiteLLM commonly runs without auth; the key is optional here.
    apiKeyRequired: false,
    defaultModel: "default",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxOutputTokens: 8192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },
  },
  {
    name: "ollama",
    label: "Ollama",
    kind: "pi",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    apiKeyName: "OLLAMA_API_KEY",
    // Ollama is unauthenticated by default.
    apiKeyRequired: false,
    defaultModel: "default",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxOutputTokens: 8192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    },
  },
  {
    name: "openrouter",
    label: "OpenRouter",
    kind: "pi",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyName: "OPENROUTER_API_KEY",
    // Live per-model cost/context from the model list, rather than the static
    // zero rates below. Any OpenRouter-compatible gateway can declare this.
    pricing: { source: "openrouter" },
    defaultModel: "anthropic/claude-sonnet-4.5",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxOutputTokens: 8192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },
  },
];

export function resolveProviderAlias(name: string): string {
  return PROVIDER_ALIASES[name as keyof typeof PROVIDER_ALIASES] ?? name;
}

export function listProviderAliases(name: string): string[] {
  return Object.entries(PROVIDER_ALIASES)
    .filter(([, canonical]) => canonical === name)
    .map(([alias]) => alias);
}

/**
 * Base-URL overrides keep the historical LiteLLM name after the canonical
 * provider rename. All other providers derive a stable environment/secret
 * prefix from their definition name.
 */
export function providerBaseUrlName(name: string): string {
  const canonical = resolveProviderAlias(name);
  if (canonical === OPENAI_COMPAT_NAME) return "LITELLM_BASE_URL";
  return `${canonical.replace(/-/g, "_").toUpperCase()}_BASE_URL`;
}

export function isBuiltInProviderName(name: string): boolean {
  const canonical = resolveProviderAlias(name);
  return BUILT_IN_PROVIDER_DEFINITIONS.some((definition) => definition.name === canonical)
    || STANDALONE_PROVIDER_NAMES.includes(canonical as (typeof STANDALONE_PROVIDER_NAMES)[number])
    || HIDDEN_LEGACY_PROVIDER_NAMES.includes(canonical as (typeof HIDDEN_LEGACY_PROVIDER_NAMES)[number]);
}
