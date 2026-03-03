/**
 * SessionSetup — full session creation panel.
 *
 * Combines AgentConfig (mutable settings) with creation-only fields:
 * model, cwd, loadProjectSettings. Replaces the old SessionConfig.
 *
 * Lives in the sidebar below the profile selector.
 */

import { useState } from "react";
import { AgentConfig, type AgentConfigState } from "./AgentConfig";
import { FolderPicker } from "./FolderPicker";
import { getRecentPaths, addRecentPath } from "../recentPaths";

export type SessionSetupState = {
  /** Mutable agent config (tools, effort, turns) */
  agent: AgentConfigState;
  /** Creation-only fields */
  model: string;
  cwd: string;
  loadProjectSettings: boolean;
};

type Props = {
  config: SessionSetupState;
  profileTools: string[] | "all";
  profileEffort?: string;
  profileMaxTurns?: number;
  profileModel?: string;
  onChange: (config: SessionSetupState) => void;
};

const MODELS = [
  { value: "", label: "profile default" },
  { value: "claude-opus-4-6", label: "opus" },
  { value: "claude-sonnet-4-6", label: "sonnet" },
  { value: "claude-haiku-4-5", label: "haiku" },
];

export function SessionSetup({
  config,
  profileTools,
  profileEffort,
  profileMaxTurns,
  profileModel,
  onChange,
}: Props) {
  const [browseOpen, setBrowseOpen] = useState(false);
  const recentPaths = getRecentPaths();

  const update = (patch: Partial<SessionSetupState>) => {
    onChange({ ...config, ...patch });
  };

  const modelLabel = profileModel
    ? MODELS.find((m) => m.value === profileModel)?.label ?? profileModel
    : "default";

  return (
    <div className="session-setup">
      {/* Model selector */}
      <div className="session-setup-row">
        <label className="agent-config-field">
          <span>model</span>
          <select
            value={config.model}
            onChange={(e) => update({ model: e.target.value })}
          >
            <option value="">{modelLabel}</option>
            {MODELS.filter((m) => m.value && m.value !== profileModel).map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
      </div>

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
              <option value="">server default</option>
              {recentPaths.map((p) => (
                <option key={p} value={p}>{shortenPath(p)}</option>
              ))}
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

      {/* Agent config (tools + effort + turns) */}
      <AgentConfig
        config={config.agent}
        profileTools={profileTools}
        profileEffort={profileEffort}
        profileMaxTurns={profileMaxTurns}
        onChange={(agent) => update({ agent })}
        toolsCollapsible
      />

      {/* Load CLAUDE.md */}
      <label className="session-setup-check">
        <input
          type="checkbox"
          checked={config.loadProjectSettings}
          onChange={(e) => update({ loadProjectSettings: e.target.checked })}
        />
        <span>load CLAUDE.md</span>
      </label>
    </div>
  );
}

/** Shorten a path for display: ~/dev/infra/agent_dev_zone → ~/d/i/agent_dev_zone */
function shortenPath(p: string): string {
  const home = "/home/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const parts = rest.split("/");
    if (parts.length <= 2) return "~/" + parts.join("/");
    const last2 = parts.slice(-2).join("/");
    const middle = parts.slice(1, -2).map((s) => s[0] ?? s).join("/");
    return `~/${middle}/${last2}`;
  }
  if (p.length > 35) {
    const parts = p.split("/").filter(Boolean);
    if (parts.length <= 2) return p;
    const last2 = parts.slice(-2).join("/");
    return `/.../${last2}`;
  }
  return p;
}

/** Default state for SessionSetup */
export function createDefaultSetupState(): SessionSetupState {
  return {
    agent: { toolStates: {}, effort: "", maxTurns: "" },
    model: "",
    cwd: "",
    loadProjectSettings: true,
  };
}
