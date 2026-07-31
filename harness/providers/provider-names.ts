/**
 * Provider name and cross-provider capability predicates.
 *
 * This remains free of provider implementations, profiles, secrets, and the
 * database. Profile validation imports it, so discovery may read user/plugin
 * definition files but must not acquire the provider registry's runtime side
 * effects.
 */

import {
  getProviderDefinition,
  listProviderDefinitions,
} from "./provider-definitions";
import {
  HIDDEN_LEGACY_PROVIDER_NAMES,
  STANDALONE_PROVIDER_NAMES,
} from "./provider-definition";

export const STANDALONE_PROVIDERS = STANDALONE_PROVIDER_NAMES;

/** Reachable by name but hidden from the picker; see registry.getProvider. */
export const HIDDEN_LEGACY_PROVIDERS = HIDDEN_LEGACY_PROVIDER_NAMES;

export function listPiProviders(): string[] {
  return listProviderDefinitions()
    .filter((definition) => definition.kind === "pi")
    .map((definition) => definition.name);
}

export function isKnownProvider(name: string): boolean {
  return STANDALONE_PROVIDERS.includes(name as (typeof STANDALONE_PROVIDERS)[number])
    || HIDDEN_LEGACY_PROVIDERS.includes(name as (typeof HIDDEN_LEGACY_PROVIDERS)[number])
    || !!getProviderDefinition(name);
}

export function listProviders(): string[] {
  return [...STANDALONE_PROVIDERS, ...listPiProviders()];
}

// â”€â”€ Skill support â”€â”€
//
// Two different questions, and conflating them produces the wrong behavior:
// whether a provider finds skills on its own, and whether Modus can hand it
// specific ones.

/**
 * Providers whose runtime discovers skills on disk without Modus involvement â€”
 * Claude-family CLIs read `<cwd>/.claude/skills/`, PI reads `.pi/skills/`.
 * Every other provider CLI reads no skills at all, which is why anything that
 * must work everywhere goes through a move or the Modus skill tools.
 */
export function listNativeSkillProviders(): string[] {
  return ["claude-code", "claude-code-pty", ...listPiProviders()];
}

export function readsNativeSkills(name: string): boolean {
  return name === "claude-code"
    || name === "claude-code-pty"
    || getProviderDefinition(name)?.kind === "pi";
}

/**
 * Providers Modus can hand specific skill files to at spawn. Only PI exposes
 * such a parameter (`additionalSkillPaths`), and it accepts individual
 * `SKILL.md` paths â€” so attached skills load natively there and the Modus skill
 * tools are left unregistered rather than serving the same text twice.
 */
export function acceptsInjectedSkillPaths(name: string): boolean {
  return getProviderDefinition(name)?.kind === "pi";
}

// â”€â”€ Mid-turn message delivery (steering) â”€â”€

/**
 * Providers that can deliver a user message *into a turn already running*,
 * rather than holding it until the turn ends. Each needs a live input channel
 * the harness can write to after the turn has started:
 *
 * - `claude-code` â€” the Agent SDK's streaming-input iterator.
 * - `claude-code-pty` â€” the CLI is spawned with `--input-format stream-json`
 *   and stdin stays open, which is the same channel by another route.
 * - PI providers â€” `AgentSession.sendUserMessage(content, { deliverAs: "steer" })`.
 *
 * Everything else runs one prompt per turn with no injection point, so a
 * message sent mid-turn there can only be queued.
 */
export function listSteerableProviders(): string[] {
  return ["claude-code", "claude-code-pty", ...listPiProviders()];
}

export function supportsSteering(name: string): boolean {
  return name === "claude-code"
    || name === "claude-code-pty"
    || getProviderDefinition(name)?.kind === "pi";
}

// â”€â”€ One-shot completion â”€â”€

/**
 * Providers allowed to answer a single prompt without creating a Modus
 * session. PI is the cheap path because it calls an in-process SDK directly.
 * CLI providers can sometimes be invoked for one headless turn, but that still
 * pays subprocess startup and a full provider turn; keeping them out is a cost
 * and latency policy, not a claim that one-turn CLI invocation is impossible.
 */
export function listOneShotProviders(): string[] {
  return listPiProviders();
}

export function supportsOneShotCompletion(name: string): boolean {
  return getProviderDefinition(name)?.kind === "pi";
}
