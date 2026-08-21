/**
 * Profile loader — reads JSON files from the current Vault's profiles/ tree.
 *
 * Vault-home layout (see harness/modus-home.ts for the single source of truth):
 *   <current-home>/profiles/agents/         — agent profile definitions
 *   <current-home>/profiles/users/          — user profile definitions
 *   <current-home>/profiles/state/          — runtime UI state (app-managed)
 *   <current-home>/profiles/ui/{agents,users}/ — interface-specific UI sidecars
 *   <current-home>/profiles/_global.json    — MCP servers + provider defaults
 *   <current-home>/profiles/_users.json     — template var defaults
 *   <current-home>/projects.json            — registry of known projects
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
 * current Vault home on first boot via rehydrateHome(). The repo itself is read-only
 * at runtime; no harness code writes inside harness/profiles/.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join, basename, dirname, isAbsolute, resolve } from "path";
import { homedir } from "os";
import {
  homeAgentsDir, homeGlobalPath, homeProjectsJsonPath, homeStateDir,
  homeUiAgentsDir, homeUiUsersDir, homeUsersDir, homeUsersJsonPath,
} from "./modus-home";
import { recordAttributionHint, scheduleCommit } from "./workspace-history";
import {
  getCoreModusPlugin,
  getModusPlugin,
  getPluginGlobalConfigPath,
  getPluginProfilesDir,
  getPluginProfileUiDir,
  listEnabledModusPlugins,
  type ModusPlugin,
} from "./modus-plugins";
import { legacyProviderMcpBearer, sessionMcpPath } from "./session-mcp-credential";
import {
  normalizePermissionPolicy,
  type PermissionPolicy,
} from "./permission-policy";

export type { PermissionPolicy } from "./permission-policy";

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
  mcpConfig?: string;
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
      permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
    };
    antigravity?: {
      mode?: "accept-edits" | "plan";
      sandbox?: boolean;
      printTimeout?: string;
    };
    grokBuild?: {
      mode?: "default" | "auto" | "plan" | "always-approve";
      sandbox?: string;
      noMemory?: boolean;
      noSubagents?: boolean;
      disableWebSearch?: boolean;
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
  /** Skills to attach for the whole session, by name. Resolved from
   *  `<project>/.modus/skills/`, `<current-home>/skills/`, and enabled plugins.
   *  Names that resolve to nothing are skipped with a warning, never fatal. */
  skills?: string[];
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
   *   - "user":    `<current-home>/profiles/agents/<name>.json`
   * Project-origin profiles always appear in the UI regardless of the active
   * user profile's `agentProfiles` whitelist.
   */
  origin?: "user" | "project" | "plugin";
  /** Collision-free runtime identity. Never persisted in a profile file. */
  key?: string;
  /** Clean filename-derived label used by the UI. */
  displayName?: string;
  /** Present for plugin-origin profiles, including the built-in core plugin. */
  pluginId?: string;
  pluginName?: string;
  pluginPath?: string;
};

/** Move binding for agent profiles — declares moves that auto-activate on session start. */
export type ProfileMoveBinding = {
  /** Move name (must exist in harness/moves/ or .modus/moves/) */
  name: string;
  /** Inputs to pass to the move's gather() */
  inputs?: Record<string, unknown>;
  /**
   * Ask the user for this move's inputs when the session opens instead of
   * running it at session start. The move's form docks above the composer,
   * seeded from `inputs` above — so a binding can prefill some fields and ask
   * for the rest — and the move activates when the user submits it. Dismissing
   * the form skips the move for that session. Ignored when the move declares no
   * inputs, since there would be nothing to ask.
   */
  ask?: boolean;
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

export type TextToSpeechProviderId = "kokoro" | "zonos2" | "neutts" | "elevenlabs";
export type TextToSpeechAudioFormat = "wav" | "mp3" | "pcm";

export type TextToSpeechProviderConfig = {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  outputFormat?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
};

export type TextToSpeechConfig = {
  enabled?: boolean;
  defaultProvider?: TextToSpeechProviderId;
  defaultVoice?: string;
  defaultFormat?: TextToSpeechAudioFormat;
  voiceAliases?: Record<string, string>;
  providers?: Partial<Record<TextToSpeechProviderId, TextToSpeechProviderConfig>>;
};

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
  interface?: UserInterfaceConfig;
  clientExtensions?: ClientExtensionsConfig;
};

export type ToolCallDisplayMode = "expanded" | "collapsed" | "hidden";

