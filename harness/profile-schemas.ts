/**
 * Zod schemas for profile validation.
 * Mirrors the TypeScript types in profiles.ts — enforced at runtime on API writes.
 */

import { z } from "zod";
// Leaf module on purpose: importing ./providers/registry here would pull every
// provider implementation and the database into anything that only wants to
// validate a profile.
import { isKnownProvider } from "./providers/provider-names";

// ── MCP Server Config ──

const McpStdioSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const McpSseSchema = z.object({
  type: z.literal("sse"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpHttpSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpServerConfigSchema = z.union([McpStdioSchema, McpSseSchema, McpHttpSchema]);

// ── Permission Policy ──

const PermissionPolicyObjectSchema = z.object({
  // "allow" was emitted by early hand-authored profiles. Resolution normalizes
  // it to "approve" without rewriting the source file.
  default: z.enum(["approve", "ask", "allow"]),
  autoApprove: z.array(z.string()).optional(),
  requireApproval: z.array(z.string()).optional(),
});

export const PermissionPolicySchema = z.union([
  z.literal("bypass"),
  z.literal("auto-edit"),
  z.literal("ask"),
  PermissionPolicyObjectSchema,
]);

// ── Profile UI ──

export const ProfileUiSchema = z.object({
  label: z.string().optional(),
  showThinking: z.boolean().optional(),
  showMeta: z.boolean().optional(),
  showToolCalls: z.boolean().optional(),
  showGitEvents: z.boolean().optional(),
  placeholder: z.string().optional(),
  emptyTitle: z.string().optional(),
  emptySubtitle: z.string().optional(),
  panelWidgets: z.array(z.string()).optional(),
});

// ── CLAUDE.md Excludes ──

const ClaudeMdRuleSchema = z.enum(["no-parent-walk", "no-node-modules"]);

const ClaudeMdExcludesObjectSchema = z.object({
  rules: z.array(ClaudeMdRuleSchema).optional(),
  custom: z.array(z.string()).optional(),
});

const ClaudeMdExcludesSchema = z.union([
  z.array(z.string()),
  ClaudeMdExcludesObjectSchema,
]);

// ── Compaction Config ──

const CompactionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  reserveTokens: z.number().int().positive().optional(),
  keepRecentTokens: z.number().int().positive().optional(),
});

// ── Provider Defaults ──

const ProviderDefaultsSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  compaction: CompactionConfigSchema.optional(),
});

export const ClientExtensionsSchema = z.object({
  paths: z.array(z.string()).optional(),
  enabled: z.array(z.string()).optional(),
  disabled: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

const TextToSpeechProviderIdSchema = z.enum(["kokoro", "zonos2", "neutts", "elevenlabs"]);
const TextToSpeechAudioFormatSchema = z.enum(["wav", "mp3", "pcm"]);

const TextToSpeechProviderConfigSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  outputFormat: z.string().optional(),
  stability: z.number().optional(),
  similarityBoost: z.number().optional(),
  style: z.number().optional(),
});

const TextToSpeechConfigSchema = z.object({
  enabled: z.boolean().optional(),
  defaultProvider: TextToSpeechProviderIdSchema.optional(),
  defaultVoice: z.string().optional(),
  defaultFormat: TextToSpeechAudioFormatSchema.optional(),
  voiceAliases: z.record(z.string(), z.string()).optional(),
  providers: z.object({
    kokoro: TextToSpeechProviderConfigSchema.optional(),
    zonos2: TextToSpeechProviderConfigSchema.optional(),
    neutts: TextToSpeechProviderConfigSchema.optional(),
    elevenlabs: TextToSpeechProviderConfigSchema.optional(),
  }).optional(),
});

const DashboardConfigSchema = z.object({
  widgets: z.array(z.record(z.string(), z.unknown())).optional(),
  pages: z.array(z.record(z.string(), z.unknown())).optional(),
});

const LeftPanelConfigSchema = z.object({
  widgets: z.array(z.string()).optional(),
});

