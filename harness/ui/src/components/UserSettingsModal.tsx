import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { modus } from "../modusClient";
import type { ProviderModel, UserProfile } from "../../../sdk/index";
import { useProfiles } from "../providers/ProfileContext";
import { SearchDropdown } from "./SearchDropdown";

type Props = {
  userProfile: UserProfile;
  onClose: () => void;
  onSave: (patch: Partial<UserProfile>) => Promise<void>;
};

type Tab = "profile" | "defaults" | "environment" | "project" | "security";

const EFFORT_OPTIONS = ["off", "low", "medium", "high", "max"] as const;

function providerSeedModel(provider: string): string {
  if (provider === "codex") return "gpt-5.1-codex";
  if (provider === "gemini-cli") return "auto-gemini-3";
  if (provider === "claude-code" || provider === "anthropic") return "claude-opus-4-6";
  return "";
}

export function UserSettingsModal({ userProfile, onClose, onSave }: Props) {
  const [tab, setTab] = useState<Tab>("profile");
  const { visibleProfiles, availableProviders } = useProfiles();

  const [displayName, setDisplayName] = useState(userProfile.displayName ?? "");
  const [defaultAgentProfile, setDefaultAgentProfile] = useState(userProfile.defaultAgentProfile ?? "");
  const [defaultProvider, setDefaultProvider] = useState(userProfile.provider ?? "");
  const [defaultModel, setDefaultModel] = useState(userProfile.model ?? "");
  const [defaultEffort, setDefaultEffort] = useState(userProfile.effort ?? "");
  const [computer, setComputer] = useState(userProfile.computer ?? "");
  const [editor, setEditor] = useState(userProfile.editor ?? "");
  const [providerModels, setProviderModels] = useState<ProviderModel[]>([]);

  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinSaving, setPinSaving] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSuccess, setPinSuccess] = useState(false);

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
  }, [userProfile]);

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
      const patch: Partial<UserProfile> = {};
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
      if (computer.trim() !== (userProfile.computer ?? ""))
        patch.computer = computer.trim() || undefined;
      if (editor !== (userProfile.editor ?? "")) {
        patch.editor = editor || undefined;
        if (editor) localStorage.setItem("mo:editor", editor);
        else localStorage.removeItem("mo:editor");
      }
      if (Object.keys(patch).length > 0) await onSave(patch);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleChangePin = async () => {
    setPinError(null);
    setPinSuccess(false);
    if (!oldPin) { setPinError("enter your current PIN"); return; }
    if (!newPin) { setPinError("enter a new PIN"); return; }
    if (newPin.length < 4) { setPinError("PIN must be at least 4 characters"); return; }
    if (newPin !== confirmPin) { setPinError("PINs do not match"); return; }
    setPinSaving(true);
    try {
      await modus.changePin(oldPin, newPin);
      setOldPin(""); setNewPin(""); setConfirmPin("");
      setPinSuccess(true);
    } catch (e) {
      setPinError(String(e).replace(/^Error: /, ""));
    } finally {
      setPinSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  const profile = userProfile as UserProfile & { name?: string };
  const isEditing = tab === "profile" || tab === "defaults" || tab === "environment";

  return createPortal(
    <div className="create-profile-backdrop" onKeyDown={handleKeyDown}>
      <div className="create-profile-modal us-modal">
        {/* Header */}
        <div className="create-profile-header">
          <span className="create-profile-title">settings</span>
          <button className="create-profile-close" onClick={onClose}>&times;</button>
        </div>

        {/* Tabs */}
        <div className="us-tabs">
          {(["profile", "defaults", "environment", "project", "security"] as Tab[]).map((t) => (
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
                    options={visibleProfiles.map((profile) => ({ value: profile.name }))}
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
                    options={availableProviders.map((provider) => ({ value: provider }))}
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

              {userProfile.projects?.length > 0 && (
                <div className="us-group">
                  <button className="us-group-header" onClick={() => toggleGroup("projects")}>
                    <span className="us-group-arrow">{openGroups.projects ? "▾" : "▸"}</span>
                    <span className="us-group-label">projects</span>
                    <span className="us-group-count">{userProfile.projects.length}</span>
                  </button>
                  <div className={`us-group-body${openGroups.projects ? " open" : ""}`}>
                    <div className="us-group-inner">
                      {userProfile.projects.map((p) => (
                        <div key={p} className="us-group-row us-group-row--mono">{p}</div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

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

          {/* Security tab */}
          {tab === "security" && (
            <div className="us-section">
              <div className="us-pin-group">
                <div className="us-pin-row">
                  <span className="us-row-label">current PIN</span>
                  <input
                    className="us-input"
                    type="password"
                    value={oldPin}
                    onChange={(e) => { setOldPin(e.target.value); setPinError(null); setPinSuccess(false); }}
                    placeholder="••••"
                    spellCheck={false}
                    autoFocus
                  />
                </div>
                <div className="us-pin-row">
                  <span className="us-row-label">new PIN</span>
                  <input
                    className="us-input"
                    type="password"
                    value={newPin}
                    onChange={(e) => { setNewPin(e.target.value); setPinError(null); setPinSuccess(false); }}
                    placeholder="••••"
                    spellCheck={false}
                  />
                </div>
                <div className="us-pin-row">
                  <span className="us-row-label">confirm</span>
                  <input
                    className="us-input"
                    type="password"
                    value={confirmPin}
                    onChange={(e) => { setConfirmPin(e.target.value); setPinError(null); setPinSuccess(false); }}
                    placeholder="••••"
                    spellCheck={false}
                  />
                </div>
              </div>
              <div className="us-pin-actions">
                {pinError && <span className="us-pin-feedback error">{pinError}</span>}
                {pinSuccess && <span className="us-pin-feedback success">PIN updated</span>}
                {!pinError && !pinSuccess && <span />}
                <button className="us-pin-btn" onClick={handleChangePin} disabled={pinSaving}>
                  {pinSaving ? "updating..." : "update PIN"}
                </button>
              </div>
            </div>
          )}

          {error && <div className="us-section"><span className="create-profile-error">{error}</span></div>}
        </div>

        {/* Footer — only show save on editable tabs */}
        <div className="create-profile-footer">
          <button className="create-profile-cancel" onClick={onClose}>cancel</button>
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
