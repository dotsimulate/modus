import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { providerFallbackModel } from "../provider-defaults";

type CodexCacheEntry = {
  slug?: string;
  visibility?: string;
  priority?: number;
  context_window?: number;
  max_context_window?: number;
  max_output_tokens?: number;
  additional_speed_tiers?: string[];
  service_tiers?: Array<{ id?: string; name?: string; description?: string }>;
};

export type CodexModelInfo = {
  id: string;
  owned_by?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  contextSource?: "api" | "provider-default" | "fallback";
  speedTiers?: string[];
  serviceTiers?: Array<{ id: string; name?: string; description?: string }>;
};

export function readCodexModelsCache(): CodexModelInfo[] {
  try {
    const cachePath = join(homedir(), ".codex", "models_cache.json");
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!Array.isArray(raw.models)) return [];
    return (raw.models as CodexCacheEntry[])
      .filter((model) => model.visibility !== "hide" && typeof model.slug === "string" && model.slug.length > 0)
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((model) => ({
        id: model.slug!,
        owned_by: "openai",
        ...(model.context_window ? { contextWindow: model.context_window, contextSource: "api" as const } : {}),
        ...(model.max_output_tokens ? { maxOutputTokens: model.max_output_tokens } : {}),
        ...(model.additional_speed_tiers?.length ? { speedTiers: model.additional_speed_tiers } : {}),
        ...(model.service_tiers?.length
          ? { serviceTiers: model.service_tiers
            .filter((tier): tier is { id: string; name?: string; description?: string } => typeof tier.id === "string")
            .map((tier) => ({ id: tier.id, name: tier.name, description: tier.description })) }
          : {}),
      }));
  } catch {
    return [{ id: providerFallbackModel("codex"), owned_by: "openai" }];
  }
}

export function getCodexSeedModel(): string {
  return readCodexModelsCache()[0]?.id ?? providerFallbackModel("codex");
}
