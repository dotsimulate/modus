/**
 * Current-Vault and plugin provider-definition discovery.
 *
 * Built-ins win over disk, Vault definitions win over plugins, and malformed
 * siblings never suppress valid definitions. The module stays free of profiles,
 * secrets, the provider registry, and the database so profile validation can
 * import it safely.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { MODUS_HOME } from "../modus-home";
import {
  getPluginProvidersDir,
  listEnabledModusPlugins,
} from "../modus-plugins";
import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  ProviderDefinitionSchema,
  isBuiltInProviderName,
  resolveProviderAlias,
  type ProviderDefinition,
} from "./provider-definition";

export type ProviderDefinitionRoot = {
  dir: string;
  origin: "user" | "plugin";
  pluginId?: string;
};

export function homeProvidersDir(): string {
  return join(MODUS_HOME, "providers");
}

/** Search roots ordered by precedence: user first, then enabled plugins. */
export function providerDefinitionRoots(): ProviderDefinitionRoot[] {
  const roots: ProviderDefinitionRoot[] = [
    { dir: homeProvidersDir(), origin: "user" },
  ];
  for (const plugin of listEnabledModusPlugins()) {
    roots.push({
      dir: getPluginProvidersDir(plugin),
      origin: "plugin",
      pluginId: plugin.id,
    });
  }
  return roots;
}

function describeRoot(root: ProviderDefinitionRoot): string {
  return root.origin === "plugin" ? `plugin "${root.pluginId}"` : "user home";
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => join(dir, entry.name))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.warn(`[providers] Could not read definitions from ${dir}: ${error}`);
    return [];
  }
}

function readDefinition(filePath: string): ProviderDefinition | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    console.warn(`[providers] Skipping malformed definition ${filePath}: ${error}`);
    return null;
  }

  const parsed = ProviderDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    console.warn(`[providers] Skipping invalid definition ${filePath}: ${detail}`);
    return null;
  }
  return parsed.data;
}

/**
 * Read every definition from disk, fresh, on every call.
 *
 * Deliberately uncached, matching every other authored-content loader in the
 * harness — profiles, `getGlobalConfig`, pages, actions, skills, plugins, and
 * `move.json` all re-read from disk per call. A cache here would make provider
 * definitions the only `.modus/` primitive that needs an app restart to pick up
 * an edit, which is precisely the property that makes the rest of the layer
 * worth having.
 *
 * Measured on Windows before removing the cache: 22.7us with no user
 * definitions, 56.6us with one, 102.8us with three, 260.8us with ten. For
 * comparison `getGlobalConfig()` — which enumerates plugins and merges several
 * JSON files uncached on *every provider spawn* — costs 11.6us. A realistic
 * install pays ~0.1ms per call, and the callers (profile validation,
 * `/api/providers`, capability listing, health) are not hot loops. Do not
 * reintroduce a cache without a measurement showing one is needed.
 */
export function loadProviderDefinitions(): ProviderDefinition[] {
  const winners = new Map<string, { definition: ProviderDefinition; source: string }>();
  for (const definition of BUILT_IN_PROVIDER_DEFINITIONS) {
    winners.set(definition.name, { definition, source: "built-in" });
  }

  for (const root of providerDefinitionRoots()) {
    for (const filePath of listJsonFiles(root.dir)) {
      const definition = readDefinition(filePath);
      if (!definition) continue;

      const canonical = resolveProviderAlias(definition.name);
      if (isBuiltInProviderName(definition.name)) {
        console.warn(
          `[providers] Ignoring "${definition.name}" from ${describeRoot(root)}: built-in provider names and aliases cannot be shadowed`,
        );
        continue;
      }

      const existing = winners.get(canonical);
      if (existing) {
        console.warn(
          `[providers] Ignoring "${definition.name}" from ${describeRoot(root)}: ${existing.source} definition wins`,
        );
        continue;
      }
      winners.set(canonical, {
        definition,
        source: describeRoot(root),
      });
    }
  }

  return Array.from(winners.values()).map((entry) => entry.definition);
}

export function listProviderDefinitions(): ProviderDefinition[] {
  return loadProviderDefinitions();
}

export function getProviderDefinition(name: string): ProviderDefinition | undefined {
  const canonical = resolveProviderAlias(name);
  return loadProviderDefinitions().find((definition) => definition.name === canonical);
}
