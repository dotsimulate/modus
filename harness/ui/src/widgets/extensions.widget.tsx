/**
 * Extensions widget — manage client extensions: enable/disable + settings.
 *
 * Config example:
 *   { "id": "extensions-main", "type": "extensions", "title": "extensions" }
 */

import { useCallback, useState } from "react";
import { modus } from "../modusClient";
import type { ClientExtensionManifestItem, ExtensionSettingSchema, ModusPlugin } from "../../../sdk/index";
import { WidgetEmptyState } from "./widget-components";
import { useWidgetPollingValue } from "./widget-data";
import { useProfiles } from "../providers/ProfileContext";
import { useExtensionSettingOptions, type ExtensionSettingOption } from "../client-extensions";
import { PluginSettingsPanel } from "../components/PluginSettingsPanel";

function SettingField({
  name,
  schema,
  value,
  liveOptions,
  onChange,
}: {
  name: string;
  schema: ExtensionSettingSchema;
  value: unknown;
  liveOptions?: { options: ExtensionSettingOption[]; emptyLabel?: string };
  onChange: (name: string, value: unknown) => void;
}) {
  // A loaded extension can publish options that only exist in the browser
  // (audio devices, for one), which the static manifest cannot express. When it
  // has, that list wins over the declared field type.
  if (liveOptions) {
    const selected = String(value ?? "");
    const known = !selected || liveOptions.options.some((opt) => opt.value === selected);
    return (
      <label className="exw-setting">
        <span className="exw-setting-label">{schema.label}</span>
        <select
          className="exw-setting-input"
          value={selected}
          onChange={(e) => onChange(name, e.target.value)}
        >
          <option value="">{liveOptions.emptyLabel ?? "(unset)"}</option>
          {liveOptions.options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
          {/* Keep a saved value that is not currently present selectable — an
              unplugged device must not be silently rewritten on the next save. */}
          {!known && <option value={selected}>{`${selected} (not available)`}</option>}
        </select>
      </label>
    );
  }

  if (schema.type === "boolean") {
    return (
      <label className="exw-setting exw-setting--toggle">
        <span className="exw-setting-label">{schema.label}</span>
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(name, e.target.checked)}
        />
      </label>
    );
  }

  if (schema.type === "select" && schema.options) {
    return (
      <label className="exw-setting">
        <span className="exw-setting-label">{schema.label}</span>
        <select
          className="exw-setting-input"
          value={String(value ?? "")}
          onChange={(e) => onChange(name, e.target.value)}
        >
          {schema.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (schema.type === "number") {
    return (
      <label className="exw-setting">
        <span className="exw-setting-label">{schema.label}</span>
        <input
          className="exw-setting-input"
          type="number"
          value={value != null ? String(value) : ""}
          onChange={(e) => onChange(name, e.target.value ? Number(e.target.value) : null)}
        />
      </label>
    );
  }

  // string fallback
  return (
    <label className="exw-setting">
      <span className="exw-setting-label">{schema.label}</span>
      <input
        className="exw-setting-input"
        type="text"
        value={String(value ?? "")}
        onChange={(e) => onChange(name, e.target.value)}
      />
    </label>
  );
}

function ExtensionRow({
  ext,
  userProfile,
  onRefresh,
}: {
  ext: ClientExtensionManifestItem;
  userProfile: string;
  onRefresh: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localSettings, setLocalSettings] = useState<Record<string, unknown>>(ext.settingsValues);
  const liveOptions = useExtensionSettingOptions(ext.id);
  const hasSettings = ext.meta.settings && Object.keys(ext.meta.settings).length > 0;

  const handleToggle = async () => {
    setSaving(true);
    await modus.patchClientExtension(ext.id, userProfile, { enabled: !ext.enabled });
    await onRefresh();
    setSaving(false);
  };

  const handleSettingChange = (name: string, value: unknown) => {
    setLocalSettings((prev) => ({ ...prev, [name]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    await modus.patchClientExtension(ext.id, userProfile, { settings: localSettings });
    await onRefresh();
    setSaving(false);
  };

  const displayName = ext.meta.name || ext.id;
  const isDirty = JSON.stringify(localSettings) !== JSON.stringify(ext.settingsValues);

  return (
    <div className={`exw-ext ${ext.enabled ? "exw-ext--on" : "exw-ext--off"}`}>
      <div className="exw-ext-header">
        <button
          className={`exw-toggle ${ext.enabled ? "exw-toggle--on" : ""}`}
          onClick={handleToggle}
          disabled={saving}
          title={ext.enabled ? "Disable" : "Enable"}
        >
          <span className="exw-toggle-dot" />
        </button>
        <div className="exw-ext-info" onClick={() => hasSettings && setExpanded(!expanded)}>
          <span className="exw-ext-name">{displayName}</span>
          <span className="exw-ext-source">{ext.source}</span>
        </div>
        {hasSettings && (
          <button
            className="exw-gear"
            onClick={() => setExpanded(!expanded)}
            title="Settings"
          >
            {expanded ? "\u25B4" : "\u2699"}
          </button>
        )}
      </div>
      {ext.meta.description && !expanded && (
        <div className="exw-ext-desc">{ext.meta.description}</div>
      )}
      {expanded && ext.meta.settings && (
        <div className="exw-settings">
          {Object.entries(ext.meta.settings).map(([key, schema]) => (
            <SettingField
              key={key}
              name={key}
              schema={schema}
              value={localSettings[key]}
              liveOptions={liveOptions[key]}
              onChange={handleSettingChange}
            />
          ))}
          {isDirty && (
            <button className="exw-save" onClick={handleSave} disabled={saving}>
              {saving ? "saving..." : "save"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PluginRow({
  plugin,
  cwd,
  userProfile,
  onRefresh,
}: {
  plugin: ModusPlugin;
  cwd?: string;
  userProfile?: string | null;
  onRefresh: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const hasDetails = !!plugin.about || !!plugin.description || !!plugin.manifest.settings?.length
    || !!plugin.providedSkills?.length;

  const handleToggle = async () => {
    setSaving(true);
    await modus.patchPlugin(plugin.id, { enabled: !plugin.enabled });
    await onRefresh();
    setSaving(false);
  };

  const handleRemove = async () => {
    setSaving(true);
    await modus.unregisterPlugin(plugin.id);
    await onRefresh();
    setSaving(false);
  };

  return (
    <div className={`exw-plugin ${plugin.enabled ? "exw-plugin--on" : "exw-plugin--off"}`}>
      {!plugin.builtin ? (
        <button
          className={`exw-toggle ${plugin.enabled ? "exw-toggle--on" : ""}`}
          onClick={handleToggle}
          disabled={saving}
          title={plugin.enabled ? "Disable plugin" : "Enable plugin"}
        >
          <span className="exw-toggle-dot" />
        </button>
      ) : <span className="exw-toggle exw-toggle--on" title="Built-in plugin"><span className="exw-toggle-dot" /></span>}
      <div className="exw-plugin-info" onClick={() => hasDetails && setExpanded((value) => !value)}>
        <span className="exw-plugin-name">{plugin.name || plugin.id}{plugin.builtin ? " · built in" : ""}</span>
        <span className="exw-plugin-path">{plugin.path}</span>
      </div>
      {hasDetails && <button className="exw-gear" onClick={() => setExpanded((value) => !value)}>{expanded ? "\u25B4" : "\u2699"}</button>}
      {plugin.removable !== false && (
        <button className="exw-plugin-remove" onClick={handleRemove} disabled={saving} title="Unregister plugin">
          &times;
        </button>
      )}
      {expanded && (
        <div className="exw-plugin-details">
          {plugin.description && <div className="exw-ext-desc">{plugin.description}</div>}
          {!!plugin.providedSkills?.length && (
            <div className="exw-plugin-skills">
              <div className="exw-plugin-skills-label">
                Skills provided — instructions this plugin can put in an agent's context
              </div>
              {plugin.providedSkills.map((skill) => (
                <div key={skill.name} className="exw-plugin-skill">
                  <span className="exw-plugin-skill-name">{skill.name}</span>
                  {skill.description && <span className="exw-plugin-skill-desc">{skill.description}</span>}
                </div>
              ))}
            </div>
          )}
          {plugin.about && <pre className="exw-plugin-about">{plugin.about}</pre>}
          <PluginSettingsPanel plugin={plugin} cwd={cwd} userProfile={userProfile} />
        </div>
      )}
    </div>
  );
}

function PluginRegistry({
  plugins,
  cwd,
  userProfile,
  onRefresh,
}: {
  plugins: ModusPlugin[];
  cwd?: string;
  userProfile?: string | null;
  onRefresh: () => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRegister = async () => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await modus.registerPlugin(trimmed);
      setPath("");
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to register plugin");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="exw-plugins">
      <div className="exw-section-title">plugins</div>
      <div className="exw-plugin-register">
        <input
          className="exw-plugin-input"
          value={path}
          placeholder="/path/to/modus-plugin"
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleRegister();
            }
          }}
        />
        <button className="exw-plugin-add" onClick={() => { void handleRegister(); }} disabled={saving || !path.trim()}>
          add
        </button>
      </div>
      {error && <div className="exw-plugin-error">{error}</div>}
      {plugins.map((plugin) => (
        <PluginRow key={plugin.id} plugin={plugin} cwd={cwd} userProfile={userProfile} onRefresh={onRefresh} />
      ))}
    </div>
  );
}

export default function ExtensionsWidget() {
  const { activeUserProfile, activeCwd } = useProfiles();
  const extCwd = activeCwd;

  const load = useCallback(
    () => modus.listClientExtensions(extCwd, activeUserProfile),
    [extCwd, activeUserProfile],
  );

  const loadPlugins = useCallback(
    () => modus.listPlugins(),
    [],
  );

  const { value: extensions, loading, refresh } = useWidgetPollingValue<ClientExtensionManifestItem[]>({
    load,
    scopeKey: `extensions-${activeUserProfile}`,
    intervalMs: 30_000,
    initialValue: [],
  });

  const { value: plugins, refresh: refreshPlugins } = useWidgetPollingValue<ModusPlugin[]>({
    load: loadPlugins,
    scopeKey: "plugins",
    intervalMs: 30_000,
    initialValue: [],
  });

  const refreshAll = useCallback(async () => {
    await refreshPlugins();
    await refresh();
  }, [refresh, refreshPlugins]);

  if (!activeUserProfile) {
    return <WidgetEmptyState>no user profile active</WidgetEmptyState>;
  }

  if (loading && extensions.length === 0) {
    return <WidgetEmptyState>loading extensions...</WidgetEmptyState>;
  }

  return (
    <div className="exw-widget">
      <PluginRegistry plugins={plugins} cwd={extCwd} userProfile={activeUserProfile} onRefresh={refreshAll} />
      <div className="exw-section-title">extensions</div>
      {extensions.length === 0
        ? <WidgetEmptyState>no extensions discovered</WidgetEmptyState>
        : extensions.map((ext) => (
          <ExtensionRow
            key={ext.id}
            ext={ext}
            userProfile={activeUserProfile}
            onRefresh={refresh}
          />
        ))}
    </div>
  );
}
