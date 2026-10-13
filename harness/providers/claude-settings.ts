/**
 * Modus-owned Claude Code settings, delivered as the CLI's flag-settings tier.
 *
 * Modus launches Claude Code with only the `project` and `local` setting
 * sources, so values in the user's `~/.claude/settings.json` never reach a
 * Modus session. Settings Modus must guarantee are passed explicitly instead:
 * the SDK `settings` option, or `--settings` for the PTY provider.
 */

import type { GlobalConfig, Profile } from "../profiles";
import { getGlobalConfig } from "../profiles";
import { logProviderDiagnostic } from "./provider-diagnostics";

/** Bounds of Claude Code's `autoCompactWindow`; it silently drops values outside them. */
export const CLAUDE_AUTO_COMPACT_MIN = 100_000;
export const CLAUDE_AUTO_COMPACT_MAX = 1_000_000;

export type ClaudeFlagSettings = { autoCompactWindow?: number };

/**
 * The context window Claude Code should compact against: the profile's
 * `contextWindow`, else `providerDefaults[<provider>|claude-code].contextWindow`
 * from the project-resolved global config.
 */
export function resolveClaudeAutoCompactWindow(
  profile: Pick<Profile, "contextWindow"> | undefined,
  cwd: string | undefined,
  providerName: string,
): number | undefined {
  return pickClaudeAutoCompactWindow(profile, getGlobalConfig(cwd).providerDefaults, providerName);
}

/** Clamped to the CLI's accepted range so a configured cap is never dropped. */
export function pickClaudeAutoCompactWindow(
  profile: Pick<Profile, "contextWindow"> | undefined,
  providerDefaults: GlobalConfig["providerDefaults"],
  providerName: string,
): number | undefined {
  const configured = profile?.contextWindow
    ?? providerDefaults?.[providerName]?.contextWindow
    ?? providerDefaults?.["claude-code"]?.contextWindow;
  if (!configured) return undefined;
  const clamped = Math.min(CLAUDE_AUTO_COMPACT_MAX, Math.max(CLAUDE_AUTO_COMPACT_MIN, Math.floor(configured)));
  if (clamped !== configured) {
    logProviderDiagnostic(
      `[${providerName}] contextWindow ${configured} is outside Claude Code's ${CLAUDE_AUTO_COMPACT_MIN}-${CLAUDE_AUTO_COMPACT_MAX} range; using ${clamped}`,
    );
  }
  return clamped;
}

export function claudeFlagSettings(autoCompactWindow: number | undefined): ClaudeFlagSettings | undefined {
  return autoCompactWindow ? { autoCompactWindow } : undefined;
}

/**
 * Report the configured compaction window as the session's context window, so
 * the context readout measures against the cap Claude Code compacts at rather
 * than the model's full window.
 */
export function applyContextWindowCap(result: Record<string, any>, autoCompactWindow: number | undefined): void {
  if (!autoCompactWindow) return;
  const reported = result.modelUsage && typeof result.modelUsage === "object"
    ? (Object.values(result.modelUsage as Record<string, any>)[0] as any)?.contextWindow
    : undefined;
  result.context_window = reported ? Math.min(reported, autoCompactWindow) : autoCompactWindow;
}
