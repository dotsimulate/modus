/**
 * First-boot rehydration of the current Vault home from packaged resources.
 *
 * Runs once at boot. Main copies pre-existing user data from the now-legacy
 * harness/profiles/ tree, then every Vault seeds missing shipped templates from
 * harness/templates/profiles/. A named Vault never imports legacy authored data.
 * Existing Vault data is never overwritten.
 *
 * After the repo-side harness/profiles/ dirs are removed (Phase 3 of the
 * modus-home relocation), the legacy copy is a silent no-op; only the
 * template seed path runs on fresh installs.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { APP_PATHS } from "./app-paths";
import {
  ensureHomeLayout,
  homeAgentsDir, homeGlobalPath, homePromptCachePath,
  homeProjectsJsonPath, homeStateDir, homeUiAgentsDir,
  homeUiUsersDir, homeUsersDir, homeUsersJsonPath,
  templatesAgentsDir, templatesUsersDir,
} from "./modus-home";

// Legacy (pre-modus-home) paths inside the repo. These become unread after
// Phase 2 of the relocation; rehydrateHome() is the one-way bridge that
// copies their contents to Main's profiles directory before the repo dirs are
// removed in Phase 3.
const LEGACY_PROFILES_DIR = join(APP_PATHS.resourcesDir, "profiles");
const LEGACY_AGENTS_DIR = join(LEGACY_PROFILES_DIR, "agents");
const LEGACY_USERS_DIR = join(LEGACY_PROFILES_DIR, "users");
const LEGACY_UI_AGENTS_DIR = join(LEGACY_PROFILES_DIR, "ui", "agents");
const LEGACY_UI_USERS_DIR = join(LEGACY_PROFILES_DIR, "ui", "users");
const LEGACY_STATE_DIR = join(LEGACY_PROFILES_DIR, "state");
const LEGACY_GLOBAL = join(LEGACY_PROFILES_DIR, "_global.json");
const LEGACY_USERS_JSON = join(LEGACY_PROFILES_DIR, "_users.json");
const LEGACY_PROMPT_CACHE = join(LEGACY_PROFILES_DIR, "prompt-cache.json");
const LEGACY_PROJECTS_JSON = join(LEGACY_PROFILES_DIR, "_projects.json");

export type RehydrationReport = {
  copiedFromLegacy: string[];
  copiedFromTemplates: string[];
  skippedExisting: string[];
};

function copyFileIfMissing(src: string, dest: string, hits: string[], skips: string[]): void {
  if (!existsSync(src)) return;
  if (existsSync(dest)) {
    skips.push(dest);
    return;
  }
  const destDir = dirname(dest);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  hits.push(dest);
}

function copyJsonDir(srcDir: string, destDir: string, hits: string[], skips: string[]): void {
  if (!existsSync(srcDir)) return;
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith(".json")) continue;
    const src = join(srcDir, entry);
    if (!statSync(src).isFile()) continue;
    const dest = join(destDir, entry);
    if (existsSync(dest)) {
      skips.push(dest);
      continue;
    }
    copyFileSync(src, dest);
    hits.push(dest);
  }
}

export function rehydrateHome(): RehydrationReport {
  ensureHomeLayout();

  const legacyHits: string[] = [];
  const templateHits: string[] = [];
  const skips: string[] = [];

  // 1) Main-only one-way migration from the checkout's legacy authored data.
  // Named Vaults start independent and may receive only shipped templates.
  if (!APP_PATHS.instance) {
    copyJsonDir(LEGACY_AGENTS_DIR, homeAgentsDir(), legacyHits, skips);
    copyJsonDir(LEGACY_USERS_DIR, homeUsersDir(), legacyHits, skips);
    copyJsonDir(LEGACY_UI_AGENTS_DIR, homeUiAgentsDir(), legacyHits, skips);
    copyJsonDir(LEGACY_UI_USERS_DIR, homeUiUsersDir(), legacyHits, skips);
    copyJsonDir(LEGACY_STATE_DIR, homeStateDir(), legacyHits, skips);

    copyFileIfMissing(LEGACY_GLOBAL, homeGlobalPath(), legacyHits, skips);
    copyFileIfMissing(LEGACY_USERS_JSON, homeUsersJsonPath(), legacyHits, skips);
    copyFileIfMissing(LEGACY_PROMPT_CACHE, homePromptCachePath(), legacyHits, skips);
    // _projects.json → projects.json (registry, not config).
    copyFileIfMissing(LEGACY_PROJECTS_JSON, homeProjectsJsonPath(), legacyHits, skips);
  }

  // 2) Template seeds → fill anything still missing.
  copyJsonDir(templatesAgentsDir(), homeAgentsDir(), templateHits, skips);
  copyJsonDir(templatesUsersDir(), homeUsersDir(), templateHits, skips);

  return {
    copiedFromLegacy: legacyHits,
    copiedFromTemplates: templateHits,
    skippedExisting: skips,
  };
}