/**
 * How the chat indexes its own scroll.
 *   scroll — the native scrollbar, nothing else
 *   spine  — sparse per-message tick index
 *   ruler  — turn-indexed: prose and tool lanes left of the axis, your own
 *            turns as accent rungs on the right, turn numbers on hover
 */
export type ChatScrollIndicator = "scroll" | "spine" | "ruler";
export type ChatPresentation = "conversation" | "turns";

export type UserInterfaceConfig = {
  chat?: {
    fontScale?: number;
    chatWidth?: number;
    scrollIndicator?: ChatScrollIndicator;
    presentation?: ChatPresentation;
    scrollThroughTurns?: boolean;
    /** When true, this user profile overrides the device's chat display defaults. */
    projectOverride?: boolean;
    /** @deprecated superseded by scrollIndicator; still read so older profiles migrate. */
    spineEnabled?: boolean;
  };
  conversation?: {
    showThinking?: boolean;
    showMeta?: boolean;
    toolCalls?: ToolCallDisplayMode;
    showGitEvents?: boolean;
    showFileChanges?: boolean;
    /** Let the harness withhold very large tool payloads until asked. */
    deferHeavyDetails?: boolean;
  };
  /** Which readouts the session config bar shows. Omit for the defaults. */
  configBar?: {
    items?: string[];
  };
  motion?: "system" | "reduced";
};

export type GlobalConfig = {
  mcpServers?: Record<string, McpServerConfig>;
  mcpConfig?: string;
  permissionNotificationChannels?: string[];
  providerDefaults?: Record<string, ProviderDefaults>;
  notificationChannels?: Record<string, NotificationChannel>;
  clientExtensions?: ClientExtensionsConfig;
  /** Project-scoped plugin setting values (`pluginId` → field values). */
  pluginSettings?: Record<string, Record<string, unknown>>;
  textToSpeech?: TextToSpeechConfig;
};

/**
 * The built-in `modus` MCP server entry.
 *
 * `scopeKey` appends a path suffix the endpoint uses to identify which session
 * is calling — the endpoint is otherwise one URL for everyone, and only
 * `modus_submit` carries identity (in its token). Sessions with attached skills
 * get the scoped form so the skill tools can resolve what they may read;
 * everything else keeps the plain URL and the plain single-tool surface.
 *
 * Single source of truth for the URL and auth headers: session-level overrides
 * build on this rather than reconstructing it.
 */
export function buildModusMcpServer(scopeKey?: string, sessionCredential?: string): McpServerConfig {
  const port = Number(process.env.HARNESS_PORT ?? 3777);
  const token = sessionCredential ?? legacyProviderMcpBearer();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  return {
    type: "http",
    url: `http://127.0.0.1:${port}${sessionMcpPath(scopeKey)}`,
    ...(headers ? { headers } : {}),
  };
}

function getBuiltInMcpServers(): Record<string, McpServerConfig> {
  return { modus: buildModusMcpServer() };
}

// ── User Profiles ──
// Scoped views of the harness — each profile filters projects, agent profiles, memory.
// Config lives in <current-home>/profiles/users/. Runtime state is in profiles/state/.

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
  /** Qualified plugin profile keys hidden from this user's otherwise-global picker. */
  hiddenPluginProfiles?: string[];
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
  /** User-level chat, conversation, and motion settings. */
  interface?: UserInterfaceConfig;
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
    interface: (base?.interface || override?.interface)
      ? {
          chat: (base?.interface?.chat || override?.interface?.chat)
            ? { ...(base?.interface?.chat ?? {}), ...(override?.interface?.chat ?? {}) }
            : undefined,
          conversation: (base?.interface?.conversation || override?.interface?.conversation)
            ? { ...(base?.interface?.conversation ?? {}), ...(override?.interface?.conversation ?? {}) }
            : undefined,
          configBar: (base?.interface?.configBar || override?.interface?.configBar)
            ? { ...(base?.interface?.configBar ?? {}), ...(override?.interface?.configBar ?? {}) }
            : undefined,
          motion: override?.interface?.motion ?? base?.interface?.motion,
        }
      : undefined,
    clientExtensions: mergeClientExtensions(base?.clientExtensions, override?.clientExtensions),
  };
  return hasOwnKeys(merged as Record<string, unknown>) ? merged : undefined;
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
    interface: profile.interface,
    clientExtensions: profile.clientExtensions,
  };
  return hasOwnKeys(ui as Record<string, unknown>) ? ui : undefined;
}

