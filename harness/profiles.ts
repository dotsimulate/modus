/**
 * Profile loader — reads JSON files from ~/.modus/profiles/ subfolders.
 *
 * User-home layout (see harness/modus-home.ts for the single source of truth):
 *   ~/.modus/profiles/agents/         — agent profile definitions
 *   ~/.modus/profiles/users/          — user profile definitions
 *   ~/.modus/profiles/state/          — runtime UI state (app-managed)
 *   ~/.modus/profiles/ui/{agents,users}/ — interface-specific UI sidecars
 *   ~/.modus/profiles/_global.json    — shared MCP servers + provider defaults
 *   ~/.modus/profiles/_users.json     — template var defaults
 *   ~/.modus/projects.json            — registry of known projects
 *
 * Project-local overrides — any project directory can contain:
 *   .modus/profiles/agents/  — extra agent profiles (override base by name)
 *   .modus/actions/          — extra actions (loaded by action-runner)
 *   .modus/_global.json      — project-level MCP servers (merged additively)
 *
 * When a session CWD is provided, project-local profiles take precedence
 * over base profiles of the same name. Listing functions merge both sources.
 *
 * Shipped agent templates live in harness/templates/profiles/ and seed the
 * user home on first boot via rehydrateHome(). The repo itself is read-only
 * at runtime; no harness code writes inside harness/profiles/.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import {
  homeAgentsDir, homeGlobalPath, homeProjectsJsonPath, homeStateDir,
  homeUiAgentsDir, homeUiUsersDir, homeUsersDir, homeUsersJsonPath,
} from "./modus-home";
import { recordAttributionHint, scheduleCommit } from "./workspace-history";

const AGENTS_DIR = homeAgentsDir();
const USERS_DIR = homeUsersDir();
const STATE_DIR = homeStateDir();
const UI_AGENTS_DIR = homeUiAgentsDir();
const UI_USERS_DIR = homeUiUsersDir();

// ── Project-local .modus/ discovery ──

const MODUS_DIR = ".modus";

function projectAgentsDir(cwd: string): string {
  return join(cwd, MODUS_DIR, "profiles", "agents");
}

function projectProfileUiDir(cwd: string): string {
  return join(cwd, MODUS_DIR, "ui", "profiles", "agents");
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

export type EffortLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export type Profile = {
  /** Agent system prompt */
  prompt: string;
  /** Agent description (for subagent selection / UI display) */
  description: string;
  /** Working directory override — absolute path or relative to the session CWD.
   *  When set, the agent session runs from this directory. Skills in <cwd>/.claude/skills/
   *  are scoped to this agent only. */
  cwd?: string;
  /** Extra workspace roots to grant alongside the primary cwd */
  additionalDirectories?: string[];
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
  effort?: EffortLevel;
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
  /** Provider-specific runtime controls, e.g. Codex speed/search/sandbox settings. */
  providerControls?: {
    codex?: {
      sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
      webSearchMode?: "disabled" | "cached" | "live";
      serviceTier?: "standard" | "fast" | "priority";
    };
    claude?: {
      permissionMode?: "default" | "acceptEdits" | "plan" | "dontAsk";
    };
    [provider: string]: unknown;
  };
  /** Context window size override — for models where API doesn't report it */
  contextWindow?: number;
  /** Max output tokens override — for models where API doesn't report it */
  maxOutputTokens?: number;
  /** Compaction tuning — overrides providerDefaults when set */
  compaction?: CompactionConfig;
  /** CWD suggestions — soft UI hints for the CWD picker. First entry auto-fills CWD,
   *  rest fill additionalDirectories. Unlike `cwd`, these are overridable by the user. */
  cwdSuggestions?: string[];
  /** Maximum budget in USD — session stops if exceeded (Claude SDK only) */
  maxBudgetUsd?: number;
  /** Environment variables passed to the Claude Code process (Claude SDK only) */
  env?: Record<string, string>;
  /** Local plugins to load — each entry is { type: "local", path: "./my-plugin" } (Claude SDK only) */
  plugins?: Array<{ type: "local"; path: string }>;
  /** Sandbox settings for command execution isolation (Claude SDK only) */
  sandbox?: {
    enabled?: boolean;
    autoAllowBashIfSandboxed?: boolean;
    allowUnsandboxedCommands?: boolean;
    network?: {
      allowedDomains?: string[];
      allowManagedDomainsOnly?: boolean;
      allowUnixSockets?: string[];
      allowAllUnixSockets?: boolean;
      allowLocalBinding?: boolean;
    };
  };
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
  /** Moves to auto-activate when a session starts with this profile.
   *  Persistent moves register as ambient gathers (re-run per turn).
   *  Non-persistent moves do a one-shot gather prepended to the first message.
   *  API moves get tokens created and injected into session context. */
  moves?: ProfileMoveBinding[];
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
    /** Widget types to show in the LeftPanel when this profile is active */
    panelWidgets?: string[];
  };
  /**
   * Where this profile was loaded from — set by getAllProfiles() at read time,
   * never written to disk.
   *   - "project": `<cwd>/.modus/profiles/agents/<name>.json`
   *   - "user":    `~/.modus/profiles/agents/<name>.json`
   * Project-origin profiles always appear in the UI regardless of the active
   * user profile's `agentProfiles` whitelist.
   */
  origin?: "user" | "project";
};

