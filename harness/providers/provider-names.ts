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

// ── Mid-turn message delivery (steering) ──

/**
 * Providers that can deliver a user message *into a turn already running*,
 * rather than holding it until the turn ends. Each needs a live input channel
 * the harness can write to after the turn has started:
 *
 * - `claude-code` — the Agent SDK's streaming-input iterator.
 * - `claude-code-pty` — the CLI is spawned with `--input-format stream-json`
 *   and stdin stays open, which is the same channel by another route.
 * - PI providers — `AgentSession.sendUserMessage(content, { deliverAs: "steer" })`.
 *
 * Everything else runs one prompt per turn with no injection point, so a
 * message sent mid-turn there can only be queued. Keeping the list here (rather
 * than inferring it from whether a provider happens to define `steerMessage`)
 * is what lets `/api/providers` tell a client which of the two will happen
 * *before* it sends.
 */
export const STEERABLE_PROVIDERS: string[] = [
  "claude-code",
  "claude-code-pty",
  ...PI_PROVIDERS,
];

export function supportsSteering(name: string): boolean {
  return STEERABLE_PROVIDERS.includes(name);
}

// ── One-shot completion ──

/**
 * Providers that can answer a single prompt without spawning an agent session.
 *
 * Only the PI family qualifies, and for a structural reason rather than a
 * missing feature: PI is an in-process SDK, so `pi-ai`'s `completeSimple()`
 * reaches the model directly with no tool loop, no session state, and no
 * subprocess. Every other provider is a CLI the harness spawns and converses
 * with — there is no way to ask one for a single completion without paying for
 * a process launch and a full agent turn.
 *
 * Consequence a caller must handle: a one-shot against `claude-code`, `codex`,
 * `cursor`, `antigravity`, `grok-build`, `opencode` or `gemini-cli` fails
 * loudly. Falling back to a session would silently turn a sub-second call into
 * a multi-second spawn, which is exactly the cost a one-shot exists to avoid.
 */
export const ONE_SHOT_PROVIDERS: string[] = [...PI_PROVIDERS];

export function supportsOneShotCompletion(name: string): boolean {
  return ONE_SHOT_PROVIDERS.includes(name);
}
