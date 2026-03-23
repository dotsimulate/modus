import { useState, useEffect, useRef } from "react";
import { saveProfileApi, deleteProfileApi, checkSecrets, patchUserProfileApi, fetchProviderModels } from "../api";
import type { Profile, McpServerConfig, ProviderModel } from "../api";
import { useProfiles } from "../providers/ProfileProvider";
import { SearchDropdown } from "./SearchDropdown";
import { ToolGrid } from "./ToolGrid";
import { providerToolFamily, type ToolStates } from "../tools";

type Props = {
  profiles: Profile[];
  onProfilesChange: () => void;
  mode?: "closed" | "new" | "edit";
  initialProfile?: string | null;
  onCancel?: () => void;
};

// ── MCP Server Editor ──

function McpServersEditor({
  servers,
  onChange,
}: {
  servers: Record<string, McpServerConfig>;
  onChange: (s: Record<string, McpServerConfig>) => void;
}) {
  const [newName, setNewName] = useState("");
  const [secretStatus, setSecretStatus] = useState<Record<string, boolean>>({});
  const [secretsPath, setSecretsPath] = useState("");

  useEffect(() => {
    const vars: string[] = [];
    for (const cfg of Object.values(servers)) {
      if ("env" in cfg && cfg.env) {
        for (const val of Object.values(cfg.env)) {
          if (typeof val === "string" && val.startsWith("$")) {
            vars.push(val.slice(1));
          }
        }
      }
    }
    if (vars.length === 0) { setSecretStatus({}); return; }
    checkSecrets(vars).then((r) => {
      setSecretStatus(r.status);
      setSecretsPath(r.secretsFile.replace(/^\/home\/[^/]+/, "~"));
    }).catch(() => {});
  }, [servers]);

  const entries = Object.entries(servers);

  const remove = (name: string) => {
    const next = { ...servers };
    delete next[name];
    onChange(next);
  };

  const update = (name: string, field: string, value: string) => {
    const cfg = { ...servers[name] } as any;
    if (field === "command") cfg.command = value;
    else if (field === "args") cfg.args = value.split(",").map((s: string) => s.trim()).filter(Boolean);
    else if (field === "url") cfg.url = value;
    onChange({ ...servers, [name]: cfg });
  };

  const updateEnv = (name: string, envKey: string, envVal: string, oldKey?: string) => {
    const cfg = { ...servers[name] } as any;
    const env = { ...(cfg.env ?? {}) };
    if (oldKey && oldKey !== envKey) delete env[oldKey];
    if (envKey) env[envKey] = envVal;
    cfg.env = env;
    onChange({ ...servers, [name]: cfg });
  };

  const removeEnv = (name: string, envKey: string) => {
    const cfg = { ...servers[name] } as any;
    const env = { ...(cfg.env ?? {}) };
    delete env[envKey];
    cfg.env = env;
    onChange({ ...servers, [name]: cfg });
  };

  const addEnv = (name: string) => {
    const cfg = { ...servers[name] } as any;
    cfg.env = { ...(cfg.env ?? {}), "": "" };
    onChange({ ...servers, [name]: cfg });
  };

  const add = () => {
    const n = newName.trim();
    if (!n || servers[n]) return;
    onChange({ ...servers, [n]: { command: "", args: [], env: {} } });
    setNewName("");
  };

  const setType = (name: string, type: string) => {
    if (type === "stdio") {
      onChange({ ...servers, [name]: { type: "stdio", command: "", args: [], env: {} } });
    } else if (type === "sse") {
      onChange({ ...servers, [name]: { type: "sse", url: "", headers: {} } });
    } else {
      onChange({ ...servers, [name]: { type: "http", url: "", headers: {} } });
    }
  };

  return (
    <div className="mcp-editor">
      <span className="mcp-editor-label">mcp servers</span>
      {entries.length === 0 && <span className="mcp-editor-empty">none configured</span>}
      {entries.map(([name, cfg]) => {
        const cfgType = ("command" in cfg) ? "stdio" : (cfg.type ?? "sse");
        return (
          <div key={name} className="mcp-entry">
            <div className="mcp-entry-header">
              <span className="mcp-entry-name">{name}</span>
              <div className="mcp-entry-actions">
                <select
                  className="mcp-type-select"
                  value={cfgType}
                  onChange={(e) => setType(name, e.target.value)}
                >
                  <option value="stdio">stdio</option>
                  <option value="sse">sse</option>
                  <option value="http">http</option>
                </select>
                <button className="mcp-remove" onClick={() => remove(name)}>&times;</button>
              </div>
            </div>
            {cfgType === "stdio" && "command" in cfg && (
              <div className="mcp-fields">
                <label>
                  <span>command</span>
                  <input
                    value={cfg.command}
                    onChange={(e) => update(name, "command", e.target.value)}
                    placeholder="npx"
                  />
                </label>
                <label>
                  <span>args</span>
                  <input
                    value={(cfg.args ?? []).join(", ")}
                    onChange={(e) => update(name, "args", e.target.value)}
                    placeholder="-y, tavily-mcp"
                  />
                </label>
                <div className="mcp-env-section">
                  <span className="mcp-env-label">env</span>
                  {Object.entries((cfg as any).env ?? {}).map(([k, v]) => {
                    const vStr = v as string;
                    const isRef = vStr.startsWith("$");
                    const varName = isRef ? vStr.slice(1) : "";
                    const isSet = isRef && varName in secretStatus ? secretStatus[varName] : undefined;
                    return (
                      <div key={k} className="mcp-env-row">
                        <input
                          className="mcp-env-key"
                          value={k}
                          onChange={(e) => updateEnv(name, e.target.value, vStr, k)}
                          placeholder="KEY"
                        />
                        <input
                          className="mcp-env-val"
                          value={vStr}
                          onChange={(e) => updateEnv(name, k, e.target.value)}
                          placeholder="$ENV_VAR"
                        />
                        {isRef && isSet !== undefined && (
                          <span
                            className={`mcp-env-status ${isSet ? "mcp-env-status--ok" : "mcp-env-status--missing"}`}
                            title={isSet ? `${varName}: configured` : `${varName}: add to ${secretsPath}`}
                          >
                            {isSet ? "\u2713" : "\u2717"}
                          </span>
                        )}
                        <button className="mcp-env-remove" onClick={() => removeEnv(name, k)}>&times;</button>
                      </div>
                    );
                  })}
                  <button className="mcp-env-add" onClick={() => addEnv(name)}>+ env</button>
                </div>
              </div>
            )}
            {(cfgType === "sse" || cfgType === "http") && "url" in cfg && (
              <div className="mcp-fields">
                <label>
                  <span>url</span>
                  <input
                    value={(cfg as any).url}
                    onChange={(e) => update(name, "url", e.target.value)}
                    placeholder="https://..."
                  />
                </label>
              </div>
            )}
          </div>
        );
      })}
      <div className="mcp-add-row">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="server name"
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button onClick={add}>+ add</button>
      </div>
    </div>
  );
}