const PageNavConfigSchema = z.object({
  mode: z.enum(["auto", "compact", "tabs", "launcher"]).optional(),
  enabled: z.array(z.string()).optional(),
  disabled: z.array(z.string()).optional(),
  pinned: z.array(z.string()).optional(),
  order: z.array(z.string()).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

const PanelWidgetSchema = z.union([
  z.string(),
  z.object({
    id: z.string().optional(),
    type: z.string(),
    title: z.string().optional(),
    size: z.enum(["full", "half", "third"]).optional(),
    collapsed: z.boolean().optional(),
  }).catchall(z.unknown()),
]);

const PanelLayoutSchema = z.object({
  mode: z.enum(["list", "tabs"]).optional(),
  widgets: z.array(PanelWidgetSchema).optional(),
});

const LayoutsConfigSchema = z.record(z.string(), z.object({
  left: PanelLayoutSchema.optional(),
  right: PanelLayoutSchema.optional(),
}));

const UserInterfaceConfigSchema = z.object({
  chat: z.object({
    fontScale: z.number().min(75).max(175).optional(),
    chatWidth: z.number().min(500).max(1600).optional(),
    scrollIndicator: z.enum(["scroll", "spine", "ruler"]).optional(),
    // Deprecated by scrollIndicator. Still accepted so an older profile round
    // trips instead of being stripped on the next save.
    spineEnabled: z.boolean().optional(),
  }).optional(),
  conversation: z.object({
    showThinking: z.boolean().optional(),
    showMeta: z.boolean().optional(),
    toolCalls: z.enum(["expanded", "collapsed", "hidden"]).optional(),
    showGitEvents: z.boolean().optional(),
    showFileChanges: z.boolean().optional(),
    deferHeavyDetails: z.boolean().optional(),
  }).optional(),
  // Item ids are validated in the client against its own catalog, so a config
  // written for a newer build stays loadable here instead of failing the whole
  // profile.
  configBar: z.object({
    items: z.array(z.string()).optional(),
  }).optional(),
  motion: z.enum(["system", "reduced"]).optional(),
});

const ProviderSchema = z.string().refine(isKnownProvider, {
  message: "unknown provider",
});

const EffortSchema = z.enum(["off", "low", "medium", "high", "xhigh", "max"]);

const ProviderControlsSchema = z.object({
  codex: z.object({
    sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    webSearchMode: z.enum(["disabled", "cached", "live"]).optional(),
    serviceTier: z.enum(["standard", "fast", "priority"]).optional(),
  }).optional(),
  claude: z.object({
    permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]).optional(),
  }).optional(),
  antigravity: z.object({
    mode: z.enum(["accept-edits", "plan"]).optional(),
    sandbox: z.boolean().optional(),
    printTimeout: z.string().min(1).optional(),
  }).optional(),
  grokBuild: z.object({
    mode: z.enum(["default", "auto", "plan", "always-approve"]).optional(),
    sandbox: z.string().min(1).optional(),
    noMemory: z.boolean().optional(),
    noSubagents: z.boolean().optional(),
    disableWebSearch: z.boolean().optional(),
  }).optional(),
}).catchall(z.unknown());

// ── Agent Profile ──

