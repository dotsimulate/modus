import { existsSync, readdirSync } from "fs";
import { basename, extname, join, resolve } from "path";
import { getResolvedClientExtensionsConfig } from "./profiles";

const PROJECT_EXTENSIONS_DIR = ".modus/ui/extensions";
const BUILTIN_EXTENSIONS_DIR = join(import.meta.dir, "ui/extensions");
const EXTENSION_EXTENSIONS = new Set([".js", ".mjs"]);

export type ClientExtensionInfo = {
  id: string;
  fileName: string;
  absolutePath: string;
  source: "project" | "global";
  enabled: boolean;
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

function listExtensionFiles(root: string, source: "project" | "global"): ClientExtensionInfo[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => EXTENSION_EXTENSIONS.has(extname(entry).toLowerCase()))
    .map((entry) => ({
      id: normalizeId(entry),
      fileName: entry,
      absolutePath: resolve(root, entry),
      source,
      enabled: source === "project",
    }));
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

  // Built-in harness extensions — always enabled, not configurable
  for (const extension of listExtensionFiles(BUILTIN_EXTENSIONS_DIR, "project")) {
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
