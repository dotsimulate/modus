import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, extname, join, resolve } from "path";
import { APP_PATHS } from "./app-paths";
import { getResolvedClientExtensionsConfig } from "./profiles";
import { getPluginClientExtensionsDir, listEnabledModusPlugins } from "./modus-plugins";
import { extensionSettingScope, type ExtensionMeta, type ExtensionSettingSchema } from "./settings-schema";

const PROJECT_EXTENSIONS_DIR = ".modus/ui/extensions";
const BUILTIN_EXTENSIONS_DIR = join(APP_PATHS.resourcesDir, "ui/extensions");
const EXTENSION_EXTENSIONS = new Set([".js", ".mjs"]);

// Declared once in settings-schema.ts so backend discovery, the SDK's authoring
// types, and the settings renderer cannot drift apart. Re-exported here because
// this module is where callers already look for them.
export {
  extensionSettingScope,
  type ExtensionMeta,
  type ExtensionSettingSchema,
  type ExtensionSettingScope,
  type ExtensionSettingType,
} from "./settings-schema";

export type ClientExtensionSource = "builtin" | "plugin" | "global" | "project";

export type ClientExtensionInfo = {
  id: string;
  fileName: string;
  absolutePath: string;
  source: ClientExtensionSource;
  pluginId?: string;
  pluginPath?: string;
  enabled: boolean;
  meta: ExtensionMeta;
};

function normalizeId(fileName: string): string {
  const id = basename(fileName, extname(fileName))
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error(`invalid extension filename: ${fileName}`);
  return id;
}

function readExtensionMeta(jsPath: string): ExtensionMeta {
  const dir = join(jsPath, "..");
  const stem = basename(jsPath, extname(jsPath));
  const metaPath = join(dir, `${stem}.extension.json`);
  if (!existsSync(metaPath)) return {};
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as ExtensionMeta;
  } catch {
    return {};
  }
}

function defaultEnabled(source: ClientExtensionSource): boolean {
  return source === "builtin" || source === "plugin" || source === "project";
}

function listExtensionFiles(
  root: string,
  source: ClientExtensionSource,
  context: { pluginId?: string; pluginPath?: string } = {},
): ClientExtensionInfo[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => EXTENSION_EXTENSIONS.has(extname(entry).toLowerCase()))
    .map((entry) => {
      const absolutePath = resolve(root, entry);
      return {
        id: normalizeId(entry),
        fileName: entry,
        absolutePath,
        source,
        ...context,
        enabled: defaultEnabled(source),
        meta: readExtensionMeta(absolutePath),
      };
    });
}

export function getProjectClientExtensionsDir(cwd: string): string {
  return join(cwd, PROJECT_EXTENSIONS_DIR);
}

export function listClientExtensions(opts?: {
  cwd?: string;
  userProfile?: string;
}): ClientExtensionInfo[] {
  const cwd = opts?.cwd;
  const config = getResolvedClientExtensionsConfig(cwd, opts?.userProfile);
  const enabledIds = new Set(config.enabled ?? []);
  const disabledIds = new Set(config.disabled ?? []);

  const discovered = new Map<string, ClientExtensionInfo>();

  // Built-in harness extensions ship with the executable and are enabled unless disabled.
  for (const extension of listExtensionFiles(BUILTIN_EXTENSIONS_DIR, "builtin")) {
    discovered.set(extension.id, extension);
  }

  for (const root of config.paths ?? []) {
    for (const extension of listExtensionFiles(root, "global")) {
      discovered.set(extension.id, {
        ...extension,
        enabled: enabledIds.has(extension.id),
      });
    }
  }

  // Registered plugins mount Modus resources from arbitrary user-trusted paths.
  for (const plugin of listEnabledModusPlugins()) {
    for (const extension of listExtensionFiles(getPluginClientExtensionsDir(plugin), "plugin", {
      pluginId: plugin.id,
      pluginPath: plugin.path,
    })) {
      discovered.set(extension.id, extension);
    }
  }

  if (cwd) {
    for (const extension of listExtensionFiles(getProjectClientExtensionsDir(cwd), "project")) {
      discovered.set(extension.id, {
        ...extension,
        enabled: true,
      });
    }
  }

  const result = Array.from(discovered.values())
    .map((extension) => ({
      ...extension,
      enabled: extension.enabled && !disabledIds.has(extension.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return result;
}

export function getClientExtensionById(
  id: string,
  opts?: { cwd?: string; userProfile?: string },
): ClientExtensionInfo | null {
  return listClientExtensions(opts).find((entry) => entry.id === id) ?? null;
}

/** Resolve settings: schema defaults ← stored overrides.
 *
 *  `userValues` is the fully merged map, whose last and winning layer is the
 *  caller's user profile. `sharedValues` is the same map resolved without that
 *  layer. Global-scoped keys read the shared map so every client agrees on
 *  them, falling back to the merged map for installs that stored the value in a
 *  profile before the setting declared a scope. */
export function resolveExtensionSettings(
  schema: Record<string, ExtensionSettingSchema> | undefined,
  userValues: Record<string, unknown> | undefined,
  sharedValues?: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema) return {};
  const result: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema)) {
    const stored = extensionSettingScope(def) === "global"
      ? sharedValues?.[key] ?? userValues?.[key]
      : userValues?.[key];
    result[key] = stored ?? def.default ?? null;
  }
  return result;
}
