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
import { toSdkToolConfig, mcpToolGroups, type ToolStates } from "../tools";

export type AgentConfigState = {
  toolStates: ToolStates;
  provider: string;
  effort: string;
  maxTurns: string;
};

type Props = {
  /** Current config state */
  config: AgentConfigState;
  /** Profile's tool baseline */
  profileTools: string[] | "all";
  /** Available providers from backend registry */
  availableProviders?: string[];
  /** Profile's default provider */
  profileProvider?: string;
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
  /** All tools reported by SDK init (for MCP tool discovery) */
  availableTools?: string[];
};

export function AgentConfig({
  config,
  profileTools,
  availableProviders,
  profileProvider,
  profileEffort,
  profileMaxTurns,
  onChange,
  compact,
  toolsCollapsible,
  availableTools,
}: Props) {
  const [toolsOpen, setToolsOpen] = useState(!toolsCollapsible);

  const update = (patch: Partial<AgentConfigState>) => {
    onChange({ ...config, ...patch });
  };

  return (
    <div className={`agent-config ${compact ? "agent-config--compact" : ""}`}>
      {/* Provider + Effort + Max Turns row */}
      <div className="agent-config-row">
        {availableProviders && availableProviders.length > 1 && (
          <label className="agent-config-field">
            <span>provider</span>
            <select
              value={config.provider}
              onChange={(e) => update({ provider: e.target.value })}
            >
              <option value="">{profileProvider ?? "claude-code"}</option>
              {availableProviders
                .filter((v) => v !== profileProvider)
                .map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
            </select>
          </label>
        )}
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

      <div className={`panel-collapse ${toolsOpen ? "panel-collapse--open" : ""}`}>
        <div className="panel-collapse-clip">
          <ToolGrid
            states={config.toolStates}
            profileTools={profileTools}
            onChange={(toolStates) => update({ toolStates })}
            compact={compact}
            extraGroups={mcpToolGroups(availableTools ?? [])}
            provider={config.provider || profileProvider}
          />
        </div>
      </div>
    </div>
  );
}

/** Convert AgentConfigState to SDK-compatible overrides */
export function agentConfigToOverrides(
  config: AgentConfigState,
  profileTools: string[] | "all",
): { provider?: string; tools?: string[]; disallowedTools?: string[]; maxTurns?: number; effort?: string } {
  const toolConfig = toSdkToolConfig(config.toolStates, profileTools);
  return {
    ...toolConfig,
    ...(config.provider.trim() ? { provider: config.provider } : {}),
    ...(config.maxTurns.trim() ? { maxTurns: Number(config.maxTurns) } : {}),
    ...(config.effort.trim() ? { effort: config.effort } : {}),
  };
}
