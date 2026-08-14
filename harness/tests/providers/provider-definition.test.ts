import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  HIDDEN_LEGACY_PROVIDER_NAMES,
  ProviderDefinitionSchema,
  STANDALONE_PROVIDER_NAMES,
  resolveProviderAlias,
} from "../../providers/provider-definition";
import {
  detectLocalProviders,
  modelIdsFromDetectionResponse,
} from "../../providers/provider-detection";
import { isKnownProvider, listProviders } from "../../providers/provider-names";

const validDefinition = {
  name: "lmstudio",
  label: "LM Studio (local)",
  kind: "pi" as const,
  api: "openai-completions" as const,
  baseUrl: "http://127.0.0.1:1234/v1",
  defaultModel: "default",
};

describe("provider definition schema", () => {
  test("accepts a complete data-only definition", () => {
    expect(ProviderDefinitionSchema.parse(validDefinition)).toEqual(validDefinition);
  });

  test("rejects unknown fields instead of silently ignoring typos", () => {
    const result = ProviderDefinitionSchema.safeParse({
      ...validDefinition,
      baseURL: validDefinition.baseUrl,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }
  });

  test("rejects compat for protocols whose Model type cannot accept it", () => {
    const result = ProviderDefinitionSchema.safeParse({
      ...validDefinition,
      api: "anthropic-messages",
      compat: { supportsStore: false },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(" ")).toContain(
        "compat is only valid",
      );
    }
  });

  test("rejects inline credentials and points to apiKeyName", () => {
    const result = ProviderDefinitionSchema.safeParse({
      ...validDefinition,
      apiKey: "not-allowed",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(" ")).toContain("apiKeyName");
    }
  });

  test("rejects names outside the stable kebab-case registry", () => {
    expect(ProviderDefinitionSchema.safeParse({
      ...validDefinition,
      name: "LM Studio",
    }).success).toBe(false);
  });

  test("all shipped templates validate against the strict schema", () => {
    const templatesDir = join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "..", "templates", "providers");
    for (const fileName of readdirSync(templatesDir).filter((name) => name.endsWith(".json"))) {
      const parsed = JSON.parse(readFileSync(join(templatesDir, fileName), "utf-8"));
      expect(ProviderDefinitionSchema.safeParse(parsed).success, fileName).toBe(true);
    }
  });

  test("discovery stays free of profiles, secrets, registry, and database imports", () => {
    const source = readFileSync(join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "provider-definitions.ts"), "utf-8");
    for (const forbidden of ["../profiles", "../secrets", "./registry", "../db"]) {
      expect(source).not.toContain(`from "${forbidden}"`);
    }
  });
});

describe("provider aliases", () => {
  test("keeps litellm as a permanent alias for openai-compat", () => {
    expect(resolveProviderAlias("litellm")).toBe("openai-compat");
    expect(resolveProviderAlias("openai-compat")).toBe("openai-compat");
    expect(resolveProviderAlias("ollama")).toBe("ollama");
  });
});

describe("hidden providers", () => {
  // Both hidden names carry a deliberate reason, and the failure mode of losing
  // one is silent: the provider simply reappears in every picker. Antigravity in
  // particular is hidden on a terms/enforcement judgement that no test elsewhere
  // encodes, so it is pinned by name rather than by count.
  test("antigravity and gemini-cli are reachable but never offered in a picker", () => {
    expect(HIDDEN_LEGACY_PROVIDER_NAMES).toContain("antigravity");
    expect(HIDDEN_LEGACY_PROVIDER_NAMES).toContain("gemini-cli");
    for (const name of HIDDEN_LEGACY_PROVIDER_NAMES) {
      expect(STANDALONE_PROVIDER_NAMES).not.toContain(name as never);
      expect(isKnownProvider(name)).toBe(true);
      expect(listProviders()).not.toContain(name);
    }
  });
});

describe("opt-in local detection", () => {
  test("requires the OpenAI /v1/models response shape, including on port 8080", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      seen.push(url);
      if (url === "http://127.0.0.1:1234/v1/models") {
        return Response.json({ data: [{ id: "local-model" }] });
      }
      if (url === "http://127.0.0.1:8080/v1/models") {
        // A speech or unrelated service answering is not provider identity.
        return Response.json({ segments: [{ text: "not a model list" }] });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const detected = await detectLocalProviders(fetcher);
    expect(detected.map((entry) => entry.definition.name)).toEqual(["lmstudio"]);
    expect(detected[0]?.modelIds).toEqual(["local-model"]);
    expect(seen).toContain("http://127.0.0.1:8080/v1/models");
  });

  test("rejects empty or partial model-list payloads", () => {
    expect(modelIdsFromDetectionResponse({ data: [] })).toBeNull();
    expect(modelIdsFromDetectionResponse({ data: [{ name: "missing-id" }] })).toBeNull();
    expect(modelIdsFromDetectionResponse([{ id: "wrong-envelope" }])).toBeNull();
  });
});

describe("pricing metadata", () => {
  test("parses an OpenRouter-compatible model list into per-million rates", async () => {
    const { parseOpenRouterPricing } = await import("../../providers/pi-agent");
    const parsed = parseOpenRouterPricing({
      data: [
        {
          id: "vendor/model-a",
          context_length: 200000,
          pricing: {
            prompt: "0.000003",
            completion: "0.000015",
            input_cache_read: "0.0000003",
            input_cache_write: "0.00000375",
          },
        },
        // No pricing block, and a junk entry that must not throw.
        { id: "vendor/model-b", context_length: 8192 },
        { context_length: 1 },
      ],
    });
    expect(parsed.get("vendor/model-a")).toEqual({
      contextLength: 200000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    expect(parsed.get("vendor/model-b")).toEqual({
      contextLength: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(parsed.size).toBe(2);
  });

  test("a definition may declare pricing under any provider name", () => {
    const parsed = ProviderDefinitionSchema.safeParse({
      name: "my-router",
      kind: "pi",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyName: "MY_ROUTER_API_KEY",
      pricing: { source: "openrouter" },
    });
    expect(parsed.success).toBe(true);
  });

  test("the built-in openrouter definition declares pricing rather than relying on its name", () => {
    const openrouter = BUILT_IN_PROVIDER_DEFINITIONS.find((d) => d.name === "openrouter");
    expect(openrouter?.pricing).toEqual({ source: "openrouter" });
  });

  test("an unknown pricing source is rejected", () => {
    const parsed = ProviderDefinitionSchema.safeParse({
      name: "bad-pricing",
      kind: "pi",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9999/v1",
      pricing: { source: "litellm" },
    });
    expect(parsed.success).toBe(false);
  });
});
