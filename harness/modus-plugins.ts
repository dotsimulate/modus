import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";
import { homePluginsJsonPath } from "./modus-home";

const MODUS_DIR = ".modus";
const PLUGIN_MANIFEST = "plugin.json";

export type ModusPluginRegistration = {
  id: string;
  path: string;
  enabled?: boolean;
  name?: string;
};

export type ModusPluginManifest = {
  id?: string;
  name?: string;
  description?: string;
};

export type ModusPlugin = {
  id: string;
  path: string;
  enabled: boolean;
  name?: string;
  description?: string;
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
  return listPluginRegistrations().map(toPlugin);
}

export function listEnabledModusPlugins(): ModusPlugin[] {
  return listModusPlugins().filter((plugin) => plugin.enabled);
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

export function unregisterModusPlugin(id: string): boolean {
  const normalizedId = normalizeId(id);
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