/** Move binding for agent profiles — declares moves that auto-activate on session start. */
export type ProfileMoveBinding = {
  /** Move name (must exist in harness/moves/ or .modus/moves/) */
  name: string;
  /** Inputs to pass to the move's gather() */
  inputs?: Record<string, unknown>;
};

export type ResolvedProfilePrompt = {
  text: string;
  mode: "custom" | "append";
};

export type NotificationChannel =
  | {
      type: "webhook";
      url: string;
      method?: string;
      headers?: Record<string, string>;
      /** Shape the webhook JSON body. `{text}` is replaced with the (JSON-escaped) message,
       *  `{data}` with the JSON-stringified data object. Example (Discord): `{"content":"{text}"}`,
       *  (Slack): `{"text":"{text}"}`. When set, overrides the default body shape. */
      bodyTemplate?: string;
      /** Shorthand: wrap the text under this single JSON key (e.g. "content" → `{"content": text, ...data}`).
       *  Ignored when `bodyTemplate` is set. */
      contentField?: string;
    }
  | { type: "file"; path: string };

export type ClientExtensionsConfig = {
  /** Additional trusted extension roots on disk */
  paths?: string[];
  /** Extension IDs enabled by default */
  enabled?: string[];
  /** Extension IDs explicitly disabled */
  disabled?: string[];
  /** Per-extension settings values (extensionId → key/value pairs) */
  settings?: Record<string, Record<string, unknown>>;
};

export type ProfileUiConfig = NonNullable<Profile["ui"]>;

export type UserProfileUiConfig = {
  dashboard?: UserProfile["dashboard"];
  leftPanel?: { widgets?: string[] };
  pageNav?: {
    mode?: "auto" | "compact" | "tabs" | "launcher";
    enabled?: string[];
    disabled?: string[];
    pinned?: string[];
    order?: string[];
    labels?: Record<string, string>;
  };
  /** Per-view panel layout overrides. Keys are view names (e.g. "chat", "actions"). */
  layouts?: Record<string, {
    left?: { mode?: "list" | "tabs"; widgets?: Array<string | { id?: string; type: string; [key: string]: unknown }>; tree?: unknown };
    right?: { mode?: "list" | "tabs"; widgets?: Array<string | { id?: string; type: string; [key: string]: unknown }>; tree?: unknown };
  }>;
  computer?: string;
  editor?: string;
  clientExtensions?: ClientExtensionsConfig;
};

export type GlobalConfig = {
  mcpServers?: Record<string, McpServerConfig>;
  providerDefaults?: Record<string, ProviderDefaults>;
  notificationChannels?: Record<string, NotificationChannel>;
  clientExtensions?: ClientExtensionsConfig;
};

