/**
 * Profile loader — reads individual JSON files from harness/profiles/.
 *
 * Each profile is a separate .json file (filename = profile name).
 * _global.json holds MCP servers that merge into every session.
 * Agents and the UI can read/write these files via the CRUD API.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join, basename } from "path";

const PROFILES_DIR = join(import.meta.dir, "profiles");

if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true });

// ── Types ──

export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/**
 * Permission policy controls how tool executions are gated.
 * - "bypass"  — bypassPermissions, no checks at all (default for backward compat)
 * - "ask"     — every tool call requires user approval via UI
 * - object    — mixed: per-tool auto-approve or require-approval rules
 */
export type PermissionPolicy =
  | "bypass"
  | "ask"
  | {
      default: "approve" | "ask";
      autoApprove?: string[];
      requireApproval?: string[];
    };

export type Profile = {
  /** Agent system prompt */
  prompt: string;
  /** Agent description (for subagent selection / UI display) */
  description: string;
  /** Allowed tools — omit to inherit all */
  tools?: string[];
  /** Disallowed tools */
  disallowedTools?: string[];
  /** Model override */
  model?: string;
  /** Max turns override */
  maxTurns?: number;
  /** Effort level */
  effort?: "low" | "medium" | "high" | "max";
  /** Whether to load CLAUDE.md and project settings */
  loadProjectSettings?: boolean;
  /** System prompt mode — "custom" replaces everything, "append" adds to claude_code preset */
  promptMode?: "custom" | "append";
  /** MCP server configurations for this profile */
  mcpServers?: Record<string, McpServerConfig>;
  /** Permission policy — controls tool execution gating. Defaults to "bypass". */
  permissionPolicy?: PermissionPolicy;
};

export type GlobalConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

// ── User Profiles ──
// Scoped views of the harness — each profile filters projects, agent profiles, memory.

export type UserProfileUi = {
  sidebarGroupMode?: "time" | "project";
  sidebarCollapsedGroups?: string[];
  sidebarConfigExpanded?: boolean;
  lastAgentProfile?: string;
  lastCwd?: string;
};

export type UserProfile = {
  displayName: string;
  templateVars?: Record<string, string>;
  projects: string[];
  agentProfiles?: string[];
  memoryFilter?: string;
  ui?: UserProfileUi;
};

// ── Read ──

function readProfileFile(name: string): Profile | undefined {
  const filePath = join(PROFILES_DIR, `${name}.json`);
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Profile;
  } catch (err) {
    console.error(`[profiles] Failed to parse ${name}.json:`, err);
    return undefined;
  }
}

/** Resolve a profile name to its definition */
export function getProfile(name: string): Profile | undefined {
  return readProfileFile(name);
}

/** Read the global config (_global.json) */
export function getGlobalConfig(): GlobalConfig {
  const filePath = join(PROFILES_DIR, "_global.json");
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as GlobalConfig;
  } catch {
    return {};
  }
}

/** List all profile names (excludes _global) */
export function listProfileNames(): string[] {
  return readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => basename(f, ".json"))
    .sort();
}

/** Get all profiles as a Record */
export function getAllProfiles(): Record<string, Profile> {
  const result: Record<string, Profile> = {};
  for (const name of listProfileNames()) {
    const p = readProfileFile(name);
    if (p) result[name] = p;
  }
  return result;
}

// ── Write ──

/** Save a profile (create or update) */
export function saveProfile(name: string, profile: Profile): void {
  if (name.startsWith("_")) throw new Error("Profile names cannot start with _");
  writeFileSync(join(PROFILES_DIR, `${name}.json`), JSON.stringify(profile, null, 2) + "\n", "utf-8");
}

/** Delete a profile */
export function deleteProfile(name: string): boolean {
  const filePath = join(PROFILES_DIR, `${name}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

/** Save the global config */
export function saveGlobalConfig(config: GlobalConfig): void {
  writeFileSync(join(PROFILES_DIR, "_global.json"), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ── User Profile CRUD ──

const USER_PROFILE_PREFIX = "_user_";

function readUserProfileFile(name: string): UserProfile | undefined {
  const filePath = join(PROFILES_DIR, `${USER_PROFILE_PREFIX}${name}.json`);
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as UserProfile;
  } catch (err) {
    console.error(`[profiles] Failed to parse user profile ${name}:`, err);
    return undefined;
  }
}

export function getUserProfile(name: string): UserProfile | undefined {
  return readUserProfileFile(name);
}

export function listUserProfileNames(): string[] {
  return readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".json") && f.startsWith(USER_PROFILE_PREFIX))
    .map((f) => basename(f, ".json").slice(USER_PROFILE_PREFIX.length))
    .sort();
}

export function getAllUserProfiles(): Record<string, UserProfile> {
  const result: Record<string, UserProfile> = {};
  for (const name of listUserProfileNames()) {
    const p = readUserProfileFile(name);
    if (p) result[name] = p;
  }
  return result;
}

export function saveUserProfile(name: string, profile: UserProfile): void {
  writeFileSync(
    join(PROFILES_DIR, `${USER_PROFILE_PREFIX}${name}.json`),
    JSON.stringify(profile, null, 2) + "\n",
    "utf-8",
  );
}

export function deleteUserProfile(name: string): boolean {
  const filePath = join(PROFILES_DIR, `${USER_PROFILE_PREFIX}${name}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

/** Partial update — merges provided fields into existing profile */
export function patchUserProfile(name: string, patch: Partial<UserProfile>): UserProfile | undefined {
  const existing = readUserProfileFile(name);
  if (!existing) return undefined;
  const merged = { ...existing, ...patch };
  // Deep merge the ui object if both exist
  if (patch.ui && existing.ui) {
    merged.ui = { ...existing.ui, ...patch.ui };
  }
  saveUserProfile(name, merged);
  return merged;
}

/** Get merged template vars: _users.json defaults + user profile overrides */
export function getTemplateVars(userProfileName?: string): Record<string, string | null> {
  const base = getUserData();
  if (!userProfileName) return base;
  const profile = readUserProfileFile(userProfileName);
  if (!profile?.templateVars) return base;
  return { ...base, ...profile.templateVars };
}

// ── User Data ──
// Stored in _users.json. Flat key-value object for user info + template vars.
// Keys are available as {{key}} in profile prompts.

const USERS_FILE = join(PROFILES_DIR, "_users.json");

type UserData = Record<string, string | null>;

/** Read full user data object */
export function getUserData(): UserData {
  if (!existsSync(USERS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(USERS_FILE, "utf-8")) as UserData;
  } catch { return {}; }
}

/** Write full user data object */
function saveUserData(data: UserData): void {
  writeFileSync(USERS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function setUserName(name: string): void {
  const data = getUserData();
  data.name = name;
  saveUserData(data);
}

export function getUserName(): string | null {
  return getUserData().name ?? null;
}

// ── Backward compat ──
// index.ts uses `profiles[body.profile]` for validation.
// This Proxy makes that work without changing existing code.

export const profiles = new Proxy({} as Record<string, Profile>, {
  get(_target, prop: string) {
    return readProfileFile(prop);
  },
  ownKeys() {
    return listProfileNames();
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    const val = readProfileFile(prop as string);
    if (val) return { configurable: true, enumerable: true, value: val };
    return undefined;
  },
});
