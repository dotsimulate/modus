/**
 * Provider Models — fetch available models from each provider's API.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { resolveSecret } from "../secrets";

type ModelInfo = { id: string; owned_by?: string };

const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6", owned_by: "anthropic" },
  { id: "claude-sonnet-4-6", owned_by: "anthropic" },
  { id: "claude-haiku-4-5", owned_by: "anthropic" },
];

/** Read models from Codex CLI's local cache (~/.codex/models_cache.json). */
function readCodexModelsCache(): ModelInfo[] {
  try {
    const cachePath = join(homedir(), ".codex", "models_cache.json");
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!Array.isArray(raw.models)) return [];
    return raw.models
      .filter((m: any) => m.visibility !== "hide")
      .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m: any) => ({ id: m.slug, owned_by: "openai" }));
  } catch {
    return [{ id: "gpt-5.1-codex", owned_by: "openai" }];
  }
}

function getBaseURL(provider: string): { url: string; apiKey: string } {
  switch (provider) {
    case "litellm":
      return {
        url: resolveSecret("LITELLM_BASE_URL") ?? process.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1",
        apiKey: resolveSecret("LITELLM_API_KEY") ?? process.env.LITELLM_API_KEY ?? "unused",
      };
    case "ollama":
      return {
        url: resolveSecret("OLLAMA_BASE_URL") ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
        apiKey: resolveSecret("OLLAMA_API_KEY") ?? process.env.OLLAMA_API_KEY ?? "ollama",
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1",
        apiKey: resolveSecret("OPENAI_API_KEY") ?? process.env.OPENAI_API_KEY ?? "",
      };
    case "openrouter":
      return {
        url: resolveSecret("OPENROUTER_BASE_URL") ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        apiKey: resolveSecret("OPENROUTER_API_KEY") ?? process.env.OPENROUTER_API_KEY ?? "",
      };
    default:
      throw new Error(`No model list for provider: ${provider}`);
  }
}

export async function fetchProviderModels(provider: string): Promise<ModelInfo[]> {
  // Static list for claude-code / anthropic
  if (provider === "claude-code" || provider === "anthropic") {
    return CLAUDE_MODELS;
  }

  // Read from Codex CLI's local cache (~/.codex/models_cache.json)
  if (provider === "codex") {
    return readCodexModelsCache();
  }

  const { url, apiKey } = getBaseURL(provider);
  const modelsUrl = url.replace(/\/+$/, "") + "/models";

  const res = await fetch(modelsUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${provider}: ${res.status} — ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const data = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
  return data.map((m: any) => ({ id: m.id ?? m.name, owned_by: m.owned_by }));
}
