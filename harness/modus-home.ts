/**
 * Current Vault home resolution — single source of truth for owned state.
 *
 * Main uses its configured Modus home. A named process uses its registered
 * folder root and never falls back to Main. Within that current home:
 *   profiles/agents/          — user's agent profiles
 *   profiles/users/           — user's user profiles
 *   profiles/ui/agents/       — agent UI sidecars
 *   profiles/ui/users/        — user UI sidecars
 *   profiles/state/           — runtime UI state per profile
 *   profiles/_global.json     — shared MCP servers merged into every session
 *   profiles/_users.json      — template var defaults
 *   profiles/prompt-cache.json — provider prompt cache
 *   plugins.json              — user-registered Modus plugin roots
 *   projects.json             — current Vault's external project references
 *   vaults.json               — Main-only registry of named folder pointers
 *   history/                  — workspace-history shadow repos
 *   checkpoints/              — managed checkpoints
 *
 * Shipped templates live in harness/templates/profiles/ (repo-tracked, read-only
 * at runtime). rehydrateHome() seeds shipped templates into every Vault. Only
 * Main migrates the now-legacy harness/profiles/ tree; named Vaults never do.
 * Existing data is never overwritten.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { APP_PATHS } from "./app-paths";

export const MODUS_HOME = APP_PATHS.modusHome;

// ── <current-home>/profiles ──

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

// ── <current-home>/ (above profiles) ──

export function homeProjectsJsonPath(): string {
  return join(MODUS_HOME, "projects.json");
}

export function homePluginsJsonPath(): string {
  return join(MODUS_HOME, "plugins.json");
}

export function homeVaultsJsonPath(modusHome = MODUS_HOME): string {
  return join(modusHome, "vaults.json");
}

export function homeHistoryDir(): string {
  return join(APP_PATHS.writableRoot, "history");
}

/** Vault-global skills, addressable from every registered project. Authored, not runtime state. */
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

/** Create every current-home subdirectory. Idempotent. No data migration. */
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
