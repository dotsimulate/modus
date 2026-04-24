import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { providerFallbackModel } from "../provider-defaults";

type CodexCacheEntry = {
  slug?: string;
  visibility?: string;
  priority?: number;
};

export type CodexModelInfo = {
  id: string;
  owned_by?: string;
};

export function readCodexModelsCache(): CodexModelInfo[] {
  try {
    const cachePath = join(homedir(), ".codex", "models_cache.json");
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!Array.isArray(raw.models)) return [];
    return (raw.models as CodexCacheEntry[])
      .filter((model) => model.visibility !== "hide" && typeof model.slug === "string" && model.slug.length > 0)
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((model) => ({ id: model.slug!, owned_by: "openai" }));
  } catch {
    return [{ id: providerFallbackModel("codex"), owned_by: "openai" }];
  }
}

export function getCodexSeedModel(): string {
  return readCodexModelsCache()[0]?.id ?? providerFallbackModel("codex");
}
