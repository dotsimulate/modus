import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { homedir } from "os";
import { homePluginsJsonPath } from "./modus-home";
import { APP_PATHS } from "./app-paths";
import { isPluginAllowed } from "./vault-policy";
import type { PluginSettingDefinition } from "./settings-schema";

const MODUS_DIR = ".modus";
const PLUGIN_MANIFEST = "plugin.json";

export type ModusPluginRegistration = {
  id: string;
  path: string;
  enabled?: boolean;
  name?: string;
  /** Machine-wide values for manifest fields whose scope is "global". */
  settings?: Record<string, unknown>;
};

// Declared once in settings-schema.ts alongside the client-extension shapes, so
// the manifest contract an author writes and the types the SDK publishes cannot
// drift apart. Re-exported here because this module owns plugin manifests.
export { type PluginSettingDefinition, type PluginSettingScope } from "./settings-schema";

export type ModusPluginManifest = {
  id?: string;
  name?: string;
  description?: string;
  /** Relative path to a human-readable about/authority disclosure document. */
  about?: string;
  settings?: PluginSettingDefinition[];
  integration?: {
    /** Profiles exposed in pickers. Other shipped profiles remain resolvable. */
    agentProfiles?: string[];
    pages?: string[];
    lenses?: string[];
    projections?: string[];
    pageNav?: "auto" | "hidden";
  };
  contents?: Partial<Record<"moves" | "actions" | "pages" | "profiles" | "providers" | "skills" | "lenses" | "projections", {
    mode?: "merge";
  }>>;
};

export type ModusPlugin = {
  id: string;
  path: string;
  enabled: boolean;
  name?: string;
  description?: string;
  about?: string;
  /** Built-in plugins are inspectable but cannot be unregistered. */
  builtin?: boolean;
  removable?: boolean;
  settings?: Record<string, unknown>;
  manifest: ModusPluginManifest;
};

type PluginsFile = {
  plugins?: ModusPluginRegistration[];
};

function normalizeId(input: string): string {
  const id = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error(`invalid plugin id: ${input}`);
  return id;
}

function expandPath(rawPath: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) return join(homedir(), rawPath.slice(2));
  return rawPath;
}

function resolvePluginPath(rawPath: string): string {
  return resolve(expandPath(rawPath));
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function readPluginManifest(pluginPath: string): ModusPluginManifest {
  return readJson<ModusPluginManifest>(join(pluginPath, MODUS_DIR, PLUGIN_MANIFEST)) ?? {};
}

function readAbout(pluginPath: string, manifest: ModusPluginManifest, builtin = false): string | undefined {
  const candidates = [
    ...(manifest.about ? [manifest.about] : []),
    builtin ? "ABOUT.md" : join(MODUS_DIR, "ABOUT.md"),
    "ABOUT.md",
  ];
  for (const candidate of candidates) {
    if (isAbsolute(candidate)) continue;
    const absolute = resolve(pluginPath, candidate);
    const rel = relative(pluginPath, absolute);
    if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(absolute)) continue;
    try {
      return readFileSync(absolute, "utf-8");
    } catch {
      // Try the next conventional location.
    }
  }
  return undefined;
}

function toPlugin(registration: ModusPluginRegistration): ModusPlugin {
  const pluginPath = resolvePluginPath(registration.path);
  const manifest = readPluginManifest(pluginPath);
  const id = normalizeId(registration.id || manifest.id || basename(pluginPath));
  return {
    id,
    path: pluginPath,
    enabled: registration.enabled !== false,
    name: registration.name ?? manifest.name,
    description: manifest.description,
    about: readAbout(pluginPath, manifest),
    removable: true,
    settings: registration.settings,
    manifest,
  };
}

export const CORE_PLUGIN_ID = "modus-core";

export function getCoreModusPlugin(): ModusPlugin {
  const pluginPath = APP_PATHS.resourcesDir;
  const manifest = readJson<ModusPluginManifest>(join(pluginPath, PLUGIN_MANIFEST)) ?? {
    id: CORE_PLUGIN_ID,
    name: "Modus Core",
    description: "Built-in moves, actions, pages, prompts, and starter content.",
  };
  return {
    id: CORE_PLUGIN_ID,
    path: pluginPath,
    enabled: true,
    name: manifest.name ?? "Modus Core",
    description: manifest.description,
    about: readAbout(pluginPath, manifest, true),
    builtin: true,
    removable: false,
    manifest,
  };
}

export function listPluginRegistrations(): ModusPluginRegistration[] {
  return readJson<PluginsFile>(homePluginsJsonPath())?.plugins ?? [];
}

export function savePluginRegistrations(plugins: ModusPluginRegistration[]): void {
  writeJson(homePluginsJsonPath(), { plugins });
}

export function listModusPlugins(): ModusPlugin[] {
  return [getCoreModusPlugin(), ...listPluginRegistrations().map(toPlugin)];
}

/** Enabled user-registered plugins. The built-in core tier has dedicated loaders. */
export function listEnabledModusPlugins(): ModusPlugin[] {
  return listPluginRegistrations()
    .map(toPlugin)
    .filter((plugin) => plugin.enabled && isPluginAllowed(plugin.id));
}

