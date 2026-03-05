import { useState, useEffect } from "react";
import { saveProfileApi, deleteProfileApi, checkSecrets } from "../api";
import type { Profile, McpServerConfig } from "../api";
import { ToolGrid } from "./ToolGrid";
import type { ToolStates } from "../tools";

type Props = {
  profiles: Profile[];
  onProfilesChange: () => void;
  /** "new" = creating new profile, "edit" = editing existing */
  mode?: "new" | "edit";
  /** Which profile to load initially (edit mode) or duplicate from (new mode) */
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

  // Collect all $VAR references and check which are configured
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
  onSave: (p: Omit<Profile, "name"> & { name?: string }) => void;
  onDelete?: () => void;
  onCancel: () => void;
  isNew?: boolean;
}) {
  const [name, setName] = useState(isNew && profile.name ? `${profile.name}-copy` : profile.name);
  const [description, setDescription] = useState(profile.description);
  const [prompt, setPrompt] = useState(profile.prompt);
  const [promptMode, setPromptMode] = useState(profile.promptMode ?? "append");
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


  const handleSave = async () => {
    setSaving(true);
    const data: any = { description, prompt, promptMode, loadProjectSettings };
    if (model) data.model = model;
    if (effort) data.effort = effort;
    if (maxTurns) data.maxTurns = Number(maxTurns);
    const onTools = Object.entries(toolStates).filter(([, s]) => s === "on").map(([t]) => t);
    if (onTools.length > 0) data.tools = onTools;
    if (Object.keys(mcpServers).length > 0) data.mcpServers = mcpServers;
    if (isNew) data.name = name;
    onSave(data);
    setSaving(false);
  };

  return (
    <div className="profile-form">
      {isNew && (
        <label className="profile-field">
          <span>name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-agent" />
        </label>
      )}
      <label className="profile-field">
        <span>description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="profile-field">
        <span>prompt</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} />
      </label>
      <div className="profile-field-row">
        <label className="profile-field">
          <span>model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">default</option>
            <option value="claude-opus-4-6">opus 4.6</option>
            <option value="claude-sonnet-4-6">sonnet 4.6</option>
            <option value="claude-haiku-4-5">haiku 4.5</option>
          </select>
        </label>
        <label className="profile-field">
          <span>effort</span>
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="">default</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="max">max</option>
          </select>
        </label>
        <label className="profile-field">
          <span>max turns</span>
          <input value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} placeholder="none" type="number" />
        </label>
      </div>
      <div className="profile-field-row">
        <label className="profile-field">
          <span>prompt mode</span>
          <select value={promptMode} onChange={(e) => setPromptMode(e.target.value as "custom" | "append")}>
            <option value="append">append</option>
            <option value="custom">custom</option>
          </select>
        </label>
      </div>
      <ToolGrid
        mode="baseline"
        states={toolStates}
        onChange={setToolStates}
        compact
      />
      <label className="profile-checkbox">
        <input type="checkbox" checked={loadProjectSettings} onChange={(e) => setLoadProjectSettings(e.target.checked)} />
        <span>load CLAUDE.md</span>
      </label>

      <McpServersEditor servers={mcpServers} onChange={setMcpServers} />

      <div className="profile-form-actions">
        <button className="profile-btn profile-btn--save" onClick={handleSave} disabled={saving || !description || !prompt}>
          {saving ? "saving..." : isNew ? "create" : "save"}
        </button>
        {onDelete && (
          <button className="profile-btn profile-btn--delete" onClick={onDelete}>delete</button>
        )}
        <button className="profile-btn" onClick={onCancel}>cancel</button>
      </div>
    </div>
  );
}

// ── Profile Editor Panel ──

export function ProfileEditor({
  profiles,
  onProfilesChange,
  mode = "new",
  initialProfile = null,
  onCancel,
}: Props) {
  const [selectedName, setSelectedName] = useState<string | null>(initialProfile);
  // In "new" mode, we track whether the user has picked a source to duplicate from
  const [duplicateSource, setDuplicateSource] = useState<string | null>(null);

  // Sync when initialProfile changes from parent
  useEffect(() => {
    setSelectedName(initialProfile);
    if (mode === "edit") setDuplicateSource(null);
  }, [initialProfile, mode]);

  const isNew = mode === "new";
  const selected = profiles.find((p) => p.name === selectedName) ?? null;

  // The profile to show in the form
  const formProfile: Profile = isNew
    ? (duplicateSource
        ? { ...(profiles.find((p) => p.name === duplicateSource) ?? { name: "", description: "", prompt: "", tools: "all" as const }) }
        : { name: "", description: "", prompt: "", tools: "all" as const })
    : (selected ?? { name: "", description: "", prompt: "", tools: "all" as const });

  const handleSave = async (data: Omit<Profile, "name"> & { name?: string }) => {
    const saveName = isNew ? (data.name ?? "untitled") : selectedName!;
    const { name: _n, ...rest } = data as any;
    await saveProfileApi(saveName, rest);
    onProfilesChange();
  };

  const handleDelete = async () => {
    if (!selectedName) return;
    await deleteProfileApi(selectedName);
    setSelectedName(null);
    onProfilesChange();
  };

  const handleListClick = (name: string) => {
    if (isNew) {
      // In new mode, clicking a profile duplicates its settings
      setDuplicateSource(name);
    } else {
      setSelectedName(name);
    }
  };

  const cancel = () => {
    setSelectedName(null);
    setDuplicateSource(null);
    onCancel?.();
  };

  return (
    <div className="profile-editor">
      <div className="profile-list">
        <div className="profile-list-label">
          {isNew ? "duplicate from" : "edit profile"}
        </div>
        {profiles.map((p) => {
          const isActive = isNew
            ? p.name === duplicateSource
            : p.name === selectedName;
          return (
            <button
              key={p.name}
              className={`profile-list-item ${isActive ? "profile-list-item--active" : ""}`}
              onClick={() => handleListClick(p.name)}
            >
              <span className="profile-list-name">{p.name}</span>
              <span className="profile-list-desc">{p.description}</span>
            </button>
          );
        })}
      </div>

      {(isNew || selected) ? (
        <ProfileForm
          key={isNew ? `new-${duplicateSource ?? "blank"}` : selected!.name}
          profile={formProfile}
          onSave={handleSave}
          onDelete={!isNew && selected ? handleDelete : undefined}
          onCancel={cancel}
          isNew={isNew}
        />
      ) : (
        <div className="profile-empty">select a profile to edit</div>
      )}
    </div>
  );
}
