/**
 * SessionSetup — full session creation panel.
 *
 * Combines AgentConfig (model/provider/tools/effort/turns) with
 * creation-only path settings for the next session.
 */

import { useState, useEffect } from "react";
import { AgentConfig, type AgentConfigState } from "./AgentConfig";
import { useFolderChooser } from "../hooks/usePathChooser";
import { getRecentPaths, addRecentPath } from "../recentPaths";
import { modus } from "../modusClient";
import type { InitStatus } from "../../../sdk/index";

export type SessionSetupState = {
  /** Mutable agent config for seeding the next session */
  agent: AgentConfigState;
  cwd: string;
  /** Additional workspace roots passed alongside cwd */
  additionalDirectories: string[];
  loadProjectSettings: boolean;
  /** When true, new sessions use this setup. When false, they inherit from the active chat's Config Bar. */
  useManualSetup: boolean;
};

type Props = {
  config: SessionSetupState;
  profileTools: string[] | "all";
  availableProviders?: string[];
  profileProvider?: string;
  profileEffort?: string;
  profileMaxTurns?: number;
  profileModel?: string;
  onChange: (config: SessionSetupState) => void;
  /** Project paths from the active user profile — shown first in CWD dropdown */
  projectPaths?: string[];
  /** When false, hide recent paths — profile only sees its own project paths */
  showAllProjectPaths?: boolean;
  /** Callback to refresh profiles after init adds project-local profiles */
  onProjectInit?: () => void;
  /** Hide live-tunable agent config when sidebar should only seed session identity */
  showAgentConfig?: boolean;
  /** Hide creation-only project settings toggle when not needed */
  showLoadProjectSettings?: boolean;
};

