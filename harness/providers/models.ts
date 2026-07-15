/**
 * Provider Models — fetch available models from each provider's API.
 */

import { readCodexModelsCache } from "./codex-model-cache";
import { resolveSecret } from "../secrets";
import { cursorAgentSpawnArgv0 } from "./cursor-resolve-bin";
import { getGlobalConfig } from "../profiles";
import {
  antigravityAuthFromModelsResult,
  parseAntigravityModels,
  resolveAntigravityExecutable,
  runAntigravityCommand,
} from "./antigravity-cli-runtime";

export type ProviderModelInfo = {
  id: string;
  owned_by?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  contextSource?: "api" | "provider-default" | "fallback";
};

type ModelInfo = ProviderModelInfo;

const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-fable-5", owned_by: "anthropic", contextWindow: 1_000_000, maxOutputTokens: 128_000, contextSource: "provider-default" },
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

const GEMINI_MODELS: ModelInfo[] = [
  { id: "auto-gemini-3", owned_by: "google" },
  { id: "gemini-2.5-pro", owned_by: "google" },
  { id: "gemini-2.5-flash", owned_by: "google" },
  { id: "gemini-2.5-flash-preview", owned_by: "google" },
  { id: "gemini-3.1-flash", owned_by: "google" },
  { id: "gemini-3-pro-preview", owned_by: "google" },
  { id: "gemini-3-flash-preview", owned_by: "google" },
];

const ANTIGRAVITY_FALLBACK_MODELS: ModelInfo[] = [
  { id: "Gemini 3.5 Flash", owned_by: "google", contextSource: "provider-default" },
  { id: "Gemini 3.1 Pro", owned_by: "google", contextSource: "provider-default" },
];

async function fetchAntigravityModels(): Promise<ModelInfo[]> {
  const executable = resolveAntigravityExecutable();
  if (!executable) return ANTIGRAVITY_FALLBACK_MODELS;
  const result = await runAntigravityCommand(executable, ["models"], { timeoutMs: 15_000 });
  const auth = antigravityAuthFromModelsResult(result);
  if (!auth.authenticated) return ANTIGRAVITY_FALLBACK_MODELS;
  const models = parseAntigravityModels(result.stdout);
  return models.length > 0 ? models : ANTIGRAVITY_FALLBACK_MODELS;
}

/** Fetch models from cursor-agent CLI by parsing its `models` command output. */
async function fetchCursorModels(): Promise<ModelInfo[]> {
  try {
    const { execFileSync } = await import("child_process");
    const bin = cursorAgentSpawnArgv0();
    const raw = execFileSync(bin, ["models"], {
      timeout: 15000,
      encoding: "utf-8",
      windowsHide: true,
    });
    // Parse lines like: "composer-2-fast - Composer 2 Fast"
    const models: ModelInfo[] = [];
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\S+)\s+-\s+(.+)$/);
      if (match) {
        models.push({ id: match[1]!, owned_by: "cursor" });
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
  if (provider === "claude-code" || provider === "claude-code-pty") {
    return CLAUDE_MODELS;
  }

  // Read from Codex CLI's local cache (~/.codex/models_cache.json)
  if (provider === "codex") {
    return readCodexModelsCache();
  }

  if (provider === "gemini-cli") {
    return GEMINI_MODELS;
  }

  if (provider === "antigravity") {
    return fetchAntigravityModels();
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
