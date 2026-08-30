/**
 * Scoped settings for Modus plugins.
 *
 * Storage follows the existing ownership boundaries:
 *   user    → user-profile UI client-extension settings
 *   project → <cwd>/.modus/_global.json
 *   Vault   → <current-home>/plugins.json registration
 *
 * The built-in `modus-core` tier is the one exception. It is synthesized rather
 * than registered (see getCoreModusPlugin), so it has no `plugins.json` row to
 * hold Vault-scoped values. Its global settings live in the Vault's own
 * `_global.json` under `pluginSettings["modus-core"]` instead — the same field
 * project scope already uses, one layer up. That keeps core settings per-Vault
 * without inventing a file or a schema for a single plugin.
 */

import {
  CORE_PLUGIN_ID,
  getModusPlugin,
  patchModusPluginSettings,
  type PluginSettingDefinition,
  type PluginSettingScope,
} from "./modus-plugins";
import { ensureHomeLayout } from "./modus-home";
import { settingNumberError } from "./settings-schema";
import {
  isKnownProvider,
  listOneShotProviders,
  supportsOneShotCompletion,
} from "./providers/provider-names";
import {
  getStoredGlobalConfig,
  getUserProfileUiConfig,
  listProjects,
  patchUserProfileUiConfig,
  saveGlobalConfig,
} from "./profiles";

export type PluginSettingsContext = {
  cwd?: string;
  userProfile?: string;
};

export type PluginSettingsSnapshot = {
  pluginId: string;
  settings: PluginSettingDefinition[];
  values: Record<string, unknown>;
};

const userStorageKey = (pluginId: string) => `plugin:${pluginId}`;

function settingScope(setting: PluginSettingDefinition): PluginSettingScope {
  return setting.scope ?? "user";
}

function assertSettingValue(setting: PluginSettingDefinition, value: unknown): void {
  if (value === null || value === undefined) return;
  switch (setting.type) {
    case "string":
      if (typeof value !== "string") throw new Error(`${setting.key} must be a string`);
      return;
    case "secret-name":
      if (typeof value !== "string" || (value && !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value))) {
        throw new Error(`${setting.key} must be a secret name, not a secret value`);
      }
      return;
    case "number": {
      const error = settingNumberError(setting.key, value, setting);
      if (error) throw new Error(error);
      return;
    }
    case "toggle":
      if (typeof value !== "boolean") throw new Error(`${setting.key} must be a boolean`);
      return;
    case "select":
      if (typeof value !== "string") throw new Error(`${setting.key} must be a string`);
      if (setting.options?.length && !setting.options.some((option) => option.value === value)) {
        throw new Error(`${setting.key} is not one of the declared options`);
      }
      return;
    case "provider":
      if (typeof value !== "string") throw new Error(`${setting.key} must be a provider name`);
      if (value && !isKnownProvider(value)) {
        throw new Error(`${setting.key} is not a known provider: ${value}`);
      }
      if (value && setting.oneShotOnly && !supportsOneShotCompletion(value)) {
        throw new Error(
          `${setting.key} must be a provider that can answer a one-shot completion `
          + `(${listOneShotProviders().join(", ")}); "${value}" would have to spawn a full session`,
        );
      }
      return;
    case "model":
      // Not checked against a live catalogue: that costs a network round trip on
      // every write, and a provider that is briefly unreachable would reject a
      // model the user can see in their own picker.
      if (typeof value !== "string") throw new Error(`${setting.key} must be a model id`);
      return;
    case "project-list":
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new Error(`${setting.key} must be an array of registered project paths`);
      }
      {
        const normalizePath = (entry: string) => entry.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const registered = new Set(listProjects().map((project) => normalizePath(project.path)));
        const unknown = value.find((entry) => !registered.has(normalizePath(entry)));
        if (unknown) throw new Error(`${setting.key} contains an unregistered project path: ${unknown}`);
      }
      return;
  }
}

/** Vault-scoped values for the synthesized core tier, which has no registration row. */
function coreGlobalValues(): Record<string, unknown> | undefined {
  return getStoredGlobalConfig().pluginSettings?.[CORE_PLUGIN_ID];
}

