/**
 * Provider Models — fetch available models from each provider's API.
 */

import { resolveSecret } from "../secrets";

type ModelInfo = { id: string; owned_by?: string };

const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6", owned_by: "anthropic" },
  { id: "claude-sonnet-4-6", owned_by: "anthropic" },
  { id: "claude-haiku-4-5", owned_by: "anthropic" },
];

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