function getBuiltInMcpServers(): Record<string, McpServerConfig> {
  const port = Number(process.env.HARNESS_PORT ?? 3777);
  const token = process.env.HARNESS_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  return {
    modus: {
      type: "http",
      url: `http://127.0.0.1:${port}/api/mcp/modus`,
      ...(headers ? { headers } : {}),
    },
  };
}

// ── User Profiles ──
// Scoped views of the harness — each profile filters projects, agent profiles, memory.
// Config lives in ~/.modus/profiles/users/. Runtime state lives in ~/.modus/profiles/state/.

export type UserProfileState = {
  sidebarGroupMode?: "time" | "agent";
  sidebarCollapsedGroups?: string[];
  sidebarConfigExpanded?: boolean;
  lastAgentProfile?: string;
  lastCwd?: string;
  lastSessionId?: string | null;
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
  /** Default agent profile selected in the UI for this user profile */
  defaultAgentProfile?: string;
  /** Default execution provider for sessions under this user profile */
  provider?: string;
  /** Default model when the selected agent profile does not define one */
  model?: string;
  /** Default reasoning/thinking effort when the selected agent profile does not define one */
  effort?: EffortLevel;
  memoryFilter?: string;
  memory?: UserProfileMemory;
  /** Show project paths from ALL user profiles in the CWD picker (default: false) */
  showAllProjectPaths?: boolean;
  /** Dashboard widget layout — read by frontend */
  dashboard?: {
    widgets?: Array<{ type: string; [key: string]: unknown }>;
    pages?: Array<{
      id: string;
      title: string;
      blocks: Array<
        | { kind: "widget"; widget: { type: string; [key: string]: unknown } }
        | { kind: "module"; module: "memory" | "actions" | "git"; [key: string]: unknown }
        | { kind: "text"; markdown: string; [key: string]: unknown }
      >;
    }>;
  };
  /** Left panel widget layout — read by frontend */
  leftPanel?: {
    widgets?: string[];
  };
  /** Computer/machine name — displayed in top-nav status bar */
  computer?: string;
  /** Preferred editor CLI command for "open in editor" */
  editor?: string;
  /** Client-side UI extensions enabled/disabled for this project-scoped view */
  clientExtensions?: ClientExtensionsConfig;
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

function uniqueStrings(values: Array<string | undefined> | undefined): string[] | undefined {
  if (!values) return undefined;
  const result = values
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);
  return result.length > 0 ? Array.from(new Set(result)) : undefined;
}

function hasOwnKeys(value: Record<string, unknown> | undefined): boolean {
  return !!value && Object.keys(value).length > 0;
}

