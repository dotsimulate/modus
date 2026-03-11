/**
 * SessionSetup — full session creation panel.
 *
 * Combines AgentConfig (model/provider/tools/effort/turns) with
 * creation-only path settings for the next session.
 */

import { useState, useEffect } from "react";
import { AgentConfig, type AgentConfigState } from "./AgentConfig";
import { FolderPicker } from "./FolderPicker";
import { getRecentPaths, addRecentPath } from "../recentPaths";
import { fetchInitStatus, initProject, type InitStatus } from "../api/projects";

export type SessionSetupState = {
  /** Mutable agent config for seeding the next session */
  agent: AgentConfigState;
  cwd: string;
  loadProjectSettings: boolean;
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
  const [browseOpen, setBrowseOpen] = useState(false);
  const [initStatus, setInitStatus] = useState<InitStatus | null>(null);
  const [initLoading, setInitLoading] = useState(false);

  // Check .modus/ init status when CWD changes
  useEffect(() => {
    if (!config.cwd) { setInitStatus(null); return; }
    fetchInitStatus(config.cwd).then(setInitStatus).catch(() => setInitStatus(null));
  }, [config.cwd]);

  const handleInit = async () => {
    if (!config.cwd) return;
    setInitLoading(true);
    try {
      await initProject(config.cwd);
      const status = await fetchInitStatus(config.cwd);
      setInitStatus(status);
      onProjectInit?.();
    } catch (e) {
      console.error("Init failed:", e);
    } finally {
      setInitLoading(false);
    }
  };

  const recentPaths = getRecentPaths();
  const projectPathSet = new Set(projectPaths ?? []);
  const filteredRecent = recentPaths.filter((p) => !projectPathSet.has(p));

  const update = (patch: Partial<SessionSetupState>) => {
    onChange({ ...config, ...patch });
  };

  return (
    <div className="session-setup">
      {/* CWD — dropdown of recent paths + browse button */}
      <div className="cwd-field">
        <label className="agent-config-field">
          <span>cwd</span>
          <div className="cwd-row">
            <select
              className="cwd-select"
              value={config.cwd}
              onChange={(e) => {
                if (e.target.value === "__browse__") {
                  setBrowseOpen(true);
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
              onClick={() => setBrowseOpen(true)}
              title="Browse folders"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1.5 3.5V11.5H12.5V5H7L5.5 3.5H1.5Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" fill="none"/>
              </svg>
            </button>
          </div>
        </label>

        {/* Folder picker — floats over content */}
        {browseOpen && (
          <FolderPicker
            initialPath={config.cwd || undefined}
            onSelect={(path) => {
              update({ cwd: path });
              addRecentPath(path);
              setBrowseOpen(false);
            }}
            onCancel={() => setBrowseOpen(false)}
          />
        )}
      </div>

      {/* .modus/ init status */}
      {config.cwd && initStatus && !initStatus.initialized && (
        <div className="modus-init-banner">
          <span>no .modus/ in this directory</span>
          <button
            className="modus-init-btn"
            onClick={handleInit}
            disabled={initLoading}
          >
            {initLoading ? "initializing..." : "initialize project"}
          </button>
        </div>
      )}
      {config.cwd && initStatus?.initialized && (
        <div className="modus-init-banner modus-init-ok">
          <span>project: {initStatus.meta?.name ?? initStatus.projectId}</span>
        </div>
      )}

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

      {/* Load CLAUDE.md */}
      {showLoadProjectSettings && (
        <label className="session-setup-check">
          <input
            type="checkbox"
            checked={config.loadProjectSettings}
            onChange={(e) => update({ loadProjectSettings: e.target.checked })}
          />
          <span>load CLAUDE.md</span>
        </label>
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
    loadProjectSettings: true,
  };
}
