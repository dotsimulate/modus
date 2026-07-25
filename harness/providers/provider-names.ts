/**
 * Provider name lists — the leaf of the provider tree.
 *
 * Deliberately import-free at runtime. `registry.ts` pulls in every provider
 * implementation, the secrets store, and transitively the database, so anything
 * that only needs to know *which provider names exist* — profile validation
 * above all — must import from here instead. `registry.ts` re-exports the
 * predicates so existing callers are unaffected.
 *
 * Adding a provider still means editing `registry.ts` to wire the
 * implementation; add its name here too.
 */

import type { PiProviderName } from "./pi-agent";

export const PI_PROVIDERS: PiProviderName[] = ["litellm", "ollama", "openrouter"];

export const STANDALONE_PROVIDERS = [
  "claude-code",
  "claude-code-pty",
  "codex",
  "cursor",
  "antigravity",
  "grok-build",
  "opencode",
] as const;

/** Reachable by name but hidden from the picker; see registry.getProvider. */
export const HIDDEN_LEGACY_PROVIDERS = ["gemini-cli"] as const;

export function isKnownProvider(name: string): boolean {
  return STANDALONE_PROVIDERS.includes(name as (typeof STANDALONE_PROVIDERS)[number])
    || HIDDEN_LEGACY_PROVIDERS.includes(name as (typeof HIDDEN_LEGACY_PROVIDERS)[number])
    || PI_PROVIDERS.includes(name as PiProviderName);
}

export function listProviders(): string[] {
  return [...STANDALONE_PROVIDERS, ...PI_PROVIDERS];
}
