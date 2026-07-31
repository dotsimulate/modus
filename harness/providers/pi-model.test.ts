import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildPiModel, ZERO_COST } from "./pi-model";

const ENV_NAMES = [
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_API_KEY",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of ENV_NAMES) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

describe("PI built-in model parity", () => {
  const cases: Array<{
    provider: string;
    baseUrl: string;
    supportsUsageInStreaming: boolean;
  }> = [
    {
      provider: "litellm",
      baseUrl: "http://localhost:4000/v1",
      supportsUsageInStreaming: true,
    },
    {
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
      supportsUsageInStreaming: false,
    },
    {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      supportsUsageInStreaming: true,
    },
  ];

  for (const { provider, baseUrl, supportsUsageInStreaming } of cases) {
    test(`${provider} keeps its exact pre-declarative Model shape`, () => {
      expect(buildPiModel(provider, "parity-model")).toEqual({
        id: "parity-model",
        name: "parity-model",
        api: "openai-completions",
        provider,
        baseUrl,
        reasoning: false,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 128000,
        maxTokens: 8192,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming,
          maxTokensField: "max_tokens",
        },
      });
    });
  }
});
