import { useState, useEffect, useRef } from "react";
import { modus } from "../modusClient";
import type { Profile, McpServerConfig, ProviderModel } from "../../../sdk/index";
import { useProfiles } from "../providers/ProfileContext";
import { SearchDropdown } from "./SearchDropdown";
import { ToolGrid } from "./ToolGrid";
import { PermissionPolicyControl } from "./PermissionPolicyControl";
import { providerDisplayLabel, providerToolFamily, type ToolStates } from "../tools";
import { buildProfileSavePayload, unmanagedProfileFields } from "../profile-form-fields";
import { useFileViewer } from "../providers/FileViewerContext";

type Props = {
  profiles: Profile[];
  onProfilesChange: () => void;
  mode?: "closed" | "new" | "edit";
  initialProfile?: string | null;
  preloadedProfile?: Profile | null;
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
    modus.checkSecrets(vars).then((r) => {
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
    else if (field === "url") cfg.url = value;
    onChange({ ...servers, [name]: cfg });
  };

  /**
   * Args are edited one row per element.
   *
   * They used to be one comma-joined text field, which could not represent an arg containing a
   * comma or surrounding whitespace — and worse, was a lossy controlled input: typing the comma
   * that starts the next arg produced ["-u", ""], which `filter(Boolean)` dropped, so the
   * character was erased under the cursor. Typing a second argument was impossible. A row per
   * arg removes the delimiter instead of escaping it.
   */
  const setArgs = (name: string, args: string[]) => {
    onChange({ ...servers, [name]: { ...(servers[name] as any), args } });
  };

  const updateArg = (name: string, index: number, value: string) => {
    const args = [...(((servers[name] as any).args ?? []) as string[])];
    args[index] = value;
    setArgs(name, args);
  };

  const removeArg = (name: string, index: number) => {
    setArgs(name, (((servers[name] as any).args ?? []) as string[]).filter((_, i) => i !== index));
  };

  // Empty rather than a placeholder value: an arg nobody typed should not be sent.
  const addArg = (name: string) => {
    setArgs(name, [...(((servers[name] as any).args ?? []) as string[]), ""]);
  };

  const moveArg = (name: string, index: number, delta: number) => {
    const args = [...(((servers[name] as any).args ?? []) as string[])];
    const target = index + delta;
    if (target < 0 || target >= args.length) return;
    [args[index], args[target]] = [args[target], args[index]];
    setArgs(name, args);
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
                <div className="mcp-args-section">
                  <span className="mcp-args-label">args</span>
                  {(cfg.args ?? []).map((arg, i) => (
                    <div key={i} className="mcp-args-row">
                      <span className="mcp-args-index">{i}</span>
                      <input
                        className="mcp-args-val"
                        value={arg}
                        onChange={(e) => updateArg(name, i, e.target.value)}
                        placeholder="--port"
                        spellCheck={false}
                      />
                      <button
                        className="mcp-args-move"
                        onClick={() => moveArg(name, i, -1)}
                        disabled={i === 0}
                        title="Move up"
                        aria-label={`move argument ${i} earlier`}
                      >&uarr;</button>
                      <button
                        className="mcp-args-move"
                        onClick={() => moveArg(name, i, 1)}
                        disabled={i === (cfg.args ?? []).length - 1}
                        title="Move down"
                        aria-label={`move argument ${i} later`}
                      >&darr;</button>
                      <button
                        className="mcp-args-remove"
                        onClick={() => removeArg(name, i)}
                        title="Remove"
                        aria-label={`remove argument ${i}`}
                      >&times;</button>
                    </div>
                  ))}
                  <button className="mcp-args-add" onClick={() => addArg(name)}>+ arg</button>
                </div>
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
  profilePath,
}: {
  profile: Profile;
  onSave: (p: Omit<Profile, "name"> & { name?: string }) => Promise<void>;
  onDelete?: () => void;
  onCancel: () => void;
  isNew?: boolean;
  profilePath?: string;
}) {
  const { availableProviders, providerCapabilities } = useProfiles();
  const { openFile } = useFileViewer();
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  const [prompt, setPrompt] = useState(profile.prompt);
  const [promptMode, setPromptMode] = useState(profile.promptMode ?? "append");
  const [provider, setProvider] = useState(profile.provider ?? "");
  const [model, setModel] = useState(profile.model ?? "");
  const [effort, setEffort] = useState(profile.effort ?? "");
  const [maxTurns, setMaxTurns] = useState(profile.maxTurns?.toString() ?? "");
  const [toolStates, setToolStates] = useState<ToolStates>(() => {
    if (!Array.isArray(profile.tools)) return {};
    const s: ToolStates = {};
    for (const t of profile.tools) s[t] = "on";
    return s;
  });
  /**
   * Whether the profile pins its tool surface, kept separate from the grid selection.
   *
   * The grid alone cannot distinguish "inherit every tool" from "grant no tools" — both are zero
   * selections — so this form used to treat an empty grid as "all" and silently granted a
   * locked-down agent everything. An empty array is a real value the SDK documents as
   * "disable all built-in tools", so the two states need separate storage.
   */
  const [toolsPinned, setToolsPinned] = useState(Array.isArray(profile.tools));
  const [loadProjectSettings, setLoadProjectSettings] = useState(profile.loadProjectSettings ?? true);
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerConfig>>(
    profile.mcpServers ?? {},
  );
  const [mcpConfig, setMcpConfig] = useState(profile.mcpConfig ?? "");
  const [permissionPolicy, setPermissionPolicy] = useState(profile.permissionPolicy);
  /**
   * Fields this form has no input for, frozen at mount alongside the other initializers.
   *
   * Saving replaces the whole profile file, so these have to ride along or they are deleted —
   * see `profile-form-fields.ts`. Frozen rather than read at save time so a background profile
   * refresh cannot splice a different profile's fields into this edit.
   */
  const [passthrough] = useState(() => unmanagedProfileFields(profile));
  const [saving, setSaving] = useState(false);
  const [providerModels, setProviderModels] = useState<ProviderModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [saveError, setSaveError] = useState("");
  const previousProviderRef = useRef(provider);
  const providerOptions = provider && !availableProviders.includes(provider)
    ? [provider, ...availableProviders]
    : availableProviders;
  const selectedCapabilities = providerCapabilities[provider || "claude-code"];
  const supportedPromptModes = selectedCapabilities?.profilePrompt?.supportedModes ?? ["append", "custom"];
  const promptModeSupported = supportedPromptModes.includes(promptMode);
  const projectInstructionControl = selectedCapabilities?.projectInstructions?.control ?? "toggle";
  const displayedProjectSettings = projectInstructionControl === "always"
    ? true
    : projectInstructionControl === "none"
      ? false
      : loadProjectSettings;

  const enabledTools = Object.entries(toolStates).filter(([, s]) => s === "on").map(([t]) => t);
  const toolSummary = !toolsPinned
    ? "all"
    : enabledTools.length === 0
      ? "none — no built-in tools"
      : `${enabledTools.length} selected`;

  useEffect(() => {
    const providerChanged = previousProviderRef.current !== provider;
    previousProviderRef.current = provider;
    const p = provider || "claude-code";
    if (providerChanged) {
      setModel("");
      setProviderModels([]);
    }
    setModelsLoading(true);
    modus.getProviderModels(p).then((models) => {
      setProviderModels(models);
    }).catch(() => setProviderModels([])).finally(() => setModelsLoading(false));
    const previousFamily = providerToolFamily(
      profile.provider,
      profile.provider ? providerCapabilities[profile.provider] : undefined,
    );
    const nextFamily = providerToolFamily(
      provider,
      provider ? providerCapabilities[provider] : undefined,
    );
    if (previousFamily !== nextFamily) setToolStates({});
  }, [provider]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    try {
      const data: any = buildProfileSavePayload(passthrough, {
        description,
        prompt,
        promptMode,
        loadProjectSettings,
        provider,
        model,
        effort,
        maxTurns,
        tools: toolsPinned ? enabledTools : null,
        mcpServers,
        mcpConfig,
        permissionPolicy,
      });
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
              {providerOptions
                .filter((v) => v !== "claude-code")
                .map((v) => (
                  <option key={v} value={v}>
                    {providerDisplayLabel(v, providerCapabilities[v])}
                  </option>
                ))}
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
              allowCustom
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
              <option value="xhigh">xhigh</option>
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
              <option value="append" disabled={!supportedPromptModes.includes("append")}>append</option>
              <option value="custom" disabled={!supportedPromptModes.includes("custom")}>custom</option>
            </select>
          </label>
        </div>
        {selectedCapabilities?.profilePrompt && prompt.trim() && !promptModeSupported && (
          <span className="pf-capability-warning">{selectedCapabilities.profilePrompt.summary}</span>
        )}
        <label className="pf-check">
          <input
            type="checkbox"
            checked={displayedProjectSettings}
            disabled={projectInstructionControl !== "toggle"}
            onChange={(e) => setLoadProjectSettings(e.target.checked)}
          />
          <span>load project instructions</span>
        </label>
        {selectedCapabilities?.projectInstructions && (
          <span className="pf-capability-help">
            {selectedCapabilities.projectInstructions.sources}: {selectedCapabilities.projectInstructions.summary}
          </span>
        )}
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
        {selectedCapabilities?.profilePrompt && (
          <span className="pf-capability-help">{selectedCapabilities.profilePrompt.summary}</span>
        )}
      </div>

      {/* Tools */}
      <div className="pf-group">
        <span className="pf-group-label">permissions</span>
        <PermissionPolicyControl
          value={permissionPolicy}
          onChange={setPermissionPolicy}
          provider={provider || "claude-code"}
          builtInGroups={providerCapabilities[provider || "claude-code"]?.builtInToolGroups}
        />
      </div>

      {/* Tools */}
      <div className="pf-group">
        <div className="pf-group-head">
          <span className="pf-group-label">tools</span>
          <div className="pf-tools-mode">
            <button
              className={`pf-tools-mode-btn${!toolsPinned ? " pf-tools-mode-btn--on" : ""}`}
              onClick={() => setToolsPinned(false)}
              title="Inherit every built-in tool the provider offers"
            >all</button>
            <button
              className={`pf-tools-mode-btn${toolsPinned ? " pf-tools-mode-btn--on" : ""}`}
              onClick={() => setToolsPinned(true)}
              title="Pin an explicit tool surface — selecting none grants no built-in tools"
            >custom</button>
          </div>
          <span className={`pf-group-meta${toolsPinned && enabledTools.length === 0 ? " pf-group-meta--warn" : ""}`}>
            {toolSummary}
          </span>
        </div>
        <ToolGrid
          mode="baseline"
          states={toolStates}
          // Touching the grid is what "custom" means; the selection is kept when
          // switching back to "all" so the toggle is not destructive.
          onChange={(next) => { setToolStates(next); setToolsPinned(true); }}
          compact
          provider={provider}
          builtInGroups={providerCapabilities[provider]?.builtInToolGroups}
        />
      </div>

      {/* MCP */}
      <div className="pf-group">
        <span className="pf-group-label">mcp servers</span>
        <label className="pf-field">
          <span>config file</span>
          <input value={mcpConfig} onChange={(event) => setMcpConfig(event.target.value)} placeholder="./path/to/mcp.json" />
        </label>
        <McpServersEditor servers={mcpServers} onChange={setMcpServers} />
      </div>

      {/* Footer */}
      <div className="pf-footer">
        {saveError && <span className="pf-error">{saveError}</span>}
        <span className="pf-spacer" />
        {profilePath && (
          <>
            <button className="apc-action" onClick={() => openFile(profilePath, { source: "ui-event" })}>open file</button>
            <button className="apc-action" onClick={() => openFile(profilePath, { edit: true, source: "ui-event" })}>edit JSON</button>
          </>
        )}
        <button className="apc-action" onClick={onCancel}>cancel</button>
        {onDelete && (
          <button className="apc-action pf-btn-delete" onClick={onDelete}>delete</button>
        )}
        <button
          className="apc-action apc-action--primary"
          onClick={handleSave}
          disabled={saving || !description.trim()}
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
  preloadedProfile = null,
  onCancel,
}: Props) {
  const { activeUserProfile, activeUP, activeCwd, projectRoot, refreshProfiles, refreshUserProfiles } = useProfiles();
  const profileCwd = projectRoot ?? activeCwd;

  const isOpen = mode !== "closed";
  const isNew = mode === "new";
  const selected = preloadedProfile ?? profiles.find((p) => p.name === initialProfile) ?? null;
  const [profilePath, setProfilePath] = useState<string | undefined>(preloadedProfile?.path);

  useEffect(() => {
    if (isNew || !initialProfile) {
      setProfilePath(undefined);
      return;
    }
    let cancelled = false;
    void modus.getProfile(initialProfile, profileCwd).then((resolved) => {
      if (!cancelled) setProfilePath(resolved.path);
    }).catch(() => {
      if (!cancelled) setProfilePath(undefined);
    });
    return () => { cancelled = true; };
  }, [initialProfile, isNew, profileCwd]);

  const formProfile: Profile = isNew
    ? (selected ?? { name: "", description: "", prompt: "", tools: "all" as const })
    : (selected ?? { name: "", description: "", prompt: "", tools: "all" as const });

  const handleSave = async (data: Omit<Profile, "name"> & { name?: string }) => {
    const saveName = isNew ? (data.name ?? "untitled") : initialProfile!;
    const { name: _n, ...rest } = data as any;
    await modus.saveProfile(saveName, rest, profileCwd);
    if (isNew && activeUserProfile && activeUP?.agentProfiles) {
      const updated = [...activeUP.agentProfiles, saveName];
      await modus.patchUserProfile(activeUserProfile, { agentProfiles: updated });
    }
    await Promise.all([refreshProfiles(), refreshUserProfiles()]);
    onProfilesChange();
  };

  const handleDelete = async () => {
    if (!initialProfile) return;
    await modus.deleteProfile(initialProfile, profileCwd);
    await Promise.all([refreshProfiles(), refreshUserProfiles()]);
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
            key={isNew ? `new:${formProfile.name}` : selected!.name}
            profile={formProfile}
            onSave={handleSave}
            onDelete={!isNew && selected ? handleDelete : undefined}
            onCancel={() => onCancel?.()}
            isNew={isNew}
            profilePath={profilePath}
          />
        ) : (
          <div className="profile-empty">profile not found</div>
        )}
      </div>
    </div>
  );
}
