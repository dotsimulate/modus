/**
 * Executable name each CLI-backed provider launches.
 *
 * Deliberately import-free. Two unrelated subsystems need this mapping — the
 * provider health check resolves it against PATH, and the session reaper needs
 * to tell the provider's own processes apart from whatever the agent launched
 * inside them — and neither should have to pull in the other's dependencies to
 * get it.
 *
 * Names are basenames, without a platform suffix. Callers compare them against
 * process image names, where Windows adds `.exe`.
 */

export const PROVIDER_CLI_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  "claude-code-pty": "claude",
  "codex": "codex",
  "cursor": "cursor-agent",
  "antigravity": "agy",
  "grok-build": "grok",
  "opencode": "opencode",
};

/** The CLI a provider launches, or undefined for in-process providers. */
export function providerCliName(provider: string): string | undefined {
  return PROVIDER_CLI_NAMES[provider];
}
