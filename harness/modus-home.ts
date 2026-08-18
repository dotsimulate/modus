/**
 * ~/.modus/ path resolution — single source of truth for user-home state.
 *
 * All user-owned runtime state lives in ~/.modus/:
 *   profiles/agents/          — user's agent profiles
 *   profiles/users/           — user's user profiles
 *   profiles/ui/agents/       — agent UI sidecars
 *   profiles/ui/users/        — user UI sidecars
 *   profiles/state/           — runtime UI state per profile
 *   profiles/_global.json     — shared MCP servers merged into every session
 *   profiles/_users.json      — template var defaults
 *   profiles/prompt-cache.json — provider prompt cache
 *   plugins.json              — user-registered Modus plugin roots
 *   projects.json             — registry of known projects on this machine
 *   [<instance>/]history/     — Vault-scoped workspace-history shadow repos
 *   [<instance>/]checkpoints/ — Vault-scoped managed checkpoints
 *
 * Shipped templates live in harness/templates/profiles/ (repo-tracked, read-only
 * at runtime). rehydrateHome() seeds missing ~/.modus/ files from both the
 * now-legacy harness/profiles/ tree and harness/templates/profiles/ on first
 * boot; user data is never overwritten.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { APP_PATHS } from "./app-paths";

export const MODUS_HOME = APP_PATHS.modusHome;

// ── ~/.modus/profiles ──

export function homeProfilesDir(): string {
  return join(MODUS_HOME, "profiles");
}

export function homeAgentsDir(): string {
  return join(homeProfilesDir(), "agents");
}

export function homeUsersDir(): string {
  return join(homeProfilesDir(), "users");
}

export function homeUiDir(): string {
  return join(homeProfilesDir(), "ui");
}

export function homeUiAgentsDir(): string {
  return join(homeUiDir(), "agents");
}

export function homeUiUsersDir(): string {
  return join(homeUiDir(), "users");
}

export function homeStateDir(): string {
  return join(homeProfilesDir(), "state");
}

export function homeGlobalPath(): string {
  return join(homeProfilesDir(), "_global.json");
}

export function homeUsersJsonPath(): string {
  return join(homeProfilesDir(), "_users.json");
}

export function homePromptCachePath(): string {
  return join(homeProfilesDir(), "prompt-cache.json");
}

// ── ~/.modus/ (above profiles) ──

export function homeProjectsJsonPath(): string {
  return join(MODUS_HOME, "projects.json");
}

export function homePluginsJsonPath(): string {
  return join(MODUS_HOME, "plugins.json");
}

export function homeHistoryDir(): string {
  return join(APP_PATHS.writableRoot, "history");
}

/** User-global skills, addressable from every project. Authored, not runtime state. */
export function homeSkillsDir(): string {
  return join(MODUS_HOME, "skills");
}

export function homeCheckpointsDir(): string {
  return join(APP_PATHS.writableRoot, "checkpoints");
}

// ── Shipped templates (repo-tracked, read-only at runtime) ──
// import.meta.dir is harness/ — templates ship at harness/templates/profiles/.

export const TEMPLATES_PROFILES_DIR = join(APP_PATHS.resourcesDir, "templates", "profiles");

export function templatesAgentsDir(): string {
  return join(TEMPLATES_PROFILES_DIR, "agents");
}

export function templatesUsersDir(): string {
  return join(TEMPLATES_PROFILES_DIR, "users");
}

// ── Layout ──

/** Create every ~/.modus/ subdirectory. Idempotent. No data migration. */
export function ensureHomeLayout(): void {
  const dirs = [
    MODUS_HOME,
    homeProfilesDir(),
    homeAgentsDir(),
    homeUsersDir(),
    homeUiDir(),
    homeUiAgentsDir(),
    homeUiUsersDir(),
    homeStateDir(),
    homeHistoryDir(),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
