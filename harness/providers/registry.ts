/**
 * Provider Registry — maps provider names to SessionProvider implementations.
 *
 * Adding a new provider: import it, register it. That's it.
 */

import type { ProviderCapabilities, SessionProvider } from "./types";
import { createClaudeCodeProvider } from "./claude-code";
import { createCodexProvider } from "./codex";
import { createGeminiCliProvider } from "./gemini-cli";
import { createPiAgentProvider, type PiProviderName } from "./pi-agent";

const PI_PROVIDERS: PiProviderName[] = ["anthropic", "openai", "litellm", "ollama", "openrouter"];
const STANDALONE_PROVIDERS = ["claude-code", "codex", "gemini-cli"] as const;

// Lazy-init cache
const cache = new Map<string, SessionProvider>();

export function getProvider(name: string): SessionProvider {
  let provider = cache.get(name);
  if (provider) return provider;

  if (name === "claude-code") {
    provider = createClaudeCodeProvider();
  } else if (name === "codex") {
    provider = createCodexProvider();
  } else if (name === "gemini-cli") {
    provider = createGeminiCliProvider();
  } else if (PI_PROVIDERS.includes(name as PiProviderName)) {
    provider = createPiAgentProvider(name as PiProviderName);
  } else {
    throw new Error(`Unknown provider: "${name}". Available: ${[...STANDALONE_PROVIDERS, ...PI_PROVIDERS].join(", ")}`);
  }

  cache.set(name, provider);
  return provider;
}

export function isKnownProvider(name: string): boolean {
  return STANDALONE_PROVIDERS.includes(name as (typeof STANDALONE_PROVIDERS)[number]) || PI_PROVIDERS.includes(name as PiProviderName);
}

export function listProviders(): string[] {
  return [...STANDALONE_PROVIDERS, ...PI_PROVIDERS];
}

export function getProviderCapabilities(name: string): ProviderCapabilities {
  return getProvider(name).capabilities;
}

export function listProviderCapabilities(): ProviderCapabilities[] {
  return listProviders().map((name) => getProviderCapabilities(name));
}