function writeCoreGlobalValues(values: Record<string, unknown>): void {
  // saveGlobalConfig only creates the directory on its project branch, so a
  // Vault whose _global.json has never been written would fail here. Boot
  // normally runs rehydrateHome() first, but core settings must not depend on
  // having been reached in that order.
  ensureHomeLayout();
  const config = getStoredGlobalConfig();
  saveGlobalConfig({
    ...config,
    pluginSettings: {
      ...(config.pluginSettings ?? {}),
      [CORE_PLUGIN_ID]: { ...(config.pluginSettings?.[CORE_PLUGIN_ID] ?? {}), ...values },
    },
  });
}

function storedValues(pluginId: string, context: PluginSettingsContext) {
  const plugin = getModusPlugin(pluginId, { includeDisabled: true });
  if (!plugin) throw new Error(`plugin not found: ${pluginId}`);
  const userValues = context.userProfile
    ? getUserProfileUiConfig(context.userProfile)?.clientExtensions?.settings?.[userStorageKey(plugin.id)]
    : undefined;
  const projectValues = context.cwd
    ? getStoredGlobalConfig(context.cwd).pluginSettings?.[plugin.id]
    : undefined;
  const globalValues = plugin.id === CORE_PLUGIN_ID ? coreGlobalValues() : plugin.settings;
  return { plugin, userValues, projectValues, globalValues };
}

export function getPluginSettings(
  pluginId: string,
  context: PluginSettingsContext = {},
): PluginSettingsSnapshot {
  const { plugin, userValues, projectValues, globalValues } = storedValues(pluginId, context);
  const settings = plugin.manifest.settings ?? [];
  const values: Record<string, unknown> = {};
  for (const setting of settings) {
    const scopedValues = settingScope(setting) === "global"
      ? globalValues
      : settingScope(setting) === "project"
        ? projectValues
        : userValues;
    values[setting.key] = scopedValues?.[setting.key] ?? setting.default ?? null;
  }
  return { pluginId: plugin.id, settings, values };
}

export function patchPluginSettings(
  pluginId: string,
  values: Record<string, unknown>,
  context: PluginSettingsContext = {},
): PluginSettingsSnapshot {
  const { plugin } = storedValues(pluginId, context);
  const definitions = new Map((plugin.manifest.settings ?? []).map((setting) => [setting.key, setting]));
  const byScope: Record<PluginSettingScope, Record<string, unknown>> = {
    user: {},
    project: {},
    global: {},
  };
  for (const [key, value] of Object.entries(values)) {
    const definition = definitions.get(key);
    if (!definition) throw new Error(`unknown setting "${key}" for plugin "${plugin.id}"`);
    assertSettingValue(definition, value);
    byScope[settingScope(definition)][key] = value;
  }

  if (Object.keys(byScope.user).length) {
    if (!context.userProfile) throw new Error("userProfile is required for user-scoped plugin settings");
    const ui = getUserProfileUiConfig(context.userProfile) ?? {};
    const extensions = ui.clientExtensions ?? {};
    const settings = extensions.settings ?? {};
    patchUserProfileUiConfig(context.userProfile, {
      clientExtensions: {
        ...extensions,
        settings: {
          ...settings,
          [userStorageKey(plugin.id)]: {
            ...(settings[userStorageKey(plugin.id)] ?? {}),
            ...byScope.user,
          },
        },
      },
    });
  }

  if (Object.keys(byScope.project).length) {
    if (!context.cwd) throw new Error("cwd is required for project-scoped plugin settings");
    const config = getStoredGlobalConfig(context.cwd);
    saveGlobalConfig({
      ...config,
      pluginSettings: {
        ...(config.pluginSettings ?? {}),
        [plugin.id]: {
          ...(config.pluginSettings?.[plugin.id] ?? {}),
          ...byScope.project,
        },
      },
    }, context.cwd);
  }

  if (Object.keys(byScope.global).length) {
    if (plugin.id === CORE_PLUGIN_ID) {
      writeCoreGlobalValues(byScope.global);
    } else if (!patchModusPluginSettings(plugin.id, byScope.global)) {
      throw new Error(`global settings cannot be written for plugin "${plugin.id}"`);
    }
  }

  return getPluginSettings(plugin.id, context);
}

export function createPluginSettingsAccessor(
  pluginId: string | undefined,
  context: PluginSettingsContext,
): {
  get<T = unknown>(key: string): T | undefined;
  all(): Record<string, unknown>;
} {
  return {
    get<T = unknown>(key: string): T | undefined {
      if (!pluginId) return undefined;
      return getPluginSettings(pluginId, context).values[key] as T | undefined;
    },
    all(): Record<string, unknown> {
      return pluginId ? getPluginSettings(pluginId, context).values : {};
    },
  };
}
