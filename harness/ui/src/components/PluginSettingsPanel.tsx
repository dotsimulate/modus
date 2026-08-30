import { useEffect, useMemo, useState } from "react";
import type {
  ModusPlugin,
  PluginSettingDefinition,
  PluginSettingsSnapshot,
  ProjectInfo,
  ProviderModel,
} from "../../../sdk";
import { modus } from "../modusClient";

type Props = {
  plugin: ModusPlugin;
  cwd?: string;
  userProfile?: string | null;
};

/** Model lists come from the provider, so they are fetched per provider name. */
type ModelCatalogue = {
  byProvider: Record<string, ProviderModel[]>;
  loading: string[];
};

function PluginSettingField({
  setting,
  value,
  values,
  projects,
  providers,
  oneShotProviders,
  models,
  disabled,
  onChange,
}: {
  setting: PluginSettingDefinition;
  value: unknown;
  values: Record<string, unknown>;
  projects: ProjectInfo[];
  providers: string[];
  oneShotProviders: string[];
  models: ModelCatalogue;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = setting.label ?? setting.key;
  if (setting.type === "provider") {
    const options = setting.oneShotOnly ? oneShotProviders : providers;
    // A value already stored but no longer offered still has to be visible, or
    // the form would silently show "(unset)" for a setting that is very much set.
    const withCurrent = value && !options.includes(String(value)) ? [String(value), ...options] : options;
    return (
      <label className="exw-setting">
        <span className="exw-setting-label">{label}</span>
        <select className="exw-setting-input" value={String(value ?? "")} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">(unset)</option>
          {withCurrent.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        {setting.description && <small className="exw-setting-description">{setting.description}</small>}
        <small className="exw-setting-scope">{setting.scope ?? "user"}</small>
      </label>
    );
  }
  if (setting.type === "model") {
    const providerName = setting.providerSetting ? String(values[setting.providerSetting] ?? "") : "";
    const loading = models.loading.includes(providerName);
    const available = models.byProvider[providerName] ?? [];
    const ids = available.map((model) => model.id);
    const withCurrent = value && !ids.includes(String(value)) ? [String(value), ...ids] : ids;
    return (
      <label className="exw-setting">
        <span className="exw-setting-label">{label}</span>
        <select
          className="exw-setting-input"
          value={String(value ?? "")}
          disabled={disabled || !providerName || loading}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">
            {!providerName ? "(choose a provider first)" : loading ? "loading…" : "(unset)"}
          </option>
          {withCurrent.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        {providerName && !loading && ids.length === 0 && (
          <small className="exw-setting-description">
            {providerName} returned no models — check that it is configured and reachable.
          </small>
        )}
        {setting.description && <small className="exw-setting-description">{setting.description}</small>}
        <small className="exw-setting-scope">{setting.scope ?? "user"}</small>
      </label>
    );
  }
  if (setting.type === "toggle") {
    return (
      <label className="exw-setting exw-setting--toggle">
        <span className="exw-setting-label">{label}</span>
        <input type="checkbox" checked={!!value} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      </label>
    );
  }
  if (setting.type === "select") {
    return (
      <label className="exw-setting">
        <span className="exw-setting-label">{label}</span>
        <select className="exw-setting-input" value={String(value ?? "")} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">(unset)</option>
          {(setting.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    );
  }
  if (setting.type === "project-list") {
    const selected = new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
    const knownPaths = new Set(projects.map((project) => project.path));
    return (
      <div className="exw-setting exw-setting--projects">
        <span className="exw-setting-label">{label}</span>
        <div className="exw-project-list">
          {projects.map((project) => (
            <label key={project.id} className="exw-project-option">
              <input
                type="checkbox"
                disabled={disabled}
                checked={selected.has(project.path)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(project.path);
                  else next.delete(project.path);
                  onChange(Array.from(next));
                }}
              />
              <span>{project.name}</span>
              <small>{project.path}</small>
            </label>
          ))}
          {Array.from(selected).filter((path) => !knownPaths.has(path)).map((path) => (
            <label key={path} className="exw-project-option exw-project-option--missing">
              <input
                type="checkbox"
                checked
                disabled={disabled}
                onChange={() => {
                  const next = new Set(selected);
                  next.delete(path);
                  onChange(Array.from(next));
                }}
              />
              <span>unavailable project</span>
              <small>{path}</small>
            </label>
          ))}
        </div>
      </div>
    );
  }
  return (
    <label className="exw-setting">
      <span className="exw-setting-label">{label}</span>
      <input
        className="exw-setting-input"
        type={setting.type === "number" ? "number" : "text"}
        min={setting.type === "number" ? setting.min : undefined}
        max={setting.type === "number" ? setting.max : undefined}
        step={setting.type === "number" ? setting.step : undefined}
        value={value == null ? "" : String(value)}
        disabled={disabled}
        placeholder={setting.type === "secret-name" ? "Modus secret name" : undefined}
        onChange={(event) => onChange(setting.type === "number"
          ? (event.target.value === "" ? null : Number(event.target.value))
          : event.target.value)}
      />
      {setting.description && <small className="exw-setting-description">{setting.description}</small>}
      <small className="exw-setting-scope">{setting.scope ?? "user"}</small>
    </label>
  );
}

export function PluginSettingsPanel({ plugin, cwd, userProfile }: Props) {
  const [snapshot, setSnapshot] = useState<PluginSettingsSnapshot | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [oneShotProviders, setOneShotProviders] = useState<string[]>([]);
  const [models, setModels] = useState<ModelCatalogue>({ byProvider: {}, loading: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settings = snapshot?.settings ?? plugin.manifest.settings ?? [];
  const needsProviders = settings.some((setting) => setting.type === "provider");
  // Distinct provider names any `model` field currently points at. Joined so the
  // effect below re-runs when a provider changes but not on every keystroke.
  const modelProviderKey = settings
    .filter((setting) => setting.type === "model")
    .map((setting) => (setting.providerSetting ? String(values[setting.providerSetting] ?? "") : ""))
    .filter(Boolean)
    .sort()
    .join(" ");

  useEffect(() => {
    let active = true;
    Promise.all([
      modus.getPluginSettings(plugin.id, { cwd, userProfile }),
      modus.listProjects(),
    ]).then(([next, projectList]) => {
      if (!active) return;
      setSnapshot(next);
      setValues(next.values);
      setProjects(projectList);
      setError(null);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [plugin.id, cwd, userProfile]);

  useEffect(() => {
    if (!needsProviders) return;
    let active = true;
    Promise.all([modus.listProviders(), modus.listOneShotProviders()])
      .then(([all, oneShot]) => {
        if (!active) return;
        setProviders(all);
        setOneShotProviders(oneShot);
      })
      // A provider list that will not load leaves the picker empty rather than
      // failing the whole settings form, which the user may be here to fix.
      .catch(() => { if (active) { setProviders([]); setOneShotProviders([]); } });
    return () => { active = false; };
  }, [needsProviders]);

  useEffect(() => {
    const wanted = modelProviderKey ? modelProviderKey.split(" ") : [];
    const missing = wanted.filter((name) => !(name in models.byProvider) && !models.loading.includes(name));
    if (missing.length === 0) return;
    let active = true;
    setModels((current) => ({ ...current, loading: [...current.loading, ...missing] }));
    void Promise.all(missing.map(async (name) => [name, await modus.getProviderModels(name)] as const))
      .then((entries) => {
        if (!active) return;
        setModels((current) => ({
          byProvider: { ...current.byProvider, ...Object.fromEntries(entries) },
          loading: current.loading.filter((name) => !missing.includes(name)),
        }));
      });
    return () => { active = false; };
  }, [modelProviderKey, models]);

  const changedValues = useMemo(
    () => !snapshot ? {} : Object.fromEntries(Object.entries(values).filter(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify(snapshot.values[key]))),
    [snapshot, values],
  );
  const dirty = Object.keys(changedValues).length > 0;
  const contextMissing = (snapshot?.settings ?? []).some((setting) =>
    (setting.scope ?? "user") === "user" ? !userProfile
      : setting.scope === "project" ? !cwd
        : false,
  );
  const changedDefinitions = new Map((snapshot?.settings ?? []).map((setting) => [setting.key, setting]));
  const changedContextMissing = Object.keys(changedValues).some((key) => {
    const setting = changedDefinitions.get(key);
    return (setting?.scope ?? "user") === "user" ? !userProfile
      : setting?.scope === "project" ? !cwd
        : false;
  });

  const save = async () => {
    if (!snapshot) return;
    setSaving(true);
    setError(null);
    try {
      const next = await modus.patchPluginSettings(plugin.id, changedValues, { cwd, userProfile });
      setSnapshot(next);
      setValues(next.values);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!plugin.manifest.settings?.length) return null;
  if (!snapshot && !error) return <div className="exw-settings">loading settings…</div>;

  return (
    <div className="exw-settings">
      {settings.map((setting) => {
        const missingScope = (setting.scope ?? "user") === "user" ? !userProfile
          : setting.scope === "project" ? !cwd
            : false;
        return (
          <PluginSettingField
            key={setting.key}
            setting={setting}
            value={values[setting.key]}
            values={values}
            projects={projects}
            providers={providers}
            oneShotProviders={oneShotProviders}
            models={models}
            disabled={saving || missingScope}
            onChange={(value) => setValues((current) => ({ ...current, [setting.key]: value }))}
          />
        );
      })}
      {contextMissing && <div className="exw-plugin-error">Select a user profile and project to edit their scoped fields.</div>}
      {error && <div className="exw-plugin-error">{error}</div>}
      {dirty && (
        <button className="exw-save" type="button" disabled={saving || changedContextMissing} onClick={() => void save()}>
          {saving ? "saving..." : "save plugin settings"}
        </button>
      )}
    </div>
  );
}