function resolveConfiguredPath(rawPath: string, baseDir: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) return join(homedir(), rawPath.slice(2));
  return isAbsolute(rawPath) ? rawPath : join(baseDir, rawPath);
}

function notifyUserScopeWrite(filePath: string): void {
  recordAttributionHint({ kind: "user" }, filePath, { type: "human" });
  scheduleCommit({ kind: "user" });
}

// ── Agent Profile CRUD ──

function readProfileFile(name: string): Profile | undefined {
  return readJson<Profile>(join(AGENTS_DIR, `${name}.json`));
}

export type ProfileResolutionContext = {
  /** Source plugin for an unqualified authored reference. */
  pluginId?: string;
};

type ProfileSource =
  | { origin: "user"; name: string }
  | { origin: "project"; name: string; cwd: string }
  | { origin: "plugin"; name: string; plugin: ModusPlugin };

function profileSourcePath(source: ProfileSource): string {
  if (source.origin === "user") return join(AGENTS_DIR, `${source.name}.json`);
  if (source.origin === "project") return join(projectAgentsDir(source.cwd), `${source.name}.json`);
  return join(getPluginProfilesDir(source.plugin), `${source.name}.json`);
}

function isSafeProfileName(name: string): boolean {
  return !!name && name !== "." && name !== ".." && !/[\\/:\0]/.test(name);
}

export function qualifiedProfileKey(
  origin: "user" | "project",
  name: string,
): string;
export function qualifiedProfileKey(
  origin: "plugin",
  name: string,
  pluginId: string,
): string;
export function qualifiedProfileKey(
  origin: "user" | "project" | "plugin",
  name: string,
  pluginId?: string,
): string {
  return origin === "plugin" ? `plugin:${pluginId}/${name}` : `${origin}:${name}`;
}

export function parseQualifiedProfileKey(
  key: string,
): { origin: "user" | "project" | "plugin"; name: string; pluginId?: string } | null {
  if (key.startsWith("user:")) {
    const name = key.slice("user:".length);
    return isSafeProfileName(name) ? { origin: "user", name } : null;
  }
  if (key.startsWith("project:")) {
    const name = key.slice("project:".length);
    return isSafeProfileName(name) ? { origin: "project", name } : null;
  }
  if (key.startsWith("plugin:")) {
    const value = key.slice("plugin:".length);
    const slash = value.indexOf("/");
    if (slash <= 0) return null;
    const pluginId = value.slice(0, slash);
    const name = value.slice(slash + 1);
    return isSafeProfileName(pluginId) && isSafeProfileName(name)
      ? { origin: "plugin", pluginId, name }
      : null;
  }
  return null;
}

function listJsonNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => basename(entry, ".json"))
    .filter(isSafeProfileName);
}

function readPluginProfile(plugin: ModusPlugin, name: string): Profile | undefined {
  if (!isSafeProfileName(name)) return undefined;
  return readJson<Profile>(join(getPluginProfilesDir(plugin), `${name}.json`));
}

function expandPluginToken(value: string, pluginPath: string): string {
  return value.replace(/\$\{pluginDir\}/g, pluginPath);
}

const reportedLegacyPermissionProfiles = new Set<string>();

function decorateProfile(profile: Profile, source: ProfileSource): Profile {
  const key = source.origin === "plugin"
    ? qualifiedProfileKey("plugin", source.name, source.plugin.id)
    : qualifiedProfileKey(source.origin, source.name);
  const normalized = normalizePermissionPolicy(profile.permissionPolicy as PermissionPolicy | undefined);
  if (normalized.normalizedLegacyAllow && !reportedLegacyPermissionProfiles.has(key)) {
    reportedLegacyPermissionProfiles.add(key);
    console.warn(`[profiles] ${key} uses deprecated permissionPolicy.default "allow"; treating it as "approve" without rewriting the file.`);
  }
  const resolvedProfile = normalized.normalizedLegacyAllow
    ? { ...profile, permissionPolicy: normalized.policy }
    : profile;
  if (source.origin !== "plugin") {
    return {
      ...resolvedProfile,
      key,
      displayName: source.name,
      origin: source.origin,
    };
  }

  const pluginPath = source.plugin.path;
  const additionalDirectories = (resolvedProfile.additionalDirectories ?? [])
    .map((entry) => expandPluginToken(entry, pluginPath));
  if (!additionalDirectories.some((entry) => resolve(entry) === resolve(pluginPath))) {
    additionalDirectories.push(pluginPath);
  }
  return {
    ...resolvedProfile,
    ...(resolvedProfile.cwd ? { cwd: expandPluginToken(resolvedProfile.cwd, pluginPath) } : {}),
    additionalDirectories,
    ...(resolvedProfile.cwdSuggestions
      ? { cwdSuggestions: resolvedProfile.cwdSuggestions.map((entry) => expandPluginToken(entry, pluginPath)) }
      : {}),
    key,
    displayName: source.name,
    origin: "plugin",
    pluginId: source.plugin.id,
    pluginName: source.plugin.name ?? source.plugin.id,
    pluginPath,
  };
}

