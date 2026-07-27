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

// ── Skill support ──
//
// Two different questions, and conflating them produces the wrong behavior:
// whether a provider finds skills on its own, and whether Modus can hand it
// specific ones.

/**
 * Providers whose runtime discovers skills on disk without Modus involvement —
 * Claude-family CLIs read `<cwd>/.claude/skills/`, PI reads `.pi/skills/`.
 * Every other provider CLI reads no skills at all, which is why anything that
 * must work everywhere goes through a move or the Modus skill tools.
 */
export const NATIVE_SKILL_PROVIDERS: string[] = [
  "claude-code",
  "claude-code-pty",
  ...PI_PROVIDERS,
];

export function readsNativeSkills(name: string): boolean {
  return NATIVE_SKILL_PROVIDERS.includes(name);
}

/**
 * Providers Modus can hand specific skill files to at spawn. Only PI exposes
 * such a parameter (`additionalSkillPaths`), and it accepts individual
 * `SKILL.md` paths — so attached skills load natively there and the Modus skill
 * tools are left unregistered rather than serving the same text twice.
 */
export function acceptsInjectedSkillPaths(name: string): boolean {
  return (PI_PROVIDERS as string[]).includes(name);
}
