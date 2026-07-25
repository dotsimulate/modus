/**
 * Child-environment policy for subprocess providers.
 *
 * Every provider CLI is spawned with the backend's environment, and anything an
 * agent runs through that CLI — shell tools, MCP stdio servers, subagents — is a
 * descendant of it. Forwarding `HARNESS_TOKEN` therefore hands full Modus API
 * authority (sessions, file APIs, profile mutation) to every command an agent
 * runs, regardless of the provider's own permission model.
 *
 * Provider credentials, profile environment, and provider-specific variables are
 * layered on explicitly by each provider *after* this base, so removing an
 * inherited value here never removes a deliberately configured one.
 */

/** Modus credentials that must not be inherited by a provider child. */
const STRIPPED_CREDENTIALS = [
  "HARNESS_TOKEN",
  "HARNESS_PIN",
  "HARNESS_SECRETS_FILE",
  "HARNESS_TLS_KEY",
  "MODUS_PIN",
  "MODUS_TOKEN",
] as const;

/**
 * Opt out of credential stripping for a workflow that genuinely needs the
 * supervisor credential inside provider children (for example driving the Modus
 * SDK CLI from inside a session). Deliberately explicit and off by default.
 */
export const PROVIDER_ENV_PASSTHROUGH_VAR = "MODUS_PROVIDER_ENV_PASSTHROUGH";

function passthroughEnabled(base: NodeJS.ProcessEnv): boolean {
  const value = base[PROVIDER_ENV_PASSTHROUGH_VAR]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** Names removed from a provider child environment under the current policy. */
export function strippedProviderEnvNames(base: NodeJS.ProcessEnv = process.env): readonly string[] {
  if (passthroughEnabled(base)) return [];
  return STRIPPED_CREDENTIALS;
}

/**
 * Build the base environment for a provider child process.
 *
 * Returns a defined-values-only copy of `base` with Modus credentials removed.
 * OS, PATH, locale, proxy, and provider runtime variables are preserved.
 */
export function providerChildEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const stripped = new Set(strippedProviderEnvNames(base));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (stripped.has(key)) continue;
    env[key] = value;
  }
  return env;
}
