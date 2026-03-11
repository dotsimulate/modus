/**
 * Profile loader — reads JSON files from harness/profiles/ subfolders.
 *
 * Directory structure (base — ships with the harness):
 *   profiles/agents/   — agent profile definitions (config, edit deliberately)
 *   profiles/users/    — user profile definitions (config, edit deliberately)
 *   profiles/state/    — runtime UI state (app-managed, gitignored)
 *   profiles/_global.json — shared MCP servers merged into every session
 *   profiles/_users.json  — template var defaults
 *
 * Project-local overrides — any project directory can contain:
 *   .modus/profiles/agents/  — extra agent profiles (override base by name)
 *   .modus/actions/           — extra actions (loaded by action-runner)
 *   .modus/_global.json       — project-level MCP servers (merged additively)
 *
 * When a session CWD is provided, project-local profiles take precedence
 * over base profiles of the same name. Listing functions merge both sources.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync, copyFileSync } from "fs";
import { join, basename, dirname } from "path";

const PROFILES_DIR = join(import.meta.dir, "profiles");
const AGENTS_DIR = join(PROFILES_DIR, "agents");
const USERS_DIR = join(PROFILES_DIR, "users");
const STATE_DIR = join(PROFILES_DIR, "state");

for (const dir of [PROFILES_DIR, USERS_DIR, STATE_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Project-local .modus/ discovery ──

const MODUS_DIR = ".modus";

function projectAgentsDir(cwd: string): string {
  return join(cwd, MODUS_DIR, "profiles", "agents");
}

function projectGlobalPath(cwd: string): string {
  return join(cwd, MODUS_DIR, "_global.json");
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

export type CompactionConfig = {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
};

export type ProviderDefaults = {
  contextWindow?: number;
  maxOutputTokens?: number;
  compaction?: CompactionConfig;
};

export type Profile = {
  /** Agent system prompt */
  prompt: string;
  /** Agent description (for subagent selection / UI display) */
  description: string;
  /** Execution backend — provider names are validated against the runtime registry */
  provider?: string;
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
  /** Context window size override — for models where API doesn't report it */
  contextWindow?: number;
  /** Max output tokens override — for models where API doesn't report it */
  maxOutputTokens?: number;
  /** Compaction tuning — overrides providerDefaults when set */
  compaction?: CompactionConfig;
  /** Skills to preload into agent context (skill names from .claude/skills/) */
  skills?: string[];
  /**
   * Codex-specific sandbox mode — overrides the sandboxMode derived from permissionPolicy.
   * Only read by the Codex provider; ignored by Claude and other providers.
   * "read-only" = no writes or shell; "workspace-write" = writes in cwd, no arbitrary shell;
   * "danger-full-access" = no restrictions.
   */
  codexSandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * Codex-specific command rules expressed as Starlark rule strings.
   * Written to a temp ~/.codex/rules/ file before each session, cleaned up after.
   * Allows per-profile allow/forbidden rules for specific command prefixes.
   * Only read by the Codex provider; ignored by all other providers.
   * NOTE: "prompt" decisions are auto-rejected in exec mode — use "allow"/"forbidden" only.
   */
  codexRules?: string[];
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

export type ResolvedProfilePrompt = {
  text: string;
  mode: "custom" | "append";
};

export type NotificationChannel =
  | { type: "webhook"; url: string; method?: string; headers?: Record<string, string> }
  | { type: "file"; path: string };

