import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { modus } from "../modusClient";
import type { ModusPlugin, ProviderModel, UserInterfaceConfig, UserProfile, UserProfileUiConfig } from "../../../sdk/index";
import { providerFallbackModel } from "../../../provider-defaults";
import { useProfiles } from "../providers/ProfileContext";
import { SearchDropdown } from "./SearchDropdown";
import { profileOptions } from "../profile-options";
import { PluginSettingsPanel } from "./PluginSettingsPanel";
import { FolderPicker } from "./FolderPicker";
import { ProjectAppearanceSettings } from "./ProjectAppearanceSettings";
import {
  applyInterfaceSettings,
  DEFAULT_INTERFACE_SETTINGS,
  resetClientInterfaceState,
  resolveInterfaceSettings,
  type ResolvedInterfaceSettings,
} from "../interface-settings";
import { isTauriRuntime } from "../desktopBridge";
import AboutPanel from "./AboutPanel";
import { providerDisplayLabel } from "../tools";
import {
  checkForDesktopUpdate,
  getDesktopUpdateState,
  subscribeDesktopUpdateState,
} from "../desktop-update-service";
import {
  automaticUpdateChecksEnabled,
  setAutomaticUpdateChecksEnabled,
} from "../update-policy";

type Props = {
  userProfile: UserProfile;
  onClose: () => void;
  onSave: (patch: Partial<UserProfile> & Partial<UserProfileUiConfig>) => Promise<void>;
};

type Tab = "profile" | "defaults" | "interface" | "environment" | "project" | "plugins" | "security" | "about";

const EFFORT_OPTIONS = ["off", "low", "medium", "high", "xhigh", "max"] as const;

function providerSeedModel(provider: string): string {
  return providerFallbackModel(provider);
}

function InterfaceToggle({ label, value, onChange }: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="us-row">
      <span className="us-row-label">{label}</span>
      <button
        type="button"
        className={`us-switch${value ? " on" : ""}`}
        aria-pressed={value}
        onClick={() => onChange(!value)}
      >
        <span className="us-switch-track"><span /></span>
        <span className="us-switch-value">{value ? "on" : "off"}</span>
      </button>
    </div>
  );
}

