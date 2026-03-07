/**
 * AgentConfig — the "agent menu" for mutable session settings.
 *
 * Wraps model/provider/tool config for both:
 * - sidebar session seeding
 * - active session config in the chat view
 */

import { useEffect, useState } from "react";
import { fetchProviderModels } from "../api";
import type { ProviderModel } from "../api";
import { SearchDropdown } from "./SearchDropdown";
import { ToolGrid } from "./ToolGrid";
import { getAllTools, isPiProvider, mcpToolGroups, toSdkToolConfig, type ToolStates } from "../tools";

export type AgentConfigState = {
  toolStates: ToolStates;
  model: string;
  provider: string;
  effort: string;
  maxTurns: string;
};

export type SessionConfigPatch = {
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  tools?: string[];
  disallowedTools?: string[];
  toolStates?: ToolStates;
};

type Props = {
  /** Current config state */
  config: AgentConfigState;
  /** Profile's tool baseline */
  profileTools: string[] | "all";
  /** Profile's default model */
  profileModel?: string;
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
  /** Search dropdown direction for provider/effort fields */
  dropdownDirection?: "up" | "down";
  /** Show/hide provider field */
  showProvider?: boolean;
  /** Show/hide tools section (can collapse) */
  toolsCollapsible?: boolean;
  /** All tools reported by SDK init (for MCP tool discovery) */
  availableTools?: string[];
};

export function AgentConfig({
  config,
  profileTools,
  profileModel,
  availableProviders,
  profileProvider,
  profileEffort,
  profileMaxTurns,
  onChange,
  compact,
  dropdownDirection = "down",
  showProvider = true,
  toolsCollapsible,
  availableTools,
}: Props) {
  const [toolsOpen, setToolsOpen] = useState(!toolsCollapsible);
  const [providerModels, setProviderModels] = useState<ProviderModel[]>([]);
  const dropdownClassName = dropdownDirection === "up"
    ? "search-dropdown--compact search-dropdown--up"
    : "search-dropdown--compact";
  const effectiveProvider = config.provider || profileProvider || "claude-code";

  useEffect(() => {
    fetchProviderModels(effectiveProvider).then(setProviderModels).catch(() => setProviderModels([]));
  }, [effectiveProvider]);

  const update = (patch: Partial<AgentConfigState>) => {
    onChange({ ...config, ...patch });
  };

  const updateProvider = (provider: string) => {
    const switchingToolFamilies = isPiProvider(config.provider || profileProvider) !== isPiProvider(provider || profileProvider);
    update({
      ...config,
      provider,
      model: "",
      ...(switchingToolFamilies ? { toolStates: {} } : {}),
    });
  };

  return (
    <div className={`agent-config ${compact ? "agent-config--compact" : ""}`}>
      {/* Model + Provider + Effort + Max Turns row */}
      <div className="agent-config-row">
        <label className="agent-config-field">
          <span>model</span>
          <SearchDropdown
            className={dropdownClassName}
            value={config.model}
            options={providerModels
              .filter((v) => v.id !== profileModel)
              .map((v) => ({ value: v.id }))}
            placeholder={profileModel ?? "default"}
            searchPlaceholder="search models..."
            onChange={(model) => update({ model })}
          />
        </label>
        {showProvider && availableProviders && availableProviders.length > 1 && (
          <label className="agent-config-field">
            <span>provider</span>
            <SearchDropdown
              className={dropdownClassName}
              value={config.provider}
              options={availableProviders
                .filter((v) => v !== profileProvider)
                .map((v) => ({ value: v }))}
              placeholder={profileProvider ?? "claude-code"}
              searchPlaceholder="search providers..."
              onChange={updateProvider}
            />
          </label>
        )}
        <label className="agent-config-field">
          <span>effort</span>
          <SearchDropdown
            className={dropdownClassName}
            value={config.effort}
            options={["low", "medium", "high", "max"]
              .filter((v) => v !== profileEffort)
              .map((v) => ({ value: v }))}
            placeholder={profileEffort ?? "default"}
            searchPlaceholder="search effort..."
            onChange={(effort) => update({ effort })}
          />
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
            provider={effectiveProvider}
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
): SessionConfigPatch {
  const toolConfig = toSdkToolConfig(config.toolStates, profileTools);
  return {
    ...toolConfig,
    ...(config.provider.trim() ? { provider: config.provider } : {}),
    ...(config.model.trim() ? { model: config.model } : {}),
    ...(config.maxTurns.trim() ? { maxTurns: Number(config.maxTurns) } : {}),
    ...(config.effort.trim() ? { effort: config.effort } : {}),
    toolStates: config.toolStates,
  };
}

/** Reconstruct UI override state from stored session config. */
export function sessionConfigToAgentConfig(
  config: SessionConfigPatch | undefined,
  profileTools: string[] | "all",
  provider?: string,
  availableTools?: string[],
): AgentConfigState {
  const effectiveProvider = config?.provider || provider;
  const knownTools = new Set([
    ...getAllTools(effectiveProvider),
    ...(availableTools ?? []),
    ...(profileTools === "all" ? [] : profileTools),
    ...(config?.tools ?? []),
    ...(config?.disallowedTools ?? []),
    ...Object.keys(config?.toolStates ?? {}),
  ]);
  const toolStates: ToolStates = {};

  if (config?.toolStates) {
    for (const [tool, state] of Object.entries(config.toolStates)) {
      if (state === "on" || state === "off") toolStates[tool] = state;
    }
  } else if (profileTools === "all") {
    for (const tool of config?.disallowedTools ?? []) {
      toolStates[tool] = "off";
    }
  } else if (config?.tools) {
    const effective = new Set(config.tools);
    for (const tool of knownTools) {
      const inProfile = profileTools.includes(tool);
      const inEffective = effective.has(tool);
      if (inEffective && !inProfile) toolStates[tool] = "on";
      if (!inEffective && inProfile) toolStates[tool] = "off";
    }
  }

  return {
    toolStates,
    provider: config?.provider ?? "",
    model: config?.model ?? "",
    effort: config?.effort ?? "",
    maxTurns: config?.maxTurns != null ? String(config.maxTurns) : "",
  };
}
