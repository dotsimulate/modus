/**
 * AgentConfig — the "agent menu" for mutable session settings.
 *
 * Wraps ToolGrid + effort + maxTurns. These are the settings that
 * can (conceptually) change between turns in a session.
 *
 * Reusable in:
 * - SessionSetup (sidebar, at creation time)
 * - ChatInput popover (mid-session tool swaps)
 * - Any future drawer/modal
 */

import { useState } from "react";
import { ToolGrid } from "./ToolGrid";
import { toSdkToolConfig, type ToolStates } from "../tools";

export type AgentConfigState = {
  toolStates: ToolStates;
  effort: string;
  maxTurns: string;
};

type Props = {
  /** Current config state */
  config: AgentConfigState;
  /** Profile's tool baseline */
  profileTools: string[] | "all";
  /** Profile's default effort */
  profileEffort?: string;
  /** Profile's default maxTurns */
  profileMaxTurns?: number;
  /** Called on any change */
  onChange: (config: AgentConfigState) => void;
  /** Compact mode for popover use */
  compact?: boolean;
  /** Show/hide tools section (can collapse) */
  toolsCollapsible?: boolean;
};

export function AgentConfig({
  config,
  profileTools,
  profileEffort,
  profileMaxTurns,
  onChange,
  compact,
  toolsCollapsible,
}: Props) {
  const [toolsOpen, setToolsOpen] = useState(!toolsCollapsible);

  const update = (patch: Partial<AgentConfigState>) => {
    onChange({ ...config, ...patch });
  };

  return (
    <div className={`agent-config ${compact ? "agent-config--compact" : ""}`}>
      {/* Effort + Max Turns row */}
      <div className="agent-config-row">
        <label className="agent-config-field">
          <span>effort</span>
          <select
            value={config.effort}
            onChange={(e) => update({ effort: e.target.value })}
          >
            <option value="">{profileEffort ?? "default"}</option>
            {["low", "medium", "high", "max"]
              .filter((v) => v !== profileEffort)
              .map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
          </select>
        </label>
        <label className="agent-config-field">
          <span>turns</span>
          <input
            type="number"
            value={config.maxTurns}
            onChange={(e) => update({ maxTurns: e.target.value })}
            placeholder={profileMaxTurns ? String(profileMaxTurns) : "no limit"}
            min={1}
            max={100}
          />
        </label>
      </div>

      {/* Tools section */}
      {toolsCollapsible ? (
        <button
          className="agent-config-tools-toggle"
          onClick={() => setToolsOpen(!toolsOpen)}
        >
          <span>{toolsOpen ? "−" : "+"} tools</span>
        </button>
      ) : null}

      {toolsOpen && (
        <ToolGrid
          states={config.toolStates}
          profileTools={profileTools}
          onChange={(toolStates) => update({ toolStates })}
          compact={compact}
        />
      )}
    </div>
  );
}

/** Convert AgentConfigState to SDK-compatible overrides */
export function agentConfigToOverrides(
  config: AgentConfigState,
  profileTools: string[] | "all",
): { tools?: string[]; disallowedTools?: string[]; maxTurns?: number; effort?: string } {
  const toolConfig = toSdkToolConfig(config.toolStates, profileTools);
  return {
    ...toolConfig,
    ...(config.maxTurns.trim() ? { maxTurns: Number(config.maxTurns) } : {}),
    ...(config.effort.trim() ? { effort: config.effort } : {}),
  };
}
