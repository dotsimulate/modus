/**
 * Provider Registry — maps provider names to SessionProvider implementations.
 *
 * Adding a new provider: import it, register it. That's it.
 */

import type { SessionProvider } from "./types";
import { createClaudeCodeProvider } from "./claude-code";
import { createPiAgentProvider, type PiProviderName } from "./pi-agent";

const PI_PROVIDERS: PiProviderName[] = ["anthropic", "openai", "litellm", "ollama"];

// Lazy-init cache
const cache = new Map<string, SessionProvider>();

export function getProvider(name: string): SessionProvider {
  let provider = cache.get(name);
  if (provider) return provider;

  if (name === "claude-code") {
    provider = createClaudeCodeProvider();
  } else if (PI_PROVIDERS.includes(name as PiProviderName)) {
    provider = createPiAgentProvider(name as PiProviderName);
  } else {
    throw new Error(`Unknown provider: "${name}". Available: claude-code, ${PI_PROVIDERS.join(", ")}`);
  }

  cache.set(name, provider);
  return provider;
}

export function isKnownProvider(name: string): boolean {
  return name === "claude-code" || PI_PROVIDERS.includes(name as PiProviderName);
}

export function listProviders(): string[] {
  return ["claude-code", ...PI_PROVIDERS];
}
