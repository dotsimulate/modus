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

const GEMINI_MODELS: ModelInfo[] = [
  { id: "auto-gemini-3", owned_by: "google" },
  { id: "gemini-2.5-pro", owned_by: "google" },
  { id: "gemini-2.5-flash", owned_by: "google" },
  { id: "gemini-2.5-flash-preview", owned_by: "google" },
  { id: "gemini-3.1-flash", owned_by: "google" },
  { id: "gemini-3-pro-preview", owned_by: "google" },
  { id: "gemini-3-flash-preview", owned_by: "google" },
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

/** Fetch models from cursor-agent CLI by parsing its `models` command output. */
async function fetchCursorModels(): Promise<ModelInfo[]> {
  try {
    const { execSync } = await import("child_process");
    const raw = execSync("cursor-agent models 2>/dev/null", { timeout: 15000, encoding: "utf-8" });
    // Parse lines like: "composer-2-fast - Composer 2 Fast"
    const models: ModelInfo[] = [];
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\S+)\s+-\s+(.+)$/);
      if (match) {
        models.push({ id: match[1], owned_by: "cursor" });
      }
    }
    return models.length > 0 ? models : CURSOR_FALLBACK_MODELS;
  } catch {
    return CURSOR_FALLBACK_MODELS;
  }
}

const CURSOR_FALLBACK_MODELS: ModelInfo[] = [
  { id: "composer-2-fast", owned_by: "cursor" },
  { id: "composer-2", owned_by: "cursor" },
  { id: "composer-1.5", owned_by: "cursor" },
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
  // Static list for claude-code
  if (provider === "claude-code") {
    return CLAUDE_MODELS;
  }

  // Read from Codex CLI's local cache (~/.codex/models_cache.json)
  if (provider === "codex") {
    return readCodexModelsCache();
  }

  if (provider === "gemini-cli") {
    return GEMINI_MODELS;
  }

  // Cursor: shell out to cursor-agent models and parse output
  if (provider === "cursor") {
    return fetchCursorModels();
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

  const json: unknown = await res.json();
  const data = Array.isArray(json)
    ? json
    : (json && typeof json === "object" && "data" in json && Array.isArray(json.data))
      ? json.data
      : [];
  return data.map((m: any) => ({ id: m.id ?? m.name, owned_by: m.owned_by }));
}
