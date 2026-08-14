/**
 * Scoped settings for Modus plugins.
 *
 * Storage follows the existing ownership boundaries:
 *   user    → user-profile UI client-extension settings
 *   project → <cwd>/.modus/_global.json
 *   global  → ~/.modus/plugins.json registration
 */

import {
  getModusPlugin,
  patchModusPluginSettings,
  type PluginSettingDefinition,
  type PluginSettingScope,
} from "./modus-plugins";
import { settingNumberError } from "./settings-schema";
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

function storedValues(pluginId: string, context: PluginSettingsContext) {
  const plugin = getModusPlugin(pluginId, { includeDisabled: true });
  if (!plugin) throw new Error(`plugin not found: ${pluginId}`);
  const userValues = context.userProfile
    ? getUserProfileUiConfig(context.userProfile)?.clientExtensions?.settings?.[userStorageKey(plugin.id)]
    : undefined;
  const projectValues = context.cwd
    ? getStoredGlobalConfig(context.cwd).pluginSettings?.[plugin.id]
    : undefined;
  return { plugin, userValues, projectValues, globalValues: plugin.settings };
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

  if (Object.keys(byScope.global).length && !patchModusPluginSettings(plugin.id, byScope.global)) {
    throw new Error(`global settings cannot be written for plugin "${plugin.id}"`);
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