function resolveProfileSource(
  reference: string,
  cwd?: string,
  context: ProfileResolutionContext = {},
): { profile: Profile; source: ProfileSource } | undefined {
  const qualified = parseQualifiedProfileKey(reference);
  if (qualified) {
    if (qualified.origin === "user") {
      const profile = readProfileFile(qualified.name);
      return profile ? { profile, source: { origin: "user", name: qualified.name } } : undefined;
    }
    if (qualified.origin === "project") {
      if (!cwd) return undefined;
      const profile = readJson<Profile>(join(projectAgentsDir(cwd), `${qualified.name}.json`));
      return profile ? { profile, source: { origin: "project", name: qualified.name, cwd } } : undefined;
    }
    const plugin = getModusPlugin(qualified.pluginId!);
    if (!plugin) return undefined;
    const profile = readPluginProfile(plugin, qualified.name);
    return profile ? { profile, source: { origin: "plugin", name: qualified.name, plugin } } : undefined;
  }

  if (!isSafeProfileName(reference)) return undefined;

  // An unqualified reference authored by a plugin resolves against that plugin first.
  if (context.pluginId) {
    const plugin = getModusPlugin(context.pluginId);
    const profile = plugin ? readPluginProfile(plugin, reference) : undefined;
    if (plugin && profile) {
      return { profile, source: { origin: "plugin", name: reference, plugin } };
    }
  }

  if (cwd) {
    const profile = readJson<Profile>(join(projectAgentsDir(cwd), `${reference}.json`));
    if (profile) return { profile, source: { origin: "project", name: reference, cwd } };
  }
  const userProfile = readProfileFile(reference);
  if (userProfile) return { profile: userProfile, source: { origin: "user", name: reference } };

  // Core profiles remain usable by their historic unqualified names on clean homes.
  const core = getCoreModusPlugin();
  const coreProfile = readPluginProfile(core, reference);
  return coreProfile
    ? { profile: coreProfile, source: { origin: "plugin", name: reference, plugin: core } }
    : undefined;
}

/** Read and identify an agent profile without applying UI sidecars. */
export function getProfileConfig(
  name: string,
  cwd?: string,
  context: ProfileResolutionContext = {},
): Profile | undefined {
  const resolved = resolveProfileSource(name, cwd, context);
  return resolved ? decorateProfile(resolved.profile, resolved.source) : undefined;
}

export function getProfileConfigPath(
  name: string,
  cwd?: string,
  context: ProfileResolutionContext = {},
): string | undefined {
  const resolved = resolveProfileSource(name, cwd, context);
  return resolved ? profileSourcePath(resolved.source) : undefined;
}

export function resolveProfileKey(
  name: string,
  cwd?: string,
  context: ProfileResolutionContext = {},
): string | undefined {
  return getProfileConfig(name, cwd, context)?.key;
}

export function getProfileUiConfig(
  name: string,
  cwd?: string,
  context: ProfileResolutionContext = {},
): ProfileUiConfig | undefined {
  const resolved = resolveProfileSource(name, cwd, context);
  if (!resolved) return undefined;
  const decorated = decorateProfile(resolved.profile, resolved.source);
  const sidecarPath = resolved.source.origin === "plugin"
    ? join(getPluginProfileUiDir(resolved.source.plugin), `${resolved.source.name}.json`)
    : resolved.source.origin === "project"
      ? join(projectProfileUiDir(resolved.source.cwd), `${resolved.source.name}.json`)
      : join(UI_AGENTS_DIR, `${resolved.source.name}.json`);
  return mergeProfileUi(legacyProfileUi(decorated), readJson<ProfileUiConfig>(sidecarPath));
}