export const ProfileSchema = z.object({
  prompt: z.string(),
  description: z.string(),
  cwd: z.string().optional(),
  additionalDirectories: z.array(z.string()).optional(),
  provider: ProviderSchema.optional(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  effort: EffortSchema.optional(),
  loadProjectSettings: z.boolean().optional(),
  claudeMdExcludes: ClaudeMdExcludesSchema.optional(),
  promptMode: z.enum(["custom", "append"]).optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  mcpConfig: z.string().min(1).optional(),
  permissionPolicy: PermissionPolicySchema.optional(),
  providerControls: ProviderControlsSchema.optional(),
  ui: ProfileUiSchema.optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  compaction: CompactionConfigSchema.optional(),
  maxBudgetUsd: z.number().positive().optional(),
  env: z.record(z.string(), z.string()).optional(),
  plugins: z.array(z.object({ type: z.literal("local"), path: z.string() })).optional(),
  sandbox: z.object({
    enabled: z.boolean().optional(),
    autoAllowBashIfSandboxed: z.boolean().optional(),
    allowUnsandboxedCommands: z.boolean().optional(),
    network: z.object({
      allowedDomains: z.array(z.string()).optional(),
      allowManagedDomainsOnly: z.boolean().optional(),
      allowUnixSockets: z.array(z.string()).optional(),
      allowAllUnixSockets: z.boolean().optional(),
      allowLocalBinding: z.boolean().optional(),
    }).optional(),
  }).optional(),
  codexSandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  codexRules: z.array(z.string()).optional(),
  cwdSuggestions: z.array(z.string()).optional(),
  moves: z.array(z.object({
    name: z.string(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    ask: z.boolean().optional(),
  })).optional(),
  skills: z.array(z.string()).optional(),
});

export const ProfileCoreSchema = ProfileSchema.omit({ ui: true });

// ── User Profile ──

const UserProfileMemorySchema = z.object({
  scope: z.enum(["global", "profile"]),
  inheritGlobal: z.boolean().optional(),
});

export const UserProfileSchema = z.object({
  displayName: z.string(),
  templateVars: z.record(z.string(), z.string()).optional(),
  projects: z.array(z.string()),
  agentProfiles: z.array(z.string()).optional(),
  hiddenPluginProfiles: z.array(z.string()).optional(),
  defaultAgentProfile: z.string().optional(),
  provider: ProviderSchema.optional(),
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  memoryFilter: z.string().optional(),
  memory: UserProfileMemorySchema.optional(),
  showAllProjectPaths: z.boolean().optional(),
  dashboard: DashboardConfigSchema.optional(),
  leftPanel: LeftPanelConfigSchema.optional(),
  computer: z.string().optional(),
  editor: z.string().optional(),
  interface: UserInterfaceConfigSchema.optional(),
  clientExtensions: ClientExtensionsSchema.optional(),
});

export const UserProfileUiConfigSchema = z.object({
  dashboard: DashboardConfigSchema.optional(),
  leftPanel: LeftPanelConfigSchema.optional(),
  pageNav: PageNavConfigSchema.optional(),
  layouts: LayoutsConfigSchema.optional(),
  computer: z.string().optional(),
  editor: z.string().optional(),
  interface: UserInterfaceConfigSchema.optional(),
  clientExtensions: ClientExtensionsSchema.optional(),
});

export const UserProfileCoreSchema = UserProfileSchema.omit({
  dashboard: true,
  leftPanel: true,
  computer: true,
  editor: true,
  interface: true,
  clientExtensions: true,
});

// ── Global Config ──

export const GlobalConfigSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  mcpConfig: z.string().min(1).optional(),
  permissionNotificationChannels: z.array(z.string().min(1)).optional(),
  providerDefaults: z.record(z.string(), ProviderDefaultsSchema).optional(),
  notificationChannels: z.record(z.string(), z.union([
    z.object({
      type: z.literal("webhook"),
      url: z.string(),
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      bodyTemplate: z.string().optional(),
      contentField: z.string().optional(),
    }),
    z.object({
      type: z.literal("file"),
      path: z.string(),
    }),
  ])).optional(),
  clientExtensions: ClientExtensionsSchema.optional(),
  pluginSettings: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  textToSpeech: TextToSpeechConfigSchema.optional(),
});

// ── Helpers ──

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/** Validate data against a schema, returning ok or error strings.
 *  On success the original data is used as-is (caller keeps their type). */
export function validate(schema: z.ZodType, data: unknown): ValidationResult {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true };
  const errors = result.error.issues.map(
    (i) => `${i.path.join(".")}: ${i.message}`
  );
  return { ok: false, errors };
}