export type GlobalConfig = {
  mcpServers?: Record<string, McpServerConfig>;
  providerDefaults?: Record<string, ProviderDefaults>;
  notificationChannels?: Record<string, NotificationChannel>;
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
  /** Visible actions — omit or ["*"] for all */
  actions?: string[];
  /** Default execution provider for sessions under this user profile */
  provider?: string;
  memoryFilter?: string;
  memory?: UserProfileMemory;
  /** Show project paths from ALL user profiles in the CWD picker (default: false) */
  showAllProjectPaths?: boolean;
  /** Dashboard widget layout — read by frontend */
  dashboard?: { widgets: Array<{ type: string; [key: string]: unknown }> };
  /** Computer/machine name — displayed in top-nav status bar */
  computer?: string;
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

/** Resolve an agent profile — checks project-local .modus/ first when cwd is provided */
export function getProfile(name: string, cwd?: string): Profile | undefined {
  if (cwd) {
    const proj = readJson<Profile>(join(projectAgentsDir(cwd), `${name}.json`));
    if (proj) return proj;
  }
  return readProfileFile(name);
}

/** List all agent profile names — merges project-local when cwd is provided */
export function listProfileNames(cwd?: string): string[] {
  const baseNames = !existsSync(AGENTS_DIR) ? [] : readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"));

  if (cwd) {
    const projDir = projectAgentsDir(cwd);
    if (existsSync(projDir)) {
      const projNames = readdirSync(projDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => basename(f, ".json"));
      const merged = new Set([...projNames, ...baseNames]);
      return [...merged].sort();
    }
  }
  return baseNames.sort();
}

/** Get all agent profiles as a Record — merges project-local when cwd is provided */
export function getAllProfiles(cwd?: string): Record<string, Profile> {
  // Base profiles first, then project-local overrides on top
  const result: Record<string, Profile> = {};
  for (const name of listProfileNames()) {
    const p = readProfileFile(name);
    if (p) result[name] = p;
  }
  if (cwd) {
    const projDir = projectAgentsDir(cwd);
    if (existsSync(projDir)) {
      for (const f of readdirSync(projDir).filter(f => f.endsWith(".json"))) {
        const name = basename(f, ".json");
        const p = readJson<Profile>(join(projDir, f));
        if (p) result[name] = p;
      }
    }
  }
  return result;
}

export function resolveProfilePrompt(profile?: Profile): ResolvedProfilePrompt | undefined {
  if (!profile?.prompt) return undefined;
  const userData = getUserData();
  const text = profile.prompt.replace(/\{\{(\w+)\}\}/g, (_, key) => userData[key] ?? `{{${key}}}`);
  return {
    text,
    mode: profile.promptMode === "custom" ? "custom" : "append",
  };
}

/** Save an agent profile (create or update).
 *  When cwd is provided, writes to <cwd>/.modus/profiles/agents/ instead of harness-local. */
export function saveProfile(name: string, profile: Profile, cwd?: string): void {
  if (name.startsWith("_")) throw new Error("Profile names cannot start with _");
  const dir = cwd ? projectAgentsDir(cwd) : AGENTS_DIR;
  if (cwd && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${name}.json`);
  snapshot(filePath);
  writeJson(filePath, profile);
}

/** Delete an agent profile.
 *  When cwd is provided, deletes from <cwd>/.modus/profiles/agents/. */
export function deleteProfile(name: string, cwd?: string): boolean {
  const dir = cwd ? projectAgentsDir(cwd) : AGENTS_DIR;
  const filePath = join(dir, `${name}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

// ── Global Config ──

/** Read the global config — merges project-local MCP servers when cwd is provided */
export function getGlobalConfig(cwd?: string): GlobalConfig {
  const base = readJson<GlobalConfig>(join(PROFILES_DIR, "_global.json")) ?? {};
  if (!cwd) return base;
  const proj = readJson<GlobalConfig>(projectGlobalPath(cwd));
  if (!proj) return base;
  return {
    ...base,
    mcpServers: { ...base.mcpServers, ...proj.mcpServers },
    providerDefaults: { ...base.providerDefaults, ...proj.providerDefaults },
    notificationChannels: { ...base.notificationChannels, ...proj.notificationChannels },
  };
}

/** Save the global config.
 *  When cwd is provided, writes to <cwd>/.modus/_global.json instead of harness-local. */
export function saveGlobalConfig(config: GlobalConfig, cwd?: string): void {
  const filePath = cwd ? projectGlobalPath(cwd) : join(PROFILES_DIR, "_global.json");
  if (cwd) {
    const dir = join(cwd, MODUS_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
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

// ── Project Registry ──
// Stored in _projects.json. Maps project IDs to names + paths.
// Each project's .modus/_project.json carries just the ID — portable across moves.

const PROJECTS_FILE = join(PROFILES_DIR, "_projects.json");

export type ProjectEntry = {
  name: string;
  path: string;
  created: string;
};

export type ProjectRegistry = Record<string, ProjectEntry>;

export function getProjectRegistry(): ProjectRegistry {
  return readJson<ProjectRegistry>(PROJECTS_FILE) ?? {};
}

function saveProjectRegistry(registry: ProjectRegistry): void {
  snapshot(PROJECTS_FILE);
  writeJson(PROJECTS_FILE, registry);
}

export function getProjectById(id: string): (ProjectEntry & { id: string }) | undefined {
  const reg = getProjectRegistry();
  const entry = reg[id];
  return entry ? { id, ...entry } : undefined;
}

export function getProjectByPath(path: string): (ProjectEntry & { id: string }) | undefined {
  const reg = getProjectRegistry();
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const [id, entry] of Object.entries(reg)) {
    if (entry.path.replace(/\\/g, "/").replace(/\/+$/, "") === normalized) {
      return { id, ...entry };
    }
  }
  return undefined;
}

export function registerProject(id: string, entry: ProjectEntry): void {
  const reg = getProjectRegistry();
  reg[id] = entry;
  saveProjectRegistry(reg);
}

export function updateProjectPath(id: string, newPath: string): boolean {
  const reg = getProjectRegistry();
  if (!reg[id]) return false;
  reg[id].path = newPath;
  saveProjectRegistry(reg);
  return true;
}

export function listProjects(): Array<ProjectEntry & { id: string }> {
  const reg = getProjectRegistry();
  return Object.entries(reg).map(([id, entry]) => ({ id, ...entry }));
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