export function UserSettingsModal({ userProfile, onClose, onSave }: Props) {
  const [tab, setTab] = useState<Tab>("profile");
  const {
    profiles,
    visibleProfiles,
    availableProviders,
    providerCapabilities,
    projectRoot,
    activeCwd,
  } = useProfiles();

  const [displayName, setDisplayName] = useState(userProfile.displayName ?? "");
  const [defaultAgentProfile, setDefaultAgentProfile] = useState(userProfile.defaultAgentProfile ?? "");
  const [defaultProvider, setDefaultProvider] = useState(userProfile.provider ?? "");
  const [defaultModel, setDefaultModel] = useState(userProfile.model ?? "");
  const [defaultEffort, setDefaultEffort] = useState(userProfile.effort ?? "");
  const [computer, setComputer] = useState(userProfile.computer ?? "");
  const [editor, setEditor] = useState(userProfile.editor ?? "");
  const [projectPaths, setProjectPaths] = useState<string[]>(userProfile.projects ?? []);
  const [hiddenPluginProfiles, setHiddenPluginProfiles] = useState<string[]>(userProfile.hiddenPluginProfiles ?? []);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [providerModels, setProviderModels] = useState<ProviderModel[]>([]);
  const [interfaceSettings, setInterfaceSettings] = useState<ResolvedInterfaceSettings>(
    () => resolveInterfaceSettings(userProfile.interface),
  );
  const [pageNavMode, setPageNavMode] = useState(userProfile.pageNav?.mode ?? "auto");
  const [resetLayout, setResetLayout] = useState(false);

  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinEnabled, setPinEnabled] = useState(false);
  const [canManagePin, setCanManagePin] = useState(false);
  const [pinStatusLoaded, setPinStatusLoaded] = useState(false);
  const [pinSaving, setPinSaving] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSuccess, setPinSuccess] = useState<string | null>(null);
  const [updateChecksEnabled, setUpdateChecksEnabled] = useState(automaticUpdateChecksEnabled);
  const [desktopUpdateState, setDesktopUpdateState] = useState(getDesktopUpdateState);
  const [plugins, setPlugins] = useState<ModusPlugin[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const providerRef = useRef(defaultProvider);
  const toggleGroup = (key: string) =>
    setOpenGroups((g) => ({ ...g, [key]: !g[key] }));

  useEffect(() => {
    setDisplayName(userProfile.displayName ?? "");
    setDefaultAgentProfile(userProfile.defaultAgentProfile ?? "");
    setDefaultProvider(userProfile.provider ?? "");
    setDefaultModel(userProfile.model ?? "");
    setDefaultEffort(userProfile.effort ?? "");
    setComputer(userProfile.computer ?? "");
    setEditor(userProfile.editor ?? "");
    setProjectPaths(userProfile.projects ?? []);
    setHiddenPluginProfiles(userProfile.hiddenPluginProfiles ?? []);
    const nextInterface = resolveInterfaceSettings(userProfile.interface);
    setInterfaceSettings(nextInterface);
    setPageNavMode(userProfile.pageNav?.mode ?? "auto");
    setResetLayout(false);
  }, [userProfile]);

  const updateInterfaceSettings = (next: ResolvedInterfaceSettings) => {
    setInterfaceSettings(next);
    applyInterfaceSettings(next);
  };

  useEffect(() => {
    providerRef.current = defaultProvider;
  }, [defaultProvider]);

  useEffect(() => {
    if (!defaultProvider) {
      setProviderModels([]);
      return;
    }
    modus.getProviderModels(defaultProvider).then(setProviderModels).catch(() => setProviderModels([]));
  }, [defaultProvider]);

  useEffect(() => {
    let alive = true;
    modus.authStatus()
      .then((status) => {
        if (!alive) return;
        setPinEnabled(!!status.pinEnabled || status.required);
        setCanManagePin(!!status.canManagePin);
      })
      .catch(() => {})
      .finally(() => { if (alive) setPinStatusLoaded(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => subscribeDesktopUpdateState(setDesktopUpdateState), []);

  useEffect(() => {
    if (tab !== "plugins") return;
    modus.listPlugins().then(setPlugins).catch(() => setPlugins([]));
  }, [tab]);

  const setUpdateChecks = (enabled: boolean) => {
    setAutomaticUpdateChecksEnabled(enabled);
    setUpdateChecksEnabled(enabled);
    if (enabled) void checkForDesktopUpdate();
  };

  const handleDefaultProviderChange = async (provider: string) => {
    setDefaultProvider(provider);
    if (!provider) {
      setDefaultModel("");
      return;
    }

    const seededModel = providerSeedModel(provider);
    setDefaultModel(seededModel);

    try {
      const models = await modus.getProviderModels(provider);
      const nextModel = models[0]?.id ?? seededModel;
      if (!nextModel || providerRef.current !== provider) return;
      setDefaultModel(nextModel);
    } catch {
      // Keep the lightweight fallback model if discovery fails.
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Partial<UserProfile> & Partial<UserProfileUiConfig> = {};
      if (displayName.trim() !== (userProfile.displayName ?? ""))
        patch.displayName = displayName.trim();
      if (defaultAgentProfile !== (userProfile.defaultAgentProfile ?? ""))
        patch.defaultAgentProfile = defaultAgentProfile || undefined;
      if (defaultProvider !== (userProfile.provider ?? ""))
        patch.provider = defaultProvider || undefined;
      if (defaultModel !== (userProfile.model ?? ""))
        patch.model = defaultModel || undefined;
      if (defaultEffort !== (userProfile.effort ?? ""))
        patch.effort = defaultEffort || undefined;
      if (JSON.stringify(hiddenPluginProfiles) !== JSON.stringify(userProfile.hiddenPluginProfiles ?? []))
        patch.hiddenPluginProfiles = hiddenPluginProfiles.length ? hiddenPluginProfiles : undefined;
      if (computer.trim() !== (userProfile.computer ?? ""))
        patch.computer = computer.trim() || undefined;
      if (editor !== (userProfile.editor ?? "")) {
        patch.editor = editor || undefined;
        if (editor) localStorage.setItem("mo:editor", editor);
        else localStorage.removeItem("mo:editor");
      }
      const normalizedProjects = Array.from(new Set(projectPaths.map((path) => path.trim()).filter(Boolean)));
      if (JSON.stringify(normalizedProjects) !== JSON.stringify(userProfile.projects ?? [])) {
        patch.projects = normalizedProjects;
      }
      if (JSON.stringify(interfaceSettings) !== JSON.stringify(resolveInterfaceSettings(userProfile.interface))) {
        patch.interface = interfaceSettings as UserInterfaceConfig;
      }
      if (pageNavMode !== (userProfile.pageNav?.mode ?? "auto") || resetLayout) {
        patch.pageNav = resetLayout
          ? { mode: pageNavMode, enabled: [], disabled: [], pinned: [], order: [], labels: {} }
          : { ...(userProfile.pageNav ?? {}), mode: pageNavMode };
      }
      if (resetLayout) {
        patch.layouts = {};
        patch.leftPanel = {};
      }
      if (Object.keys(patch).length > 0) await onSave(patch);
      if (resetLayout) resetClientInterfaceState();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleChangePin = async () => {
    setPinError(null);
    setPinSuccess(null);
    if (!newPin) { setPinError("enter a new PIN"); return; }
    if (newPin.length < 4) { setPinError("PIN must be at least 4 characters"); return; }
    if (newPin !== confirmPin) { setPinError("PINs do not match"); return; }
    setPinSaving(true);
    try {
      if (pinEnabled) {
        await modus.resetPin(newPin);
        setPinSuccess("PIN reset; remote browser sessions were revoked");
      } else {
        await modus.setupNewPin(newPin);
        setPinEnabled(true);
        setPinSuccess("PIN enabled");
      }
      setNewPin(""); setConfirmPin("");
      window.dispatchEvent(new Event("modus:auth-changed"));
    } catch (e) {
      setPinError(String(e).replace(/^Error: /, ""));
    } finally {
      setPinSaving(false);
    }
  };

  const handleDisablePin = async () => {
    setPinError(null);
    setPinSuccess(null);
    setPinSaving(true);
    try {
      await modus.disablePin();
      setNewPin(""); setConfirmPin("");
      setPinEnabled(false);
      setPinSuccess("PIN disabled");
      window.dispatchEvent(new Event("modus:auth-changed"));
    } catch (e) {
      setPinError(String(e).replace(/^Error: /, ""));
    } finally {
      setPinSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      applyInterfaceSettings(resolveInterfaceSettings(userProfile.interface));
      onClose();
    }
  };

  const profile = userProfile as UserProfile & { name?: string };
  // About is read-only, like security — neither tab has anything to save.
  const isEditing = tab !== "security" && tab !== "about";

  return createPortal(
    <div className="create-profile-backdrop" onKeyDown={handleKeyDown}>
      <div className="create-profile-modal us-modal">
        {/* Header */}
        <div className="create-profile-header">
          <span className="create-profile-title">settings</span>
          <button className="create-profile-close" onClick={() => { applyInterfaceSettings(resolveInterfaceSettings(userProfile.interface)); onClose(); }}>&times;</button>
        </div>

        {/* Tabs */}
        <div className="us-tabs">
          {(["profile", "defaults", "interface", "environment", "project", "plugins", "security", "about"] as Tab[]).map((t) => (
            <button
              key={t}
              className={`us-tab${tab === t ? " active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="us-body">

          {/* Profile tab */}
          {tab === "profile" && (
            <div className="us-section">
              <div className="us-row">
                <span className="us-row-label">display name</span>
                <input
                  className="us-input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="your name"
                  spellCheck={false}
                  autoFocus
                />
              </div>
              {profile.name && (
                <div className="us-row">
                  <span className="us-row-label">profile</span>
                  <span className="us-info-val">{profile.name}</span>
                </div>
              )}
            </div>
          )}

          {tab === "defaults" && (
            <div className="us-section">
              <div className="agent-config-row">
                <label className="agent-config-field">
                  <span>profile</span>
                  <SearchDropdown
                    className="search-dropdown--compact"
                    value={defaultAgentProfile}
                    options={profileOptions(visibleProfiles)}
                    placeholder="select profile"
                    searchPlaceholder="search profiles..."
                    onChange={setDefaultAgentProfile}
                  />
                </label>
                <label className="agent-config-field">
                  <span>provider</span>
                  <SearchDropdown
                    className="search-dropdown--compact"
                    value={defaultProvider}
                    options={availableProviders.map((provider) => ({
                      value: provider,
                      label: providerDisplayLabel(provider, providerCapabilities[provider]),
                    }))}
                    placeholder="claude-code"
                    searchPlaceholder="search providers..."
                    onChange={handleDefaultProviderChange}
                  />
                </label>
              </div>
              <div className="agent-config-row">
                <label className="agent-config-field">
                  <span>model</span>
                  <SearchDropdown
                    className="search-dropdown--compact"
                    value={defaultModel}
                    options={providerModels.map((model) => ({ value: model.id }))}
                    placeholder={defaultProvider ? "select model" : "choose provider first"}
                    searchPlaceholder="search models..."
                    disabled={!defaultProvider}
                    allowCustom
                    onChange={setDefaultModel}
                  />
                </label>
                <label className="agent-config-field">
                  <span>thinking</span>
                  <SearchDropdown
                    className="search-dropdown--compact"
                    value={defaultEffort}
                    options={EFFORT_OPTIONS.map((effort) => ({ value: effort }))}
                    placeholder="default"
                    searchPlaceholder="search thinking..."
                    onChange={setDefaultEffort}
                  />
                </label>
              </div>
              <div className="us-row-hint">applies when the selected agent profile does not override these values</div>
            </div>
          )}

          {tab === "interface" && (
            <div className="us-section us-section--interface">
              <div className="us-section-title">chat</div>
              <div className="us-row">
                <span className="us-row-label">text scale</span>
                <div className="us-range-control">
                  <input
                    type="range" min={75} max={175} step={5}
                    value={interfaceSettings.chat.fontScale}
                    onChange={(event) => updateInterfaceSettings({
                      ...interfaceSettings,
                      chat: { ...interfaceSettings.chat, fontScale: Number(event.target.value) },
                    })}
                  />
                  <span>{interfaceSettings.chat.fontScale}%</span>
                </div>
              </div>
              <div className="us-row">
                <span className="us-row-label">max width</span>
                <div className="us-range-control">
                  <input
                    type="range" min={500} max={1600} step={20}
                    value={interfaceSettings.chat.chatWidth}
                    onChange={(event) => updateInterfaceSettings({
                      ...interfaceSettings,
                      chat: { ...interfaceSettings.chat, chatWidth: Number(event.target.value) },
                    })}
                  />
                  <span>{interfaceSettings.chat.chatWidth}px</span>
                </div>
              </div>
              <InterfaceToggle
                label="scroll spine"
                value={interfaceSettings.chat.spineEnabled}
                onChange={(value) => updateInterfaceSettings({
                  ...interfaceSettings,
                  chat: { ...interfaceSettings.chat, spineEnabled: value },
                })}
              />

              <div className="us-section-title us-section-title--spaced">conversation</div>
              <InterfaceToggle
                label="thinking"
                value={interfaceSettings.conversation.showThinking}
                onChange={(value) => updateInterfaceSettings({
                  ...interfaceSettings,
                  conversation: { ...interfaceSettings.conversation, showThinking: value },
                })}
              />
              <InterfaceToggle
                label="metadata"
                value={interfaceSettings.conversation.showMeta}
                onChange={(value) => updateInterfaceSettings({
                  ...interfaceSettings,
                  conversation: { ...interfaceSettings.conversation, showMeta: value },
                })}
              />
              <div className="us-row">
                <span className="us-row-label">tool calls</span>
                <select
                  className="us-select"
                  value={interfaceSettings.conversation.toolCalls}
                  onChange={(event) => updateInterfaceSettings({
                    ...interfaceSettings,
                    conversation: {
                      ...interfaceSettings.conversation,
                      toolCalls: event.target.value as ResolvedInterfaceSettings["conversation"]["toolCalls"],
                    },
                  })}
                >
                  <option value="collapsed">collapsed</option>
                  <option value="expanded">expanded</option>
                  <option value="hidden">hidden</option>
                </select>
              </div>
              <InterfaceToggle
                label="file summaries"
                value={interfaceSettings.conversation.showFileChanges}
                onChange={(value) => updateInterfaceSettings({
                  ...interfaceSettings,
                  conversation: { ...interfaceSettings.conversation, showFileChanges: value },
                })}
              />
              <InterfaceToggle
                label="git events"
                value={interfaceSettings.conversation.showGitEvents}
                onChange={(value) => updateInterfaceSettings({
                  ...interfaceSettings,
                  conversation: { ...interfaceSettings.conversation, showGitEvents: value },
                })}
              />

              <div className="us-section-title us-section-title--spaced">workspace</div>
              <div className="us-row">
                <span className="us-row-label">navigation</span>
                <select className="us-select" value={pageNavMode} onChange={(event) => setPageNavMode(event.target.value as typeof pageNavMode)}>
                  <option value="auto">auto</option>
                  <option value="compact">compact</option>
                  <option value="tabs">tabs</option>
                  <option value="launcher">launcher</option>
                </select>
              </div>
              <div className="us-row">
                <span className="us-row-label">motion</span>
                <select
                  className="us-select"
                  value={interfaceSettings.motion}
                  onChange={(event) => updateInterfaceSettings({
                    ...interfaceSettings,
                    motion: event.target.value === "reduced" ? "reduced" : "system",
                  })}
                >
                  <option value="system">follow system</option>
                  <option value="reduced">reduce motion</option>
                </select>
              </div>
              <div className="us-reset-row">
                <button
                  type="button"
                  className={`us-reset-btn${resetLayout ? " pending" : ""}`}
                  onClick={() => {
                    updateInterfaceSettings(DEFAULT_INTERFACE_SETTINGS);
                    setPageNavMode("auto");
                    setResetLayout(true);
                  }}
                >
                  {resetLayout ? "defaults ready — save to apply" : "restore interface defaults"}
                </button>
              </div>
            </div>
          )}

          {/* Environment tab */}
          {tab === "environment" && (
            <div className="us-section">
              <div className="us-row">
                <span className="us-row-label">machine name</span>
                <input
                  className="us-input"
                  value={computer}
                  onChange={(e) => setComputer(e.target.value)}
                  placeholder="e.g. my-laptop"
                  spellCheck={false}
                  autoFocus
                />
              </div>
              <div className="us-row-hint">shown in the top-right status bar</div>
              <div className="us-row">
                <span className="us-row-label">editor</span>
                <select
                  className="us-select"
                  value={editor}
                  onChange={(e) => setEditor(e.target.value)}
                >
                  <option value="">auto-detect</option>
                  <option value="cursor">Cursor</option>
                  <option value="code">VS Code</option>
                  <option value="code-insiders">VS Code Insiders</option>
                  <option value="codium">VSCodium</option>
                  <option value="zed">Zed</option>
                </select>
              </div>
              <div className="us-row-hint">used when opening files from the UI</div>
            </div>
          )}

          {/* Project tab */}
          {tab === "project" && (
            <div className="us-section us-section--scroll">

              <ProjectAppearanceSettings cwd={projectRoot || activeCwd} />

              <div className="us-group">
                <div className="us-group-header us-group-header--static">
                  <span className="us-group-label">folders</span>
                  <span className="us-group-count">{projectPaths.length}</span>
                </div>
                <div className="create-profile-paths us-project-paths">
                  {projectPaths.map((path, index) => (
                    <div key={path} className="create-profile-path">
                      <span className="create-profile-path-text">
                        {index === 0 && <b className="us-project-primary">primary</b>}
                        {path}
                      </span>
                      {index > 0 && (
                        <button
                          className="create-profile-path-remove"
                          title="Make primary"
                          onClick={() => setProjectPaths((current) => [path, ...current.filter((item) => item !== path)])}
                        >↑</button>
                      )}
                      <button
                        className="create-profile-path-remove"
                        title="Remove folder"
                        disabled={projectPaths.length <= 1}
                        onClick={() => setProjectPaths((current) => current.filter((item) => item !== path))}
                      >×</button>
                    </div>
                  ))}
                  {showProjectPicker ? (
                    <div className="create-profile-folder-picker">
                      <FolderPicker
                        initialPath={projectPaths.at(-1)}
                        onSelect={(path) => {
                          setProjectPaths((current) => current.includes(path) ? current : [...current, path]);
                          setShowProjectPicker(false);
                        }}
                        onCancel={() => setShowProjectPicker(false)}
                      />
                    </div>
                  ) : (
                    <button className="create-profile-add-path" onClick={() => setShowProjectPicker(true)}>
                      + add folder
                    </button>
                  )}
                </div>
                <div className="us-row-hint">new sessions choose one primary CWD; other folders can be attached as additional roots</div>
              </div>

              {userProfile.agentProfiles && userProfile.agentProfiles.length > 0 && (
                <div className="us-group">
                  <button className="us-group-header" onClick={() => toggleGroup("agents")}>
                    <span className="us-group-arrow">{openGroups.agents ? "▾" : "▸"}</span>
                    <span className="us-group-label">agent profiles</span>
                    <span className="us-group-count">{userProfile.agentProfiles.length}</span>
                  </button>
                  <div className={`us-group-body${openGroups.agents ? " open" : ""}`}>
                    <div className="us-group-inner">
                      {userProfile.agentProfiles.map((a) => (
                        <div key={a} className="us-group-row us-group-row--mono">{a}</div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {userProfile.templateVars && Object.keys(userProfile.templateVars).length > 0 && (
                <div className="us-group">
                  <button className="us-group-header" onClick={() => toggleGroup("vars")}>
                    <span className="us-group-arrow">{openGroups.vars ? "▾" : "▸"}</span>
                    <span className="us-group-label">template vars</span>
                    <span className="us-group-count">{Object.keys(userProfile.templateVars).length}</span>
                  </button>
                  <div className={`us-group-body${openGroups.vars ? " open" : ""}`}>
                    <div className="us-group-inner">
                      {Object.entries(userProfile.templateVars).map(([k, v]) => (
                        <div key={k} className="us-group-kv">
                          <span className="us-group-kv-key">{k}</span>
                          <span className="us-group-kv-val">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {(userProfile.defaultAgentProfile || userProfile.provider || userProfile.model || userProfile.memoryFilter || userProfile.showAllProjectPaths != null) && (
                <div className="us-group">
                  <button className="us-group-header" onClick={() => toggleGroup("config")}>
                    <span className="us-group-arrow">{openGroups.config ? "▾" : "▸"}</span>
                    <span className="us-group-label">config</span>
                  </button>
                  <div className={`us-group-body${openGroups.config ? " open" : ""}`}>
                    <div className="us-group-inner">
                      {userProfile.defaultAgentProfile && (
                        <div className="us-group-kv">
                          <span className="us-group-kv-key">default profile</span>
                          <span className="us-group-kv-val">{userProfile.defaultAgentProfile}</span>
                        </div>
                      )}
                      {userProfile.provider && (
                        <div className="us-group-kv">
                          <span className="us-group-kv-key">provider</span>
                          <span className="us-group-kv-val">{userProfile.provider}</span>
                        </div>
                      )}
                      {userProfile.model && (
                        <div className="us-group-kv">
                          <span className="us-group-kv-key">model</span>
                          <span className="us-group-kv-val">{userProfile.model}</span>
                        </div>
                      )}
                      {userProfile.memoryFilter && (
                        <div className="us-group-kv">
                          <span className="us-group-kv-key">memory filter</span>
                          <span className="us-group-kv-val">{userProfile.memoryFilter}</span>
                        </div>
                      )}
                      {userProfile.showAllProjectPaths != null && (
                        <div className="us-group-kv">
                          <span className="us-group-kv-key">all paths</span>
                          <span className="us-group-kv-val">{userProfile.showAllProjectPaths ? "yes" : "no"}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {!userProfile.projects?.length && !userProfile.agentProfiles?.length &&
               !userProfile.templateVars && !userProfile.provider && !userProfile.model &&
               !userProfile.defaultAgentProfile && (
                <div className="us-empty">no project data</div>
              )}
            </div>
          )}

          {tab === "plugins" && (
            <div className="us-section us-section--scroll">
              {plugins.length === 0 && <div className="us-empty">no plugins available</div>}
              {plugins.map((plugin) => (
                <details className="us-group" key={plugin.id}>
                  <summary className="us-group-header">
                    <span className="us-group-label">{plugin.name ?? plugin.id}</span>
                    <span className="us-group-count">{plugin.builtin ? "built in" : plugin.enabled ? "on" : "off"}</span>
                  </summary>
                  <div className="us-group-inner">
                    {plugin.description && <div className="us-row-hint">{plugin.description}</div>}
                    <div className="us-group-row us-group-row--mono">{plugin.path}</div>
                    {plugin.about && <pre className="exw-plugin-about">{plugin.about}</pre>}
                    {profiles.filter((candidate) => candidate.pluginId === plugin.id).map((candidate) => (
                      <label className="exw-setting exw-setting--toggle" key={candidate.name}>
                        <span className="exw-setting-label">
                          show {candidate.displayName ?? candidate.name} in profile pickers
                        </span>
                        <input
                          type="checkbox"
                          checked={!hiddenPluginProfiles.includes(candidate.name)}
                          onChange={(event) => setHiddenPluginProfiles((current) => event.target.checked
                            ? current.filter((key) => key !== candidate.name)
                            : [...new Set([...current, candidate.name])])}
                        />
                      </label>
                    ))}
                    {plugin.manifest.settings?.length
                      ? <PluginSettingsPanel plugin={plugin} cwd={projectRoot || activeCwd} userProfile={profile.name} />
                      : <div className="us-empty">no settings declared</div>}
                  </div>
                </details>
              ))}
            </div>
          )}

          {/* Security tab */}
          {tab === "about" && (
            <div className="us-section">
              <AboutPanel />
            </div>
          )}

          {tab === "security" && (
            <div className="us-section">
              {pinStatusLoaded && (
                <div className="us-security-status">
                  Browser PIN is {pinEnabled ? "enabled" : "off"}. It gates Modus browser access, not the operating system.
                </div>
              )}
              {!canManagePin && (
                <div className="us-security-status">
                  PIN setup, reset, and removal are available only in the native app on the Modus host.
                </div>
              )}
              {canManagePin && <div className="us-pin-group">
                <div className="us-pin-row">
                  <span className="us-row-label">{pinEnabled ? "new PIN" : "PIN"}</span>
                  <input
                    className="us-input"
                    type="password"
                    value={newPin}
                    onChange={(e) => { setNewPin(e.target.value); setPinError(null); setPinSuccess(null); }}
                    placeholder="4+ characters"
                    spellCheck={false}
                    autoFocus
                  />
                </div>
                <div className="us-pin-row">
                  <span className="us-row-label">confirm</span>
                  <input
                    className="us-input"
                    type="password"
                    value={confirmPin}
                    onChange={(e) => { setConfirmPin(e.target.value); setPinError(null); setPinSuccess(null); }}
                    placeholder="repeat PIN"
                    spellCheck={false}
                  />
                </div>
              </div>}
              {canManagePin && <div className="us-pin-actions">
                {pinError && <span className="us-pin-feedback error">{pinError}</span>}
                {pinSuccess && <span className="us-pin-feedback success">{pinSuccess}</span>}
                {!pinError && !pinSuccess && <span />}
                <button className="us-pin-btn" onClick={handleChangePin} disabled={pinSaving}>
                  {pinSaving ? "updating..." : pinEnabled ? "reset PIN and revoke browsers" : "enable PIN"}
                </button>
                {pinEnabled && (
                  <button className="us-pin-btn us-pin-btn--danger" onClick={handleDisablePin} disabled={pinSaving}>
                    disable PIN
                  </button>
                )}
              </div>}
              {isTauriRuntime() && (
                <div className="us-pin-group">
                  <InterfaceToggle
                    label="check for signed updates"
                    value={updateChecksEnabled}
                    onChange={setUpdateChecks}
                  />
                  <div className="us-security-status">
                    Checks are opt-in. Modus never downloads or installs an update until you explicitly confirm it.
                  </div>
                  <div className="us-pin-actions">
                    <span className={desktopUpdateState.status === "error" ? "us-pin-feedback error" : "us-pin-feedback"}>
                      {desktopUpdateState.status === "checking" && "checking…"}
                      {desktopUpdateState.status === "available" && `version ${desktopUpdateState.update?.version} available`}
                      {desktopUpdateState.status === "idle" && desktopUpdateState.update && "Modus is up to date"}
                      {desktopUpdateState.status === "unavailable" && desktopUpdateState.error}
                      {desktopUpdateState.status === "error" && desktopUpdateState.error}
                    </span>
                    <button className="us-pin-btn" type="button" onClick={() => void checkForDesktopUpdate()} disabled={desktopUpdateState.status === "checking" || desktopUpdateState.status === "installing"}>
                      Check now
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {error && <div className="us-section"><span className="create-profile-error">{error}</span></div>}
        </div>

        {/* Footer — only show save on editable tabs */}
        <div className="create-profile-footer">
          <button className="create-profile-cancel" onClick={() => { applyInterfaceSettings(resolveInterfaceSettings(userProfile.interface)); onClose(); }}>cancel</button>
          {isEditing && (
            <button className="create-profile-save" onClick={handleSave} disabled={saving}>
              {saving ? "saving..." : "save"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