export function getModusPlugin(id: string, opts: { includeDisabled?: boolean } = {}): ModusPlugin | null {
  const normalizedId = normalizeId(id);
  if (normalizedId === CORE_PLUGIN_ID) return getCoreModusPlugin();
  const plugin = listPluginRegistrations()
    .map(toPlugin)
    .find((entry) => entry.id === normalizedId);
  if (!plugin || (!opts.includeDisabled && (!plugin.enabled || !isPluginAllowed(plugin.id)))) return null;
  return plugin;
}

export function registerModusPlugin(
  rawPath: string,
  opts: { id?: string; name?: string; enabled?: boolean } = {},
): ModusPlugin {
  const pluginPath = resolvePluginPath(rawPath);
  if (!existsSync(pluginPath)) throw new Error(`plugin path does not exist: ${pluginPath}`);
  if (!existsSync(join(pluginPath, MODUS_DIR))) throw new Error(`plugin path has no .modus directory: ${pluginPath}`);
  const manifest = readPluginManifest(pluginPath);
  const id = normalizeId(opts.id ?? manifest.id ?? basename(pluginPath));
  if (id === CORE_PLUGIN_ID) throw new Error(`plugin id "${CORE_PLUGIN_ID}" is reserved`);
  const registration: ModusPluginRegistration = {
    id,
    path: pluginPath,
    enabled: opts.enabled ?? true,
    ...(opts.name ?? manifest.name ? { name: opts.name ?? manifest.name } : {}),
  };

  const plugins = listPluginRegistrations();
  const existingIndex = plugins.findIndex((plugin) => normalizeId(plugin.id) === id);
  if (existingIndex === -1) {
    plugins.push(registration);
  } else {
    plugins[existingIndex] = { ...plugins[existingIndex], ...registration };
  }
  savePluginRegistrations(plugins);
  return toPlugin(registration);
}

export function patchModusPlugin(id: string, patch: { enabled?: boolean; path?: string; name?: string }): ModusPlugin | null {
  const normalizedId = normalizeId(id);
  if (normalizedId === CORE_PLUGIN_ID) return null;
  const plugins = listPluginRegistrations();
  const index = plugins.findIndex((plugin) => normalizeId(plugin.id) === normalizedId);
  if (index === -1) return null;

  const current = plugins[index]!;
  const next: ModusPluginRegistration = {
    ...current,
    ...(patch.path ? { path: resolvePluginPath(patch.path) } : {}),
    ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
    ...(typeof patch.name === "string" ? { name: patch.name } : {}),
  };
  plugins[index] = next;
  savePluginRegistrations(plugins);
  return toPlugin(next);
}

export function patchModusPluginSettings(id: string, values: Record<string, unknown>): ModusPlugin | null {
  const normalizedId = normalizeId(id);
  if (normalizedId === CORE_PLUGIN_ID) return null;
  const plugins = listPluginRegistrations();
  const index = plugins.findIndex((plugin) => normalizeId(plugin.id) === normalizedId);
  if (index === -1) return null;
  const current = plugins[index]!;
  plugins[index] = {
    ...current,
    settings: { ...(current.settings ?? {}), ...values },
  };
  savePluginRegistrations(plugins);
  return toPlugin(plugins[index]!);
}

export function unregisterModusPlugin(id: string): boolean {
  const normalizedId = normalizeId(id);
  if (normalizedId === CORE_PLUGIN_ID) return false;
  const plugins = listPluginRegistrations();
  const next = plugins.filter((plugin) => normalizeId(plugin.id) !== normalizedId);
  if (next.length === plugins.length) return false;
  savePluginRegistrations(next);
  return true;
}

export function getPluginClientExtensionsDir(plugin: ModusPlugin): string {
  return join(plugin.path, MODUS_DIR, "ui", "extensions");
}

export function getPluginModusDir(plugin: ModusPlugin): string {
  return join(plugin.path, MODUS_DIR);
}

export function getPluginActionsDir(plugin: ModusPlugin): string {
  return join(getPluginModusDir(plugin), "actions");
}

export function getPluginMovesDir(plugin: ModusPlugin): string {
  return join(getPluginModusDir(plugin), "moves");
}

export function getPluginPagesDir(plugin: ModusPlugin): string {
  return join(getPluginModusDir(plugin), "pages");
}

export function getPluginLensesDir(plugin: ModusPlugin): string {
  return join(getPluginModusDir(plugin), "lenses");
}

export function getPluginProjectionsDir(plugin: ModusPlugin): string {
  return join(getPluginModusDir(plugin), "projections");
}

export function getPluginProvidersDir(plugin: ModusPlugin): string {
  return join(getPluginModusDir(plugin), "providers");
}

export function getPluginSkillsDir(plugin: ModusPlugin): string {
  return join(getPluginModusDir(plugin), "skills");
}

export function getPluginProfilesDir(plugin: ModusPlugin): string {
  if (plugin.builtin) return join(plugin.path, "templates", "profiles", "agents");
  return join(getPluginModusDir(plugin), "profiles", "agents");
}

export function getPluginProfileUiDir(plugin: ModusPlugin): string {
  if (plugin.builtin) return join(plugin.path, "templates", "profiles", "ui", "agents");
  return join(getPluginModusDir(plugin), "ui", "profiles", "agents");
}

export function getPluginGlobalConfigPath(plugin: ModusPlugin): string {
  return join(getPluginModusDir(plugin), "_global.json");
}