/** Resolve an agent profile, including qualified plugin-local identities. */
export function getProfile(
  name: string,
  cwd?: string,
  context: ProfileResolutionContext = {},
): Profile | undefined {
  return getProfileConfig(name, cwd, context);
}

/** List collision-free profile keys. Plugin visibility is manifest-declared. */
export function listProfileNames(cwd?: string): string[] {
  const keys: string[] = [];
  if (cwd) {
    keys.push(...listJsonNames(projectAgentsDir(cwd)).map((name) => qualifiedProfileKey("project", name)));
  }
  keys.push(...listJsonNames(AGENTS_DIR).map((name) => qualifiedProfileKey("user", name)));

  const plugins = [getCoreModusPlugin(), ...listEnabledModusPlugins()];
  for (const plugin of plugins) {
    for (const name of plugin.manifest.integration?.agentProfiles ?? []) {
      if (readPluginProfile(plugin, name)) {
        keys.push(qualifiedProfileKey("plugin", name, plugin.id));
      }
    }
  }
  return Array.from(new Set(keys)).sort((a, b) => a.localeCompare(b));
}

/** Get all picker-visible profiles keyed by collision-free identity. */
export function getAllProfiles(cwd?: string): Record<string, Profile> {
  const result: Record<string, Profile> = {};
  for (const key of listProfileNames(cwd)) {
    const profile = getProfileConfig(key, cwd);
    if (profile) result[key] = profile;
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
  const qualified = parseQualifiedProfileKey(name);
  if (qualified?.origin === "plugin") throw new Error("Plugin profiles are read-only merged content");
  const bareName = qualified?.name ?? name;
  if (!isSafeProfileName(bareName) || bareName.startsWith("_")) {
    throw new Error("Invalid or reserved profile name");
  }
  const projectScoped = qualified?.origin === "project" || (!qualified && !!cwd);
  if (qualified?.origin === "project" && !cwd) throw new Error("Project profile writes require cwd");
  const dir = projectScoped ? projectAgentsDir(cwd!) : AGENTS_DIR;
  if (projectScoped && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${bareName}.json`);
  notifyUserScopeWrite(filePath);
  const { origin: _origin, key: _key, displayName: _displayName, pluginId: _pluginId,
    pluginName: _pluginName, pluginPath: _pluginPath, ...persisted } = profile;
  writeJson(filePath, persisted);
}

export function saveProfileUiConfig(name: string, ui: ProfileUiConfig, cwd?: string): void {
  const qualified = parseQualifiedProfileKey(name);
  if (qualified?.origin === "plugin") throw new Error("Plugin profile UI is read-only merged content");
  const bareName = qualified?.name ?? name;
  if (!isSafeProfileName(bareName)) throw new Error("Invalid profile name");
  const projectScoped = qualified?.origin === "project" || (!qualified && !!cwd);
  if (qualified?.origin === "project" && !cwd) throw new Error("Project profile writes require cwd");
  const filePath = projectScoped
    ? join(projectProfileUiDir(cwd!), `${bareName}.json`)
    : join(UI_AGENTS_DIR, `${bareName}.json`);
  if (projectScoped) mkdirSync(projectProfileUiDir(cwd!), { recursive: true });
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
  const qualified = parseQualifiedProfileKey(name);
  if (qualified?.origin === "plugin") return false;
  const bareName = qualified?.name ?? name;
  if (!isSafeProfileName(bareName)) return false;
  const projectScoped = qualified?.origin === "project" || (!qualified && !!cwd);
  if (qualified?.origin === "project" && !cwd) return false;
  const dir = projectScoped ? projectAgentsDir(cwd!) : AGENTS_DIR;
  const filePath = join(dir, `${bareName}.json`);
  const uiFilePath = projectScoped
    ? join(projectProfileUiDir(cwd!), `${bareName}.json`)
    : join(UI_AGENTS_DIR, `${bareName}.json`);
  const deletedCore = existsSync(filePath);
  if (deletedCore) unlinkSync(filePath);
  if (existsSync(uiFilePath)) unlinkSync(uiFilePath);
  return deletedCore;
}

// ── Global Config ──

function mergePluginSettings(
  base?: Record<string, Record<string, unknown>>,
  override?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> | undefined {
  return mergeExtensionSettings(base, override);
}

function mergeTextToSpeech(
  base?: TextToSpeechConfig,
  override?: TextToSpeechConfig,
): TextToSpeechConfig | undefined {
  if (!base && !override) return undefined;
  return {
    ...base,
    ...override,
    voiceAliases: { ...base?.voiceAliases, ...override?.voiceAliases },
    providers: { ...base?.providers, ...override?.providers },
  };
}

function mergeGlobalConfig(base: GlobalConfig, override: GlobalConfig): GlobalConfig {
  return {
    ...base,
    ...override,
    mcpServers: { ...base.mcpServers, ...override.mcpServers },
    providerDefaults: { ...base.providerDefaults, ...override.providerDefaults },
    notificationChannels: { ...base.notificationChannels, ...override.notificationChannels },
    clientExtensions: mergeClientExtensions(base.clientExtensions, override.clientExtensions),
    pluginSettings: mergePluginSettings(base.pluginSettings, override.pluginSettings),
    textToSpeech: mergeTextToSpeech(base.textToSpeech, override.textToSpeech),
  };
}

/** Read one writable global-config file without composing other tiers. */
export function getStoredGlobalConfig(cwd?: string): GlobalConfig {
  return readJson<GlobalConfig>(cwd ? projectGlobalPath(cwd) : homeGlobalPath()) ?? {};
}

export function getGlobalConfigLayers(cwd?: string): Array<{ path?: string; config: GlobalConfig }> {
  const layers: Array<{ path?: string; config: GlobalConfig }> = [
    { config: { mcpServers: getBuiltInMcpServers() } },
    { path: homeGlobalPath(), config: getStoredGlobalConfig() },
  ];
  for (const plugin of listEnabledModusPlugins()) {
    const filePath = getPluginGlobalConfigPath(plugin);
    const config = readJson<GlobalConfig>(filePath);
    if (config) layers.push({ path: filePath, config });
  }
  if (cwd) layers.push({ path: projectGlobalPath(cwd), config: getStoredGlobalConfig(cwd) });
  return layers;
}

/** Compose built-in → user base → enabled plugins → project. */
export function getGlobalConfig(cwd?: string): GlobalConfig {
  const base = getStoredGlobalConfig();
  const builtInMcpServers = getBuiltInMcpServers();
  let merged: GlobalConfig = {
    ...base,
    mcpServers: { ...builtInMcpServers, ...base.mcpServers },
  };
  for (const plugin of listEnabledModusPlugins()) {
    const pluginConfig = readJson<GlobalConfig>(getPluginGlobalConfigPath(plugin));
    if (pluginConfig) merged = mergeGlobalConfig(merged, pluginConfig);
  }
  if (cwd) {
    const projectConfig = getStoredGlobalConfig(cwd);
    merged = mergeGlobalConfig(merged, projectConfig);
  }
  return merged;
}

export function getResolvedClientExtensionsConfig(cwd?: string, userProfileName?: string): ClientExtensionsConfig {
  const baseFile = homeGlobalPath();
  const baseConfig = readJson<GlobalConfig>(baseFile);
  const withResolvedPaths = (
    config: ClientExtensionsConfig | undefined,
    baseDir: string,
  ): ClientExtensionsConfig | undefined => config ? {
    ...config,
    paths: config.paths?.map((entry) => resolveConfiguredPath(entry, baseDir)),
  } : undefined;
  let merged = withResolvedPaths(baseConfig?.clientExtensions, dirname(baseFile));

  for (const plugin of listEnabledModusPlugins()) {
    const pluginGlobalPath = getPluginGlobalConfigPath(plugin);
    const pluginClient = readJson<GlobalConfig>(pluginGlobalPath)?.clientExtensions;
    merged = mergeClientExtensions(
      merged,
      withResolvedPaths(pluginClient, dirname(pluginGlobalPath)),
    );
  }

  const projectFile = cwd ? projectGlobalPath(cwd) : undefined;
  const projectClient = projectFile ? readJson<GlobalConfig>(projectFile)?.clientExtensions : undefined;
  const userClient = userProfileName ? getUserProfileUiConfig(userProfileName)?.clientExtensions : undefined;

  merged = mergeClientExtensions(
    mergeClientExtensions(
      merged,
      projectFile ? withResolvedPaths(projectClient, dirname(projectFile)) : projectClient,
    ),
    userClient,
  );

  return {
    paths: merged?.paths,
    enabled: merged?.enabled,
    disabled: merged?.disabled,
    settings: merged?.settings,
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
// Runtime UI state — lives in <current-home>/profiles/state/, app-managed.

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
// Stored at <current-home>/profiles/_users.json. Flat key-value object for user info
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
// Stored at <current-home>/projects.json. Maps project IDs to names + paths.
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
