/**
 * Profile loader — reads JSON files from harness/profiles/ subfolders.
 *
 * Directory structure:
 *   profiles/agents/   — agent profile definitions (config, edit deliberately)
 *   profiles/users/    — user profile definitions (config, edit deliberately)
 *   profiles/state/    — runtime UI state (app-managed, gitignored)
 *   profiles/_global.json — shared MCP servers merged into every session
 *   profiles/_users.json  — template var defaults
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync, copyFileSync } from "fs";
import { join, basename, dirname } from "path";

const PROFILES_DIR = join(import.meta.dir, "profiles");
const AGENTS_DIR = join(PROFILES_DIR, "agents");
const USERS_DIR = join(PROFILES_DIR, "users");
const STATE_DIR = join(PROFILES_DIR, "state");

for (const dir of [PROFILES_DIR, AGENTS_DIR, USERS_DIR, STATE_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

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

/**
 * Named exclusion rules that expand to glob patterns at session start.
 * - "no-parent-walk"  — exclude all CLAUDE.md files above the session CWD
 * - "no-node-modules" — exclude CLAUDE.md inside any node_modules tree
 */
export type ClaudeMdRule = "no-parent-walk" | "no-node-modules";

/**
 * Controls which CLAUDE.md files the SDK excludes from loading.
 * Accepts either a raw glob array (passed straight to SDK) or an object
 * with named rules + custom globs for a mix of standard and specific exclusions.
 */
export type ClaudeMdExcludes =
  | string[]
  | {
      rules?: ClaudeMdRule[];
      custom?: string[];
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
  /** CLAUDE.md exclusions — raw globs or named rules + custom patterns */
  claudeMdExcludes?: ClaudeMdExcludes;
  /** System prompt mode — "custom" replaces everything, "append" adds to claude_code preset */
  promptMode?: "custom" | "append";
  /** MCP server configurations for this profile */
  mcpServers?: Record<string, McpServerConfig>;
  /** Permission policy — controls tool execution gating. Defaults to "bypass". */
  permissionPolicy?: PermissionPolicy;
  /** UI presentation hints — read by frontend, optional with sensible defaults */
  ui?: {
    label?: string;
    showThinking?: boolean;
    showMeta?: boolean;
    showToolCalls?: boolean;
    placeholder?: string;
    emptyTitle?: string;
    emptySubtitle?: string;
    showGitEvents?: boolean;
  };
};

export type GlobalConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

// ── User Profiles ──
// Scoped views of the harness — each profile filters projects, agent profiles, memory.
// Config lives in profiles/users/. Runtime state lives in profiles/state/.

export type UserProfileState = {
  sidebarGroupMode?: "time" | "project";
  sidebarCollapsedGroups?: string[];
  sidebarConfigExpanded?: boolean;
  lastAgentProfile?: string;
  lastCwd?: string;
};

export type UserProfileMemory = {
  scope: "global" | "profile";
  inheritGlobal?: boolean;
};

export type UserProfile = {
  displayName: string;
  templateVars?: Record<string, string>;
  projects: string[];
  agentProfiles?: string[];
  /** Visible schedules — omit or ["*"] for all */
  schedules?: string[];
  memoryFilter?: string;
  memory?: UserProfileMemory;
  /** Show project paths from ALL user profiles in the CWD picker (default: false) */
  showAllProjectPaths?: boolean;
};

// ── Helpers ──

function readJson<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    console.error(`[profiles] Failed to parse ${filePath}:`, err);
    return undefined;
  }
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/** Save a timestamped copy of a file before overwriting it.
 *  Creates .history/<name>/<timestamp>.json alongside the source directory. */
function snapshot(filePath: string): void {
  if (!existsSync(filePath)) return;
  const dir = dirname(filePath);
  const name = basename(filePath, ".json");
  const histDir = join(dir, ".history", name);
  if (!existsSync(histDir)) mkdirSync(histDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(filePath, join(histDir, `${ts}.json`));
}

// ── Agent Profile CRUD ──

function readProfileFile(name: string): Profile | undefined {
  return readJson<Profile>(join(AGENTS_DIR, `${name}.json`));
}

/** Resolve an agent profile name to its definition */
export function getProfile(name: string): Profile | undefined {
  return readProfileFile(name);
}

/** List all agent profile names */
export function listProfileNames(): string[] {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"))
    .sort();
}

/** Get all agent profiles as a Record */
export function getAllProfiles(): Record<string, Profile> {
  const result: Record<string, Profile> = {};
  for (const name of listProfileNames()) {
    const p = readProfileFile(name);
    if (p) result[name] = p;
  }
  return result;
}

/** Save an agent profile (create or update) */
export function saveProfile(name: string, profile: Profile): void {
  if (name.startsWith("_")) throw new Error("Profile names cannot start with _");
  const filePath = join(AGENTS_DIR, `${name}.json`);
  snapshot(filePath);
  writeJson(filePath, profile);
}

/** Delete an agent profile */
export function deleteProfile(name: string): boolean {
  const filePath = join(AGENTS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

// ── Global Config ──

/** Read the global config (_global.json) */
export function getGlobalConfig(): GlobalConfig {
  return readJson<GlobalConfig>(join(PROFILES_DIR, "_global.json")) ?? {};
}

/** Save the global config */
export function saveGlobalConfig(config: GlobalConfig): void {
  const filePath = join(PROFILES_DIR, "_global.json");
  snapshot(filePath);
  writeJson(filePath, config);
}

// ── User Profile CRUD ──

function readUserProfileFile(name: string): UserProfile | undefined {
  return readJson<UserProfile>(join(USERS_DIR, `${name}.json`));
}

export function getUserProfile(name: string): UserProfile | undefined {
  return readUserProfileFile(name);
}

export function listUserProfileNames(): string[] {
  if (!existsSync(USERS_DIR)) return [];
  return readdirSync(USERS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"))
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
  const filePath = join(USERS_DIR, `${name}.json`);
  snapshot(filePath);
  writeJson(filePath, profile);
}

export function deleteUserProfile(name: string): boolean {
  const filePath = join(USERS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

/** Partial update — merges provided fields into existing user profile config */
export function patchUserProfile(name: string, patch: Partial<UserProfile>): UserProfile | undefined {
  const existing = readUserProfileFile(name);
  if (!existing) return undefined;
  const merged = { ...existing, ...patch };
  saveUserProfile(name, merged);
  return merged;
}

// ── User Profile State CRUD ──
// Runtime UI state — lives in profiles/state/, gitignored, app-managed.

export function getUserProfileState(name: string): UserProfileState {
  return readJson<UserProfileState>(join(STATE_DIR, `${name}.json`)) ?? {};
}

export function saveUserProfileState(name: string, state: UserProfileState): void {
  writeJson(join(STATE_DIR, `${name}.json`), state);
}

export function patchUserProfileState(name: string, patch: Partial<UserProfileState>): UserProfileState {
  const existing = getUserProfileState(name);
  const merged = { ...existing, ...patch };
  saveUserProfileState(name, merged);
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