function mergeExtensionSettings(
  base?: Record<string, Record<string, unknown>>,
  override?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> | undefined {
  if (!base && !override) return undefined;
  const merged: Record<string, Record<string, unknown>> = {};
  for (const id of new Set([...Object.keys(base ?? {}), ...Object.keys(override ?? {})])) {
    merged[id] = { ...base?.[id], ...override?.[id] };
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeClientExtensions(
  base?: ClientExtensionsConfig,
  override?: ClientExtensionsConfig,
): ClientExtensionsConfig | undefined {
  const merged: ClientExtensionsConfig = {
    paths: uniqueStrings([...(base?.paths ?? []), ...(override?.paths ?? [])]),
    enabled: "enabled" in (override ?? {}) ? override!.enabled : base?.enabled,
    disabled: "disabled" in (override ?? {}) ? override!.disabled : base?.disabled,
    settings: mergeExtensionSettings(base?.settings, override?.settings),
  };
  return merged.paths || merged.enabled || merged.disabled || merged.settings ? merged : undefined;
}

function mergeProfileUi(
  base?: ProfileUiConfig,
  override?: ProfileUiConfig,
): ProfileUiConfig | undefined {
  if (!base && !override) return undefined;
  const merged: ProfileUiConfig = { ...(base ?? {}), ...(override ?? {}) };
  return hasOwnKeys(merged as Record<string, unknown>) ? merged : undefined;
}

function mergeLayouts(
  base?: UserProfileUiConfig["layouts"],
  override?: UserProfileUiConfig["layouts"],
): UserProfileUiConfig["layouts"] | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;
  const allViews = new Set([...Object.keys(base), ...Object.keys(override)]);
  const merged: NonNullable<UserProfileUiConfig["layouts"]> = {};
  for (const view of allViews) {
    const b = base[view];
    const o = override[view];
    if (!b) { merged[view] = o!; continue; }
    if (!o) { merged[view] = b; continue; }
    merged[view] = {
      left: (b.left || o.left) ? { ...(b.left ?? {}), ...(o.left ?? {}) } : undefined,
      right: (b.right || o.right) ? { ...(b.right ?? {}), ...(o.right ?? {}) } : undefined,
    };
  }
  return hasOwnKeys(merged as Record<string, unknown>) ? merged : undefined;
}

function mergeUserProfileUi(
  base?: UserProfileUiConfig,
  override?: UserProfileUiConfig,
): UserProfileUiConfig | undefined {
  if (!base && !override) return undefined;
  const merged: UserProfileUiConfig = {
    dashboard: (base?.dashboard || override?.dashboard)
      ? { ...(base?.dashboard ?? {}), ...(override?.dashboard ?? {}) }
      : undefined,
    leftPanel: (base?.leftPanel || override?.leftPanel)
      ? { ...(base?.leftPanel ?? {}), ...(override?.leftPanel ?? {}) }
      : undefined,
    pageNav: (base?.pageNav || override?.pageNav)
      ? {
          ...(base?.pageNav ?? {}),
          ...(override?.pageNav ?? {}),
          labels: override?.pageNav?.labels ?? base?.pageNav?.labels,
        }
      : undefined,
    layouts: mergeLayouts(base?.layouts, override?.layouts),
    computer: override?.computer ?? base?.computer,
    editor: override?.editor ?? base?.editor,
    clientExtensions: mergeClientExtensions(base?.clientExtensions, override?.clientExtensions),
  };
  return hasOwnKeys(merged as Record<string, unknown>) ? merged : undefined;
}

function profileUiPath(name: string, cwd?: string): string {
  return cwd
    ? join(projectProfileUiDir(cwd), `${name}.json`)
    : join(UI_AGENTS_DIR, `${name}.json`);
}

function userProfileUiPath(name: string): string {
  return join(UI_USERS_DIR, `${name}.json`);
}

function legacyProfileUi(profile?: Profile): ProfileUiConfig | undefined {
  return profile?.ui ? { ...profile.ui } : undefined;
}

function legacyUserProfileUi(profile?: UserProfile): UserProfileUiConfig | undefined {
  if (!profile) return undefined;
  const ui: UserProfileUiConfig = {
    dashboard: profile.dashboard,
    leftPanel: profile.leftPanel,
    computer: profile.computer,
    editor: profile.editor,
    clientExtensions: profile.clientExtensions,
  };
  return hasOwnKeys(ui as Record<string, unknown>) ? ui : undefined;
}

function resolveConfiguredPath(rawPath: string, baseDir: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) return join(homedir(), rawPath.slice(2));
  return rawPath.startsWith("/") ? rawPath : join(baseDir, rawPath);
}

function notifyUserScopeWrite(filePath: string): void {
  recordAttributionHint({ kind: "user" }, filePath, { type: "human" });
  scheduleCommit({ kind: "user" });
}

// ── Agent Profile CRUD ──

function readProfileFile(name: string): Profile | undefined {
  return readJson<Profile>(join(AGENTS_DIR, `${name}.json`));
}

/** Read an agent profile config without applying UI sidecars. */
export function getProfileConfig(name: string, cwd?: string): Profile | undefined {
  if (cwd) {
    const proj = readJson<Profile>(join(projectAgentsDir(cwd), `${name}.json`));
    if (proj) return proj;
  }
  return readProfileFile(name);
}

export function getProfileUiConfig(name: string, cwd?: string): ProfileUiConfig | undefined {
  const legacy = legacyProfileUi(getProfileConfig(name, cwd));
  const sidecar = readJson<ProfileUiConfig>(profileUiPath(name, cwd));
  return mergeProfileUi(legacy, sidecar);
}

/** Resolve an agent profile — checks project-local .modus/ first when cwd is provided */
export function getProfile(name: string, cwd?: string): Profile | undefined {
  return getProfileConfig(name, cwd);
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

/** Get all agent profiles as a Record — merges project-local when cwd is provided.
 *  Each profile is tagged with `origin` so the UI can distinguish project-local
 *  profiles (always visible) from user-home profiles (subject to whitelist). */
export function getAllProfiles(cwd?: string): Record<string, Profile> {
  const result: Record<string, Profile> = {};

  // Project-local names win over user-home names of the same name (getProfileConfig
  // already handles that override internally). Track which names are project-local.
  const projectNames = new Set<string>();
  if (cwd) {
    const projDir = projectAgentsDir(cwd);
    if (existsSync(projDir)) {
      for (const f of readdirSync(projDir)) {
        if (f.endsWith(".json")) projectNames.add(basename(f, ".json"));
      }
    }
  }

  for (const name of listProfileNames(cwd)) {
    const p = getProfileConfig(name, cwd);
    if (p) {
      result[name] = {
        ...p,
        origin: projectNames.has(name) ? "project" : "user",
      };
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
  notifyUserScopeWrite(filePath);
  writeJson(filePath, profile);
}

export function saveProfileUiConfig(name: string, ui: ProfileUiConfig, cwd?: string): void {
  const filePath = profileUiPath(name, cwd);
  if (cwd) mkdirSync(projectProfileUiDir(cwd), { recursive: true });
  notifyUserScopeWrite(filePath);
  writeJson(filePath, ui);
}

export function patchProfileUiConfig(name: string, patch: Partial<ProfileUiConfig>, cwd?: string): ProfileUiConfig {
  const merged = { ...(getProfileUiConfig(name, cwd) ?? {}), ...patch } as ProfileUiConfig;
  saveProfileUiConfig(name, merged, cwd);
  return merged;
}

/** Delete an agent profile.
 *  When cwd is provided, deletes from <cwd>/.modus/profiles/agents/. */
export function deleteProfile(name: string, cwd?: string): boolean {
  const dir = cwd ? projectAgentsDir(cwd) : AGENTS_DIR;
  const filePath = join(dir, `${name}.json`);
  const uiFilePath = profileUiPath(name, cwd);
  const deletedCore = existsSync(filePath);
  if (deletedCore) unlinkSync(filePath);
  if (existsSync(uiFilePath)) unlinkSync(uiFilePath);
  return deletedCore;
}

// ── Global Config ──

/** Read the global config — merges project-local MCP servers when cwd is provided */
export function getGlobalConfig(cwd?: string): GlobalConfig {
  const base = readJson<GlobalConfig>(homeGlobalPath()) ?? {};
  const builtInMcpServers = getBuiltInMcpServers();
  if (!cwd) {
    return {
      ...base,
      mcpServers: { ...builtInMcpServers, ...base.mcpServers },
    };
  }
  const proj = readJson<GlobalConfig>(projectGlobalPath(cwd));
  if (!proj) {
    return {
      ...base,
      mcpServers: { ...builtInMcpServers, ...base.mcpServers },
    };
  }
  return {
    ...base,
    mcpServers: { ...builtInMcpServers, ...base.mcpServers, ...proj.mcpServers },
    providerDefaults: { ...base.providerDefaults, ...proj.providerDefaults },
    notificationChannels: { ...base.notificationChannels, ...proj.notificationChannels },
    clientExtensions: mergeClientExtensions(base.clientExtensions, proj.clientExtensions),
  };
}

export function getResolvedClientExtensionsConfig(cwd?: string, userProfileName?: string): ClientExtensionsConfig {
  const baseFile = homeGlobalPath();
  const baseConfig = readJson<GlobalConfig>(baseFile);
  const baseClient = baseConfig?.clientExtensions;

  const projectFile = cwd ? projectGlobalPath(cwd) : undefined;
  const projectClient = projectFile ? readJson<GlobalConfig>(projectFile)?.clientExtensions : undefined;
  const userClient = userProfileName ? getUserProfileUiConfig(userProfileName)?.clientExtensions : undefined;

  const merged = mergeClientExtensions(
    mergeClientExtensions(baseClient, projectClient),
    userClient,
  ) ?? {};

  return {
    paths: merged.paths?.map((entry) => {
      const sourceFile = projectClient?.paths?.includes(entry) && projectFile ? projectFile : baseFile;
      return resolveConfiguredPath(entry, dirname(sourceFile));
    }),
    enabled: merged.enabled,
    disabled: merged.disabled,
    settings: merged.settings,
  };
}

/** Save the global config.
 *  When cwd is provided, writes to <cwd>/.modus/_global.json instead of harness-local. */
export function saveGlobalConfig(config: GlobalConfig, cwd?: string): void {
  const filePath = cwd ? projectGlobalPath(cwd) : homeGlobalPath();
  if (cwd) {
    const dir = join(cwd, MODUS_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  notifyUserScopeWrite(filePath);
  writeJson(filePath, config);
}

// ── User Profile CRUD ──

function readUserProfileFile(name: string): UserProfile | undefined {
  return readJson<UserProfile>(join(USERS_DIR, `${name}.json`));
}

/** Read a user profile config without applying UI sidecars. */
export function getUserProfileConfig(name: string): UserProfile | undefined {
  return readUserProfileFile(name);
}

export function getUserProfileUiConfig(name: string): UserProfileUiConfig | undefined {
  const legacy = legacyUserProfileUi(getUserProfileConfig(name));
  const sidecar = readJson<UserProfileUiConfig>(userProfileUiPath(name));
  return mergeUserProfileUi(legacy, sidecar);
}

export function getUserProfile(name: string): UserProfile | undefined {
  return getUserProfileConfig(name);
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
    const p = getUserProfileConfig(name);
    if (p) result[name] = p;
  }
  return result;
}

export function saveUserProfile(name: string, profile: UserProfile): void {
  const filePath = join(USERS_DIR, `${name}.json`);
  notifyUserScopeWrite(filePath);
  writeJson(filePath, profile);
}

export function deleteUserProfile(name: string): boolean {
  const filePath = join(USERS_DIR, `${name}.json`);
  const uiFilePath = userProfileUiPath(name);
  const deletedCore = existsSync(filePath);
  if (deletedCore) unlinkSync(filePath);
  if (existsSync(uiFilePath)) unlinkSync(uiFilePath);
  return deletedCore;
}

/** Partial update — merges provided fields into existing user profile config */
export function patchUserProfile(name: string, patch: Partial<UserProfile>): UserProfile | undefined {
  const existing = readUserProfileFile(name);
  if (!existing) return undefined;
  const merged = { ...existing, ...patch };
  saveUserProfile(name, merged);
  return merged;
}

export function saveUserProfileUiConfig(name: string, ui: UserProfileUiConfig): void {
  const filePath = userProfileUiPath(name);
  notifyUserScopeWrite(filePath);
  writeJson(filePath, ui);
}

export function patchUserProfileUiConfig(name: string, patch: Partial<UserProfileUiConfig>): UserProfileUiConfig {
  const merged = mergeUserProfileUi(getUserProfileUiConfig(name), patch as UserProfileUiConfig) ?? {};
  saveUserProfileUiConfig(name, merged);
  return merged;
}

// ── User Profile State CRUD ──
// Runtime UI state — lives in ~/.modus/profiles/state/, app-managed.

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
// Stored at ~/.modus/profiles/_users.json. Flat key-value object for user info
// + template vars. Keys are available as {{key}} in profile prompts.

const USERS_FILE = homeUsersJsonPath();

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
// Stored at ~/.modus/projects.json. Maps project IDs to names + paths.
// Each project's .modus/_project.json carries just the ID — portable across moves.

const PROJECTS_FILE = homeProjectsJsonPath();

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
  notifyUserScopeWrite(PROJECTS_FILE);
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