// ── Profile Form ──

function ProfileForm({
  profile,
  onSave,
  onDelete,
  onCancel,
  isNew,
}: {
  profile: Profile;
  onSave: (p: Omit<Profile, "name"> & { name?: string }) => Promise<void>;
  onDelete?: () => void;
  onCancel: () => void;
  isNew?: boolean;
}) {
  const { availableProviders } = useProfiles();
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  const [prompt, setPrompt] = useState(profile.prompt);
  const [promptMode, setPromptMode] = useState(profile.promptMode ?? "append");
  const [provider, setProvider] = useState(profile.provider ?? "");
  const [model, setModel] = useState(profile.model ?? "");
  const [effort, setEffort] = useState(profile.effort ?? "");
  const [maxTurns, setMaxTurns] = useState(profile.maxTurns?.toString() ?? "");
  const [toolStates, setToolStates] = useState<ToolStates>(() => {
    if (!profile.tools || profile.tools === "all") return {};
    const s: ToolStates = {};
    for (const t of profile.tools) s[t] = "on";
    return s;
  });
  const [loadProjectSettings, setLoadProjectSettings] = useState(profile.loadProjectSettings ?? true);
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerConfig>>(
    profile.mcpServers ?? {},
  );
  const [saving, setSaving] = useState(false);
  const [providerModels, setProviderModels] = useState<ProviderModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [saveError, setSaveError] = useState("");
  const previousProviderRef = useRef(provider);

  const enabledToolCount = Object.values(toolStates).filter((s) => s === "on").length;
  const toolSummary = enabledToolCount === 0 ? "all" : `${enabledToolCount} selected`;

  useEffect(() => {
    const providerChanged = previousProviderRef.current !== provider;
    previousProviderRef.current = provider;
    const p = provider || "claude-code";
    if (providerChanged) {
      setModel("");
      setProviderModels([]);
    }
    setModelsLoading(true);
    fetchProviderModels(p).then((models) => {
      setProviderModels(models);
      if (model && models.length > 0 && !models.some((m) => m.id === model)) {
        setModel("");
      }
    }).catch(() => setProviderModels([])).finally(() => setModelsLoading(false));
    const previousFamily = providerToolFamily(profile.provider);
    const nextFamily = providerToolFamily(provider);
    if (previousFamily !== nextFamily) setToolStates({});
  }, [provider]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    try {
      const data: any = { description, prompt, promptMode, loadProjectSettings };
      if (provider) data.provider = provider;
      if (model) data.model = model;
      if (effort) data.effort = effort;
      if (maxTurns) data.maxTurns = Number(maxTurns);
      const onTools = Object.entries(toolStates).filter(([, s]) => s === "on").map(([t]) => t);
      if (onTools.length > 0) data.tools = onTools;
      if (Object.keys(mcpServers).length > 0) data.mcpServers = mcpServers;
      if (isNew) data.name = name;
      await onSave(data);
    } catch (err: any) {
      setSaveError(err?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pf">
      {/* Identity */}
      <div className="pf-group">
        {isNew && (
          <label className="pf-field">
            <span>name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-agent" />
          </label>
        )}
        <label className="pf-field">
          <span>description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>

      {/* Runtime */}
      <div className="pf-group">
        <span className="pf-group-label">runtime</span>
        <div className="pf-row">
          <label className="pf-field">
            <span>provider</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">claude-code</option>
              {availableProviders
                .filter((v) => v !== "claude-code")
                .map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="pf-field">
            <span>model</span>
            <SearchDropdown
              className="pf-search-dropdown"
              value={model}
              options={providerModels.map((m) => ({ value: m.id }))}
              placeholder={modelsLoading ? "loading..." : "select model"}
              searchPlaceholder="search models..."
              emptyLabel={modelsLoading ? "loading..." : "no models"}
              onChange={setModel}
            />
            {!model && !modelsLoading && providerModels.length > 0 && (
              <span className="pf-warn">required</span>
            )}
          </label>
        </div>
        <div className="pf-row pf-row--3">
          <label className="pf-field">
            <span>effort</span>
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="">default</option>
              <option value="off">off</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
          </label>
          <label className="pf-field">
            <span>max turns</span>
            <input value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} placeholder="—" type="number" />
          </label>
          <label className="pf-field">
            <span>prompt mode</span>
            <select value={promptMode} onChange={(e) => setPromptMode(e.target.value as "custom" | "append")}>
              <option value="append">append</option>
              <option value="custom">custom</option>
            </select>
          </label>
        </div>
        <label className="pf-check">
          <input type="checkbox" checked={loadProjectSettings} onChange={(e) => setLoadProjectSettings(e.target.checked)} />
          <span>load CLAUDE.md</span>
        </label>
      </div>

      {/* Prompt */}
      <div className="pf-group">
        <span className="pf-group-label">prompt</span>
        <textarea
          className="pf-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={10}
          placeholder="system prompt..."
        />
      </div>

      {/* Tools */}
      <div className="pf-group">
        <div className="pf-group-head">
          <span className="pf-group-label">tools</span>
          <span className="pf-group-meta">{toolSummary}</span>
        </div>
        <ToolGrid
          mode="baseline"
          states={toolStates}
          onChange={setToolStates}
          compact
          provider={provider}
        />
      </div>

      {/* MCP */}
      <div className="pf-group">
        <span className="pf-group-label">mcp servers</span>
        <McpServersEditor servers={mcpServers} onChange={setMcpServers} />
      </div>

      {/* Footer */}
      <div className="pf-footer">
        {saveError && <span className="pf-error">{saveError}</span>}
        <span className="pf-spacer" />
        <button className="apc-action" onClick={onCancel}>cancel</button>
        {onDelete && (
          <button className="apc-action pf-btn-delete" onClick={onDelete}>delete</button>
        )}
        <button
          className="apc-action apc-action--primary"
          onClick={handleSave}
          disabled={saving || !description.trim() || !prompt.trim() || !model}
        >
          {saving ? "saving..." : isNew ? "create" : "save"}
        </button>
      </div>
    </div>
  );
}

// ── Profile Editor ──

export function ProfileEditor({
  profiles,
  onProfilesChange,
  mode = "closed",
  initialProfile = null,
  onCancel,
}: Props) {
  const { activeUserProfile, activeUP, activeCwd, projectRoot, refreshProfiles, refreshUserProfiles } = useProfiles();
  const profileCwd = projectRoot ?? activeCwd;

  const isOpen = mode !== "closed";
  const isNew = mode === "new";
  const selected = profiles.find((p) => p.name === initialProfile) ?? null;

  const formProfile: Profile = isNew
    ? { name: "", description: "", prompt: "", tools: "all" as const }
    : (selected ?? { name: "", description: "", prompt: "", tools: "all" as const });

  const handleSave = async (data: Omit<Profile, "name"> & { name?: string }) => {
    const saveName = isNew ? (data.name ?? "untitled") : initialProfile!;
    const { name: _n, ...rest } = data as any;
    await saveProfileApi(saveName, rest, profileCwd);
    if (isNew && activeUserProfile && activeUP?.agentProfiles) {
      const updated = [...activeUP.agentProfiles, saveName];
      await patchUserProfileApi(activeUserProfile, { agentProfiles: updated });
    }
    await Promise.all([refreshProfiles(), refreshUserProfiles()]);
    onProfilesChange();
  };

  const handleDelete = async () => {
    if (!initialProfile) return;
    await deleteProfileApi(initialProfile, profileCwd);
    onProfilesChange();
  };

  if (!isOpen) return null;

  return (
    <div className="profile-editor">
      <div className="profile-editor-header">
        <span className="apc-name">{isNew ? "new agent" : initialProfile}</span>
        <span className="apc-actions-spacer" />
        <button className="apc-action" onClick={() => onCancel?.()}>close</button>
      </div>
      <div className="profile-editor-body">
        {(isNew || selected) ? (
          <ProfileForm
            key={isNew ? "new" : selected!.name}
            profile={formProfile}
            onSave={handleSave}
            onDelete={!isNew && selected ? handleDelete : undefined}
            onCancel={() => onCancel?.()}
            isNew={isNew}
          />
        ) : (
          <div className="profile-empty">profile not found</div>
        )}
      </div>
    </div>
  );
}