export function SessionSetup({
  config,
  profileTools,
  availableProviders,
  profileProvider,
  profileEffort,
  profileMaxTurns,
  profileModel,
  onChange,
  projectPaths,
  showAllProjectPaths: _showAllProjectPaths,
  onProjectInit,
  showAgentConfig = true,
  showLoadProjectSettings = true,
}: Props) {
  void showLoadProjectSettings;
  const folder = useFolderChooser();
  const [initStatus, setInitStatus] = useState<InitStatus | null>(null);
  const [initLoading, setInitLoading] = useState(false);
  void initStatus;
  void initLoading;

  // Check .modus/ init status when CWD changes
  useEffect(() => {
    if (!config.cwd) { setInitStatus(null); return; }
    modus.getInitStatus(config.cwd).then(setInitStatus).catch(() => setInitStatus(null));
  }, [config.cwd]);

  const handleInit = async () => {
    if (!config.cwd) return;
    setInitLoading(true);
    try {
      await modus.initProject(config.cwd);
      const status = await modus.getInitStatus(config.cwd);
      setInitStatus(status);
      onProjectInit?.();
    } catch (e) {
      console.error("Init failed:", e);
    } finally {
      setInitLoading(false);
    }
  };
  void handleInit;

  const recentPaths = getRecentPaths();
  const projectPathSet = new Set(projectPaths ?? []);
  const filteredRecent = recentPaths.filter((p) => !projectPathSet.has(p));

  const update = (patch: Partial<SessionSetupState>) => {
    onChange({ ...config, ...patch });
  };

  const addExtraDir = () => {
    update({ additionalDirectories: [...config.additionalDirectories, config.cwd] });
  };

  const updateExtraDir = (idx: number, value: string) => {
    const next = [...config.additionalDirectories];
    next[idx] = value;
    update({ additionalDirectories: next });
  };

  const removeExtraDir = (idx: number) => {
    const next = config.additionalDirectories.filter((_, i) => i !== idx);
    update({ additionalDirectories: next });
    // An open picker is bound to a row index, and removing any row can shift the
    // one it would write to. Closing is cheaper than tracking the reindex.
    folder.close();
  };

  const browseCwd = () => folder.open({
    title: "Choose the working directory",
    initialPath: config.cwd || undefined,
    onSelect: (path) => { update({ cwd: path }); addRecentPath(path); },
  });

  const browseExtraDir = (idx: number) => folder.open({
    title: "Choose an additional workspace root",
    initialPath: config.additionalDirectories[idx] || config.cwd || undefined,
    onSelect: (path) => { updateExtraDir(idx, path); addRecentPath(path); },
  });

  const folderIcon = (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M1.5 3.5V11.5H12.5V5H7L5.5 3.5H1.5Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" fill="none"/>
    </svg>
  );

  return (
    <div className="session-setup">
      {/* CWD — dropdown of recent paths + browse + add-dir button */}
      <div className="cwd-field">
        <label className="agent-config-field">
          <span>cwd</span>
          <div className="cwd-row">
            <select
              className="cwd-select"
              value={config.cwd}
              onChange={(e) => {
                if (e.target.value === "__browse__") {
                  browseCwd();
                  // Reset select to current value so it doesn't stick on "browse..."
                  e.target.value = config.cwd;
                } else {
                  update({ cwd: e.target.value });
                }
              }}
            >
              {projectPaths && projectPaths.length > 0 &&
                projectPaths.map((p) => (
                  <option key={p} value={p}>{shortenPath(p)}</option>
                ))
              }
              {filteredRecent.length > 0 && (
                <optgroup label="recent">
                  {filteredRecent.map((p) => (
                    <option key={p} value={p}>{shortenPath(p)}</option>
                  ))}
                </optgroup>
              )}
              {/* Ensure current CWD is always selectable even if not in any list */}
              {config.cwd && !projectPathSet.has(config.cwd) && !recentPaths.includes(config.cwd) && (
                <option value={config.cwd}>{shortenPath(config.cwd)}</option>
              )}
              <option value="__browse__">browse...</option>
            </select>
            <button
              className="cwd-browse-btn"
              onClick={browseCwd}
              disabled={folder.busy}
              title="Browse folders"
            >
              {folderIcon}
            </button>
            <button
              className="cwd-add-btn"
              onClick={addExtraDir}
              title="Add workspace root"
            >
              +
            </button>
          </div>
        </label>

        {/* Extra directory rows */}
        {config.additionalDirectories.map((dir, idx) => (
          <div key={idx} className="extra-dir-row">
            <input
              className="extra-dir-input"
              value={dir}
              onChange={(e) => updateExtraDir(idx, e.target.value)}
              spellCheck={false}
              placeholder="/path/to/dir"
            />
            <button
              className="cwd-browse-btn"
              onClick={() => browseExtraDir(idx)}
              disabled={folder.busy}
              title="Browse folders"
            >
              {folderIcon}
            </button>
            <button
              className="extra-dir-remove-btn"
              onClick={() => removeExtraDir(idx)}
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}

        {/* In-app browser for cwd or an extra root — floats over content.
            Null when the OS dialog handled it; only one can be open at a time. */}
        {folder.inline}
      </div>

      {/* Agent config (tools + effort + turns) */}
      {showAgentConfig && (
        <AgentConfig
          config={config.agent}
          profileTools={profileTools}
          availableProviders={availableProviders}
          profileProvider={profileProvider}
          profileModel={profileModel}
          profileEffort={profileEffort}
          profileMaxTurns={profileMaxTurns}
          onChange={(agent) => update({ agent })}
          dropdownDirection="up"
          toolsCollapsible
        />
      )}
    </div>
  );
}

/** Shorten a path for display: ~/dev/infra/agent_dev_zone → ~/d/i/agent_dev_zone */
export function shortenPath(p: string): string {
  if (!p) return "";
  // Normalize to forward slashes for display
  const norm = p.replace(/\\/g, "/");
  // Detect home prefix: /home/user or C:/Users/user
  const homeMatch = norm.match(/^(\/home\/[^/]+|[A-Z]:\/Users\/[^/]+)/i);
  if (homeMatch) {
    const rest = norm.slice(homeMatch[0].length + 1);
    const parts = rest.split("/");
    if (parts.length <= 2) return "~/" + parts.join("/");
    const last2 = parts.slice(-2).join("/");
    const middle = parts.slice(0, -2).map((s) => s[0] ?? s).join("/");
    return `~/${middle}/${last2}`;
  }
  if (norm.length > 35) {
    const parts = norm.split("/").filter(Boolean);
    if (parts.length <= 2) return norm;
    const last2 = parts.slice(-2).join("/");
    return `.../` + last2;
  }
  return norm;
}

/** Default state for SessionSetup */
export function createDefaultSetupState(): SessionSetupState {
  return {
    agent: { toolStates: {}, model: "", provider: "", effort: "", maxTurns: "", providerControls: {} },
    cwd: "",
    additionalDirectories: [],
    loadProjectSettings: true,
    useManualSetup: true,
  };
}
