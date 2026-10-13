/**
 * Modus-owned Claude Code settings, delivered as the CLI's flag-settings tier.
 *
 * Modus launches Claude Code with only the `project` and `local` setting
 * sources, so the user's `~/.claude/settings.json` (hooks, plugins,
 * permissions) never reaches a Modus session. Settings Modus must guarantee
 * are passed explicitly instead: the SDK `settings` option, or `--settings`
 * for the PTY provider.
 *
 * The compaction window is the one user-tier value carried over: a window set
 * with Claude Code's `/autocompact` applies in Modus without extra config.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { GlobalConfig, Profile } from "../profiles";
import { getGlobalConfig } from "../profiles";
import { logProviderDiagnostic } from "./provider-diagnostics";

/** Bounds of Claude Code's `autoCompactWindow`; it silently drops values outside them. */
export const CLAUDE_AUTO_COMPACT_MIN = 100_000;
export const CLAUDE_AUTO_COMPACT_MAX = 1_000_000;

export type ClaudeFlagSettings = {
  autoCompactWindow?: number;
  modelSettings?: Record<string, { autoCompactWindow: number }>;
};

/** Claude Code settings files that can carry `autoCompactWindow`, lowest precedence first. */
export type ClaudeSettingsFiles = { user?: unknown; project?: unknown; local?: unknown };

/**
 * The compaction settings for a Claude Code launch. A Modus `contextWindow`
 * (profile, then providerDefaults) wins; otherwise the window configured in
 * Claude Code's own settings files is carried into the flag tier.
 */
export function resolveClaudeFlagSettings(
  profile: Pick<Profile, "contextWindow" | "env"> | undefined,
  projectRoot: string | undefined,
  cwd: string | undefined,
  providerName: string,
  loadProjectSettings: boolean,
): ClaudeFlagSettings | undefined {
  const configured = pickClaudeAutoCompactWindow(profile, getGlobalConfig(projectRoot).providerDefaults, providerName);
  if (configured) return { autoCompactWindow: configured };
  const configDir = profile?.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return mergeClaudeCompactSettings({
    user: readSettingsFile(join(configDir, "settings.json")),
    project: loadProjectSettings && cwd ? readSettingsFile(join(cwd, ".claude", "settings.json")) : undefined,
    local: loadProjectSettings && cwd ? readSettingsFile(join(cwd, ".claude", "settings.local.json")) : undefined,
  });
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

/**
 * Merge `autoCompactWindow` across Claude Code's settings files the way the
 * CLI does: per-model entries accumulate, and a top-level value in a higher
 * source replaces both the default and every lower source's per-model entries.
 * The result is complete, so in the flag tier it reproduces the merged state.
 */
export function mergeClaudeCompactSettings(files: ClaudeSettingsFiles): ClaudeFlagSettings | undefined {
  let merged: ClaudeFlagSettings = {};
  for (const file of [files.user, files.project, files.local]) {
    if (!file || typeof file !== "object") continue;
    const settings = file as Record<string, any>;
    const byModel: Record<string, { autoCompactWindow: number }> = {};
    if (settings.modelSettings && typeof settings.modelSettings === "object") {
      for (const [model, entry] of Object.entries(settings.modelSettings as Record<string, any>)) {
        const window = validWindow(entry?.autoCompactWindow);
        if (window) byModel[model] = { autoCompactWindow: window };
      }
    }
    const window = validWindow(settings.autoCompactWindow);
    merged = window
      ? { autoCompactWindow: window, modelSettings: byModel }
      : { ...merged, modelSettings: { ...merged.modelSettings, ...byModel } };
  }
  const modelSettings = merged.modelSettings && Object.keys(merged.modelSettings).length > 0
    ? merged.modelSettings
    : undefined;
  if (!merged.autoCompactWindow && !modelSettings) return undefined;
  return {
    ...(merged.autoCompactWindow ? { autoCompactWindow: merged.autoCompactWindow } : {}),
    ...(modelSettings ? { modelSettings } : {}),
  };
}

/** The compaction window that applies to `model` under these flag settings. */
export function compactWindowForModel(settings: ClaudeFlagSettings | undefined, model: string | undefined): number | undefined {
  if (!settings) return undefined;
  if (model && settings.modelSettings) {
    const key = canonicalModelKey(model);
    for (const [name, entry] of Object.entries(settings.modelSettings)) {
      if (canonicalModelKey(name) === key) return entry.autoCompactWindow;
    }
  }
  return settings.autoCompactWindow;
}

/**
 * Report the compaction window as the session's context window, so the
 * context readout measures against the point where Claude Code compacts
 * rather than the model's full window.
 */
export function applyContextWindowCap(result: Record<string, any>, settings: ClaudeFlagSettings | undefined): void {
  const [model, usage] = result.modelUsage && typeof result.modelUsage === "object"
    ? (Object.entries(result.modelUsage as Record<string, any>)[0] ?? [])
    : [];
  const cap = compactWindowForModel(settings, model);
  if (!cap) return;
  const reported = (usage as any)?.contextWindow;
  result.context_window = reported ? Math.min(reported, cap) : cap;
}

function canonicalModelKey(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

function validWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    && value >= CLAUDE_AUTO_COMPACT_MIN && value <= CLAUDE_AUTO_COMPACT_MAX
    ? value
    : undefined;
}

function readSettingsFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}
